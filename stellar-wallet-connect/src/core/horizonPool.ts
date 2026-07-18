/**
 * Horizon connection pool & load balancer (#rate-limits)
 *
 * Under load a single Horizon endpoint trips rate limits (HTTP 429). This pool
 * spreads on-chain read traffic across several public/private Horizon nodes,
 * continuously measures their latency, routes each request to the healthiest
 * node, and retries rate-limited / failed requests with exponential backoff
 * (honouring `Retry-After` when present).
 *
 * It is transport-agnostic: pass any `fetch` implementation (defaults to the
 * global `fetch`), so it is fully unit-testable without the network.
 */

import {
  STELLAR_NETWORKS,
  EXPECTED_NETWORK,
  normalizeStellarNetwork,
  type NetworkType,
} from "../lib/wallets";
import { getFrontendEnv } from "./env";

export type HorizonNodeKind = "public" | "private";

export interface HorizonNode {
  url: string;
  kind: HorizonNodeKind;
}

export interface NodeHealth {
  url: string;
  kind: HorizonNodeKind;
  healthy: boolean;
  /** Smoothed round-trip latency in ms; `Infinity` until first successful ping. */
  latencyMs: number;
  consecutiveFailures: number;
  lastCheckedAt: number;
  /** Epoch ms before which the node is considered rate-limited and skipped. */
  cooldownUntil: number;
}

export interface HorizonPoolOptions {
  nodes: HorizonNode[];
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Max attempts across the pool before giving up. */
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Failures before a node is marked unhealthy. */
  unhealthyThreshold?: number;
  /** Monotonic clock + delay hooks, injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  timeoutMs: 8000,
  maxRetries: 4,
  baseBackoffMs: 200,
  maxBackoffMs: 5000,
  unhealthyThreshold: 3
};

function dedupeNodes(nodes: HorizonNode[]): HorizonNode[] {
  const seen = new Set<string>();
  const out: HorizonNode[] = [];
  for (const node of nodes) {
    const url = node.url.replace(/\/+$/, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: node.kind });
  }
  return out;
}

export class HorizonPool {
  private readonly fetchImpl: typeof fetch;
  private readonly opts: Required<Omit<HorizonPoolOptions, "nodes" | "fetchImpl">>;
  private readonly health: Map<string, NodeHealth> = new Map();

  constructor(options: HorizonPoolOptions) {
    const nodes = dedupeNodes(options.nodes);
    if (nodes.length === 0) {
      throw new Error("HorizonPool requires at least one node");
    }

    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.opts = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      unhealthyThreshold: options.unhealthyThreshold ?? DEFAULTS.unhealthyThreshold,
      now: options.now ?? (() => Date.now()),
      sleep:
        options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    };

    for (const node of nodes) {
      this.health.set(node.url, {
        url: node.url,
        kind: node.kind,
        healthy: true,
        latencyMs: Infinity,
        consecutiveFailures: 0,
        lastCheckedAt: 0,
        cooldownUntil: 0
      });
    }
  }

  /** Snapshot of current node health, sorted by latency (best first). */
  getHealth(): NodeHealth[] {
    return [...this.health.values()].sort((a, b) => {
      const delta = this.score(a) - this.score(b);
      return Number.isNaN(delta) ? 0 : delta;
    });
  }

  /** Lower score = preferred. Unhealthy / cooling-down nodes sort last. */
  private score(h: NodeHealth): number {
    const now = this.opts.now();
    if (now < h.cooldownUntil) return Number.MAX_SAFE_INTEGER;
    if (!h.healthy) return Number.MAX_SAFE_INTEGER - 1;
    return Number.isFinite(h.latencyMs) ? h.latencyMs : Number.MAX_SAFE_INTEGER / 2;
  }

  /**
   * Pings every node (`GET <url><path>`), updating latency/health. Returns the
   * refreshed health snapshot. Routing favours the lowest-latency node.
   */
  async pingAll(path = "/"): Promise<NodeHealth[]> {
    for (const url of this.health.keys()) {
      await this.pingNode(url, path);
    }
    return this.getHealth();
  }

  private async pingNode(url: string, path: string): Promise<void> {
    const h = this.health.get(url);
    if (!h) return;
    const start = this.opts.now();
    try {
      const res = await this.timedFetch(`${url}${path}`, { method: "GET" });
      const elapsed = this.opts.now() - start;
      if (res.ok || res.status === 404) {
        this.markSuccess(h, elapsed);
      } else if (res.status === 429) {
        this.markRateLimited(h, this.retryAfterMs(res));
      } else {
        this.markFailure(h);
      }
    } catch {
      this.markFailure(h);
    } finally {
      h.lastCheckedAt = this.opts.now();
    }
  }

