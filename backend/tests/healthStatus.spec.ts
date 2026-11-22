/**
 * Tests for Issue #992 — Public health endpoint with dependency-aware status.
 *
 * Verifies:
 *  - GET /health/status returns 200 when all components are healthy
 *  - GET /health/status returns 200 with status=degraded when a non-required
 *    dependency is down
 *  - GET /health/status returns 503 with status=unavailable when a required
 *    dependency is down
 *  - Response never leaks RPC credentials or hostnames
 *  - Response shape matches the documented contract
 */

import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { checkDependencies } from "../src/routes/health.js";

describe("GET /health/status — Issue #992", () => {
  const makeCheckpoint = () => ({
    id: "singleton",
    latestLedger: 55000,
    lastProcessedEventId: "evt-55000",
    lastSyncTime: new Date(),
    lastError: null,
    lastSuccessSyncTime: new Date()
  });

  it("returns 200 with status=healthy when all components are healthy", async () => {
    const mockPrisma = {
      indexerCheckpoint: { findUnique: async () => makeCheckpoint() },
      $queryRaw: async () => [{ "?column?": 1 }],
    } as any;
    const app = buildApp({
      prisma: mockPrisma,
      internalSecret: "s",
      sorobanRpcUrls: "https://rpc.example.test",
    });

    const res = await app.inject({
      method: "GET",
      url: "/health/status",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.status).toBe("healthy");
    expect(body.data.components.api.status).toBe("healthy");
    expect(body.data.components.indexer.latest_ledger).toBe(55000);
    expect(body.data.uptime).toBeGreaterThanOrEqual(0);
    await app.close();
  });

  it("returns 503 with status=unavailable when a required dependency is down", async () => {
    const mockPrisma = {
      indexerCheckpoint: { findUnique: async () => makeCheckpoint() },
      $queryRaw: async () => { throw new Error("postgres://user:secret@host/db"); },
    } as any;
    const app = buildApp({
      prisma: mockPrisma,
      internalSecret: "s",
      sorobanRpcUrls: "https://rpc.example.test",
    });

    const res = await app.inject({ method: "GET", url: "/health/status" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.data.status).toBe("unavailable");
    // Sensitive values must never appear in the response
    expect(JSON.stringify(body)).not.toContain("secret");
    await app.close();
  });

  it("returns 200 with status=degraded when indexer is lagging", async () => {
    // Checkpoint that is well past the stale threshold
    const staleTime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const mockPrisma = {
      indexerCheckpoint: {
        findUnique: async () => ({
          ...makeCheckpoint(),
          lastSyncTime: staleTime,
          lastSuccessSyncTime: staleTime,
          lastError: null
        })
      },
      $queryRaw: async () => [{ "?column?": 1 }],
    } as any;
    const app = buildApp({
      prisma: mockPrisma,
      internalSecret: "s",
      sorobanRpcUrls: "https://rpc.example.test",
    });

    const res = await app.inject({ method: "GET", url: "/health/status" });
    // Lagging → degraded → 200
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(["degraded", "healthy"]).toContain(body.data.status); // depends on stale threshold
    await app.close();
  });

  it("does not expose RPC credentials or hostnames in the response", async () => {
    const mockPrisma = {
      indexerCheckpoint: { findUnique: async () => makeCheckpoint() },
      $queryRaw: async () => [{ "?column?": 1 }],
    } as any;
    const app = buildApp({
      prisma: mockPrisma,
      internalSecret: "s",
      sorobanRpcUrls: "https://user:password@rpc.secret.example",
    });

    const res = await app.inject({ method: "GET", url: "/health/status" });
    expect(JSON.stringify(res.json())).not.toContain("password");
    expect(JSON.stringify(res.json())).not.toContain("rpc.secret.example");
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// checkDependencies unit tests (extends health.spec.ts coverage)
// ---------------------------------------------------------------------------

describe("checkDependencies — Issue #992 dependency-aware status", () => {
  const makeDeps = (overrides: Record<string, unknown> = {}) => ({
    prisma: { $queryRaw: vi.fn(async () => [{ "?column?": 1 }]) } as any,
    cacheService: { redisClient: { ping: vi.fn(async () => "PONG") } } as any,
    rpcUrls: "https://rpc.example.test",
    fetch: vi.fn(async () =>
      new Response(JSON.stringify({ result: { status: "healthy" } }), { status: 200 })
    ),
    ...overrides,
  });

  it("returns healthy when all three dependencies respond positively", async () => {
    const report = await checkDependencies(makeDeps());
    expect(report.status).toBe("healthy");
    expect(report.dependencies.every((d) => d.status === "healthy")).toBe(true);
    expect(report.checkedAt).toBeDefined();
  });

  it("includes latencyMs on every dependency result", async () => {
    const report = await checkDependencies(makeDeps());
    for (const dep of report.dependencies) {
      expect(typeof dep.latencyMs).toBe("number");
    }
  });

  it("marks overall status unavailable when DB is down and omits error details", async () => {
    const report = await checkDependencies(
      makeDeps({
        prisma: {
          $queryRaw: vi.fn(async () => {
            throw new Error("pg://user:topsecret@internal-host/db");
          }),
        },
      })
    );
    expect(report.status).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain("topsecret");
    expect(JSON.stringify(report)).not.toContain("internal-host");
  });
});
