import { describe, it, expect, vi } from "vitest";
import { StellarRpcPool, resolveSorobanRpcNodes, type RpcNode } from "./stellarRpcPool.js";

const NODES: RpcNode[] = [
  { url: "https://rpc-primary.example", kind: "primary" },
  { url: "https://rpc-fallback.example", kind: "fallback" },
];

function mockResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const noSleep = async () => {};

describe("StellarRpcPool", () => {
  it("requires at least one node", () => {
    expect(() => new StellarRpcPool({ nodes: [] })).toThrow(/at least one/);
  });

  it("recovers read operations from a failed primary endpoint to fallback", async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async (url: any) => {
      callCount += 1;
      if (String(url).startsWith("https://rpc-primary.example")) {
        return mockResponse(500, { error: "Primary down" });
      }
      return mockResponse(200, { result: "ok" });
    });

    const pool = new StellarRpcPool({
      nodes: NODES,
      fetchImpl: fetchImpl as any,
      sleep: noSleep,
    });

    const res = await pool.readContract("/soroban/read");
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
    expect(pool.getDiagnostics().healthyNodes).toBeGreaterThanOrEqual(1);
  });

  it("prevents duplicate state-changing transaction submissions on failure", async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      return mockResponse(500, { error: "Tx error" });
    });

    const pool = new StellarRpcPool({
      nodes: NODES,
      fetchImpl: fetchImpl as any,
      sleep: noSleep,
    });

    await expect(pool.submitTransaction("/soroban/submit")).rejects.toThrow(/HTTP 500/);
    expect(callCount).toBe(1);
  });

  it("exposes active endpoint and useful diagnostics", async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200));
    const pool = new StellarRpcPool({
      nodes: NODES,
      fetchImpl: fetchImpl as any,
      sleep: noSleep,
    });

    const diag = pool.getDiagnostics();
    expect(diag.totalNodes).toBe(2);
    expect(diag.activeEndpoint).toBe("https://rpc-primary.example");
    expect(diag.nodes.length).toBe(2);
  });
});

describe("resolveSorobanRpcNodes", () => {
  it("resolves primary, fallback and default endpoints", () => {
    const nodes = resolveSorobanRpcNodes({
      NEXT_PUBLIC_SOROBAN_RPC_URLS: "https://rpc-1.example,https://rpc-2.example",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc-primary.example",
    });

    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(nodes[0]?.kind).toBe("primary");
  });
});