  /**
   * Performs a Horizon request through the pool. Tries the healthiest node
   * first and, on 429 or transport failure, backs off exponentially and
   * reroutes to the next healthiest node. Throws after `maxRetries`.
   */
  async request(path: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.opts.maxRetries; attempt++) {
      const node = this.pickNode();
      if (!node) {
        // Everything is cooling down; wait out the soonest cooldown.
        await this.opts.sleep(this.backoff(attempt));
        continue;
      }

      const h = this.health.get(node.url)!;
      const start = this.opts.now();
      try {
        const res = await this.timedFetch(`${node.url}${path}`, init);
        const elapsed = this.opts.now() - start;

        if (res.status === 429) {
          this.markRateLimited(h, this.retryAfterMs(res));
          await this.opts.sleep(this.retryAfterMs(res) ?? this.backoff(attempt));
          continue;
        }

        if (res.status >= 500) {
          this.markFailure(h);
          await this.opts.sleep(this.backoff(attempt));
          continue;
        }

        this.markSuccess(h, elapsed);
        return res;
      } catch (err) {
        lastError = err;
        this.markFailure(h);
        await this.opts.sleep(this.backoff(attempt));
      }
    }

    throw new Error(
      `HorizonPool: request to ${path} failed after ${this.opts.maxRetries} attempts` +
        (lastError instanceof Error ? `: ${lastError.message}` : "")
    );
  }

  /** Convenience JSON helper. */
  async getJson<T = unknown>(path: string): Promise<T> {
    const res = await this.request(path, { headers: { Accept: "application/json" } });
    return (await res.json()) as T;
  }

  /** Currently preferred node, or null if all nodes are cooling down. */
  pickNode(): HorizonNode | null {
    const candidate = this.getHealth().find((node) => {
      const health = this.health.get(node.url);
      return Boolean(health && health.healthy && this.opts.now() >= health.cooldownUntil);
    });

    if (!candidate) {
      return null;
    }

    return { url: candidate.url, kind: candidate.kind };
  }

  private async timedFetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private backoff(attempt: number): number {
    const exp = Math.min(
      this.opts.baseBackoffMs * 2 ** attempt,
      this.opts.maxBackoffMs
    );
    // Full jitter to avoid synchronised retries (thundering herd).
    return Math.floor(exp / 2 + (exp / 2) * pseudoJitter(attempt));
  }

  private retryAfterMs(res: Response): number | undefined {
    const header = res.headers.get("Retry-After");
    if (!header) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }

  private markSuccess(h: NodeHealth, latencyMs: number): void {
    // Exponential moving average smooths transient spikes.
    h.latencyMs = h.latencyMs === Infinity ? latencyMs : h.latencyMs * 0.7 + latencyMs * 0.3;
    h.healthy = true;
    h.consecutiveFailures = 0;
    h.cooldownUntil = 0;
  }

  private markFailure(h: NodeHealth): void {
    h.consecutiveFailures += 1;
    if (h.consecutiveFailures >= this.opts.unhealthyThreshold) {
      h.healthy = false;
    }
  }

  private markRateLimited(h: NodeHealth, retryAfterMs?: number): void {
    const cooldown = retryAfterMs ?? this.opts.baseBackoffMs * 4;
    h.cooldownUntil = this.opts.now() + cooldown;
  }
}

/** Deterministic-ish jitter in [0,1) without Math.random (test-friendly). */
function pseudoJitter(seed: number): number {
  const x = Math.sin((seed + 1) * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Resolves the list of Horizon endpoints the connection pool should balance
 * across (#rate-limits). Sources, in order of preference:
 *  1. `NEXT_PUBLIC_HORIZON_PRIVATE_URLS` — comma-separated private/paid nodes.
 *  2. `NEXT_PUBLIC_HORIZON_URLS` — comma-separated extra public mirrors.
 *  3. `NEXT_PUBLIC_HORIZON_URL` — the primary configured endpoint.
 *  4. The network's default public Horizon endpoint.
 *
 * Private nodes are marked so the pool can prefer them and reserve public
 * nodes as failover capacity. Duplicates are removed by the pool itself.
 */
export function resolveHorizonNodes(
  source: Record<string, string | undefined> = (typeof process !== "undefined"
    ? process.env
    : {}) as Record<string, string | undefined>
): HorizonNode[] {
  const split = (value?: string): string[] =>
    (value ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  let network: NetworkType = EXPECTED_NETWORK;
  try {
    const env = getFrontendEnv(source);
    network =
      normalizeStellarNetwork(env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE) ??
      EXPECTED_NETWORK;
  } catch {
    // Fall back to the expected network when env is not fully configured.
  }

  const nodes: HorizonNode[] = [];
  for (const url of split(source.NEXT_PUBLIC_HORIZON_PRIVATE_URLS)) {
    nodes.push({ url, kind: "private" });
  }
  for (const url of split(source.NEXT_PUBLIC_HORIZON_URLS)) {
    nodes.push({ url, kind: "public" });
  }
  const primary = source.NEXT_PUBLIC_HORIZON_URL || source.PUBLIC_HORIZON_URL;
  if (primary) nodes.push({ url: primary, kind: "public" });

  nodes.push({ url: STELLAR_NETWORKS[network].horizonUrl, kind: "public" });

  return nodes;
}
