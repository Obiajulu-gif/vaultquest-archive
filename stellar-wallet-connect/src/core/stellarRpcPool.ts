import {
  STELLAR_NETWORKS,
  EXPECTED_NETWORK,
  normalizeStellarNetwork,
  type NetworkType,
} from "../lib/wallets.js";
import { getFrontendEnv } from "./env.js";

export type RpcNodeKind = "primary" | "fallback";

export interface RpcNode {
  url: string;
  kind?: RpcNodeKind;
}

export interface RpcNodeHealth {
  url: string;
  kind: RpcNodeKind;
  healthy: boolean;
  latencyMs: number;
  consecutiveFailures: number;
  lastCheckedAt: number;
  cooldownUntil: number;
}

export interface StellarRpcPoolOptions {
  nodes: RpcNode[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  unhealthyThreshold?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DiagnosticSummary {
  activeEndpoint: string | null;
  totalNodes: number;
  healthyNodes: number;
  nodes: RpcNodeHealth[];
}

const DEFAULTS = {
  timeoutMs: 8000,
  maxRetries: 3,
  baseBackoffMs: 200,
  maxBackoffMs: 5000,
  unhealthyThreshold: 3,
};

function dedupeNodes(nodes: RpcNode[]): Array<{ url: string; kind: RpcNodeKind }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; kind: RpcNodeKind }> = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;
    const url = node.url.trim().replace(/\/+$/, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const kind: RpcNodeKind = node.kind || (i === 0 ? "primary" : "fallback");
    out.push({ url, kind });
  }
  return out;
}

export class StellarRpcPool {
  private readonly fetchImpl: typeof fetch;
  private readonly opts: Required<Omit<StellarRpcPoolOptions, "nodes" | "fetchImpl">>;
  private readonly health: Map<string, RpcNodeHealth> = new Map();

  constructor(options: StellarRpcPoolOptions) {
    const nodes = dedupeNodes(options.nodes);
    if (nodes.length === 0) {
      throw new Error("StellarRpcPool requires at least one node");
    }

    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.opts = {
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      baseBackoffMs: options.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      unhealthyThreshold: options.unhealthyThreshold ?? DEFAULTS.unhealthyThreshold,
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };

    for (const node of nodes) {
      this.health.set(node.url, {
        url: node.url,
        kind: node.kind,
        healthy: true,
        latencyMs: Infinity,
        consecutiveFailures: 0,
        lastCheckedAt: 0,
        cooldownUntil: 0,
      });
    }
  }

  getHealth(): RpcNodeHealth[] {
    return [...this.health.values()].sort((a, b) => {
      const delta = this.score(a) - this.score(b);
      return Number.isNaN(delta) ? 0 : delta;
    });
  }

  getActiveEndpoint(): string | null {
    const node = this.pickNode();
    return node ? node.url : null;
  }

  getDiagnostics(): DiagnosticSummary {
    const healthList = this.getHealth();
    const healthyCount = healthList.filter((n) => n.healthy).length;
    return {
      activeEndpoint: this.getActiveEndpoint(),
      totalNodes: healthList.length,
      healthyNodes: healthyCount,
      nodes: healthList,
    };
  }

  async pingAll(path = "/"): Promise<RpcNodeHealth[]> {
    for (const url of this.health.keys()) {
      await this.pingNode(url, path);
    }
    return this.getHealth();
  }

