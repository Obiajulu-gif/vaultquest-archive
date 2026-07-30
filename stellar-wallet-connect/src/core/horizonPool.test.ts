import { describe, it, expect, vi } from "vitest";
import { HorizonPool, type HorizonNode } from "./horizonPool.js";
import { resolveHorizonNodes } from "./kit.js";

const NODES: HorizonNode[] = [
  { url: "https://node-a.example", kind: "private" },
  { url: "https://node-b.example", kind: "public" },
  { url: "https://node-c.example", kind: "public" },
];

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const noSleep = async () => {};

describe("HorizonPool", () => {
  it("requires at least one node", () => {
    expect(() => new HorizonPool({ nodes: [] })).toThrow(/at least one/);
  });

  it("distributes pings across all configured nodes", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: any) => {
      seen.push(String(url));
      return res(200, { ok: true });
    });
    const pool = new HorizonPool({ nodes: NODES, fetchImpl: fetchImpl as any, sleep: noSleep });

    await pool.pingAll("/");
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it("routes to the lowest-latency healthy node", async () => {
    // node-a is slow (40ms), node-b fast (5ms), node-c medium (20ms).
    const latency: Record<string, number> = {
      "https://node-a.example/": 40,
      "https://node-b.example/": 5,
      "https://node-c.example/": 20,
    };
    const fetchImpl = vi.fn(async (url: any) => {
      await new Promise((resolve) => setTimeout(resolve, latency[String(url)] ?? 10));
      return res(200);
    });
    const pool = new HorizonPool({
      nodes: NODES,
      fetchImpl: fetchImpl as any,
      sleep: noSleep,
    });

    await pool.pingAll("/");
    expect(pool.pickNode()?.url).toBe("https://node-b.example");
  });

  it("retries a 429 after a delay and reroutes to another node", async () => {
    const sleep = vi.fn(noSleep);
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return res(429, { error: "rate limited" }, { "Retry-After": "1" });
      return res(200, { balances: [] });
    });
    const pool = new HorizonPool({
      nodes: NODES,
      fetchImpl: fetchImpl as any,
      sleep: sleep as any,
    });

    const r = await pool.request("/accounts/GABC");
    expect(r.status).toBe(200);
    expect(call).toBe(2);
    expect(sleep).toHaveBeenCalled();
    // The 429'd node is put on cooldown.
    const cooling = pool.getHealth().filter((h) => h.cooldownUntil > 0);
    expect(cooling.length).toBe(1);
  });

  it("retries on 5xx then succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call < 3 ? res(503) : res(200, { ok: true });
    });
    const pool = new HorizonPool({ nodes: NODES, fetchImpl: fetchImpl as any, sleep: noSleep });

    const r = await pool.request("/accounts/GABC");
    expect(r.status).toBe(200);
    expect(call).toBe(3);
  });

  it("marks a node unhealthy after repeated transport failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const pool = new HorizonPool({
      nodes: [{ url: "https://only.example", kind: "public" }],
      fetchImpl: fetchImpl as any,
      maxRetries: 4,
      unhealthyThreshold: 3,
      sleep: noSleep,
    });

    await expect(pool.request("/accounts/GABC")).rejects.toThrow(/failed after/);
    expect(pool.getHealth()[0].healthy).toBe(false);
  });
});

describe("resolveHorizonNodes", () => {
  it("includes private, public, primary and network-default endpoints", () => {
    const nodes = resolveHorizonNodes({
      NEXT_PUBLIC_HORIZON_PRIVATE_URLS: "https://paid-1.example,https://paid-2.example",
      NEXT_PUBLIC_HORIZON_URLS: "https://mirror.example",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    });

    const urls = nodes.map((n) => n.url);
    expect(urls).toContain("https://paid-1.example");
    expect(urls).toContain("https://paid-2.example");
    expect(urls).toContain("https://mirror.example");
    expect(nodes.find((n) => n.url === "https://paid-1.example")?.kind).toBe("private");
    // At least three distinct endpoints are available to balance across.
    expect(new Set(urls).size).toBeGreaterThanOrEqual(3);
  });

  it("always yields at least the network default", () => {
    const nodes = resolveHorizonNodes({});
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });
});