  /**
   * Execute safe read operation with failover retry across backup nodes.
   */
  async readContract(path: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;
    const triedUrls = new Set<string>();

    for (let attempt = 0; attempt < this.opts.maxRetries; attempt++) {
      let node = this.pickNode(triedUrls);
      if (!node) {
        triedUrls.clear();
        node = this.pickNode();
        if (!node) {
          await this.opts.sleep(this.backoff(attempt));
          continue;
        }
      }

      triedUrls.add(node.url);
      const h = this.health.get(node.url)!;
      const start = this.opts.now();
      try {
        const res = await this.timedFetch(`${node.url}${path}`, init);
        const elapsed = this.opts.now() - start;

        if (res.status === 429 || res.status >= 500) {
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
      `StellarRpcPool: read operation to ${path} failed after ${this.opts.maxRetries} attempts` +
        (lastError instanceof Error ? `: ${lastError.message}` : "")
    );
  }

  /**
   * Execute state-changing submission without automatic duplicate retries.
   */
  async submitTransaction(path: string, init?: RequestInit): Promise<Response> {
    const node = this.pickNode();
    if (!node) {
      throw new Error("StellarRpcPool: no healthy RPC endpoints available for transaction submission");
    }

    const h = this.health.get(node.url)!;
    const start = this.opts.now();

    try {
      const res = await this.timedFetch(`${node.url}${path}`, init);
      const elapsed = this.opts.now() - start;

      if (!res.ok) {
        this.markFailure(h);
        throw new Error(`RPC transaction submission failed with HTTP ${res.status}`);
      }

      this.markSuccess(h, elapsed);
      return res;
    } catch (err) {
      this.markFailure(h);
      throw err;
    }
  }

  pickNode(excludeUrls?: Set<string>): RpcNode | null {
    const candidate = this.getHealth().find((node) => {
      if (excludeUrls?.has(node.url)) return false;
      const health = this.health.get(node.url);
      return Boolean(health && health.healthy && this.opts.now() >= health.cooldownUntil);
    });

    if (!candidate) {
      return null;
    }

    return { url: candidate.url, kind: candidate.kind };
  }

  private async pingNode(url: string, path: string): Promise<void> {
    const h = this.health.get(url);
    if (!h) return;
    const start = this.opts.now();
    try {
      const res = await this.timedFetch(`${url}${path}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
      const elapsed = this.opts.now() - start;
      if (res.ok) {
        this.markSuccess(h, elapsed);
      } else {
        this.markFailure(h);
      }
    } catch {
      this.markFailure(h);
    } finally {
      h.lastCheckedAt = this.opts.now();
    }
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

  private score(h: RpcNodeHealth): number {
    const now = this.opts.now();
    if (now < h.cooldownUntil) return Number.MAX_SAFE_INTEGER;
    if (!h.healthy) return Number.MAX_SAFE_INTEGER - 1;
    return Number.isFinite(h.latencyMs) ? h.latencyMs : Number.MAX_SAFE_INTEGER / 2;
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.opts.baseBackoffMs * 2 ** attempt, this.opts.maxBackoffMs);
    return Math.floor(exp / 2 + (exp / 2) * Math.random());
  }

  private markSuccess(h: RpcNodeHealth, latencyMs: number): void {
    h.latencyMs = h.latencyMs === Infinity ? latencyMs : h.latencyMs * 0.7 + latencyMs * 0.3;
    h.healthy = true;
    h.consecutiveFailures = 0;
    h.cooldownUntil = 0;
  }

  private markFailure(h: RpcNodeHealth): void {
    h.consecutiveFailures += 1;
    if (h.consecutiveFailures >= this.opts.unhealthyThreshold) {
      h.healthy = false;
    }
  }
}

export function resolveSorobanRpcNodes(
  source: Record<string, string | undefined> = typeof process !== "undefined"
    ? process.env
    : {}
): RpcNode[] {
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
    // Default fallback
  }

  const nodes: RpcNode[] = [];
  const configuredPrivate = split(source.NEXT_PUBLIC_SOROBAN_RPC_URLS);
  for (let i = 0; i < configuredPrivate.length; i++) {
    nodes.push({ url: configuredPrivate[i]!, kind: i === 0 ? "primary" : "fallback" });
  }

  const primary = source.NEXT_PUBLIC_SOROBAN_RPC_URL || source.PUBLIC_SOROBAN_RPC_URL;
  if (primary) {
    nodes.push({ url: primary, kind: nodes.length === 0 ? "primary" : "fallback" });
  }

  nodes.push({
    url: STELLAR_NETWORKS[network].rpcUrl,
    kind: nodes.length === 0 ? "primary" : "fallback",
  });

  return nodes;
}
