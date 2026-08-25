/**
 * Tests for API key authentication on external-service endpoints (issue #273).
 *
 * Covered behaviour:
 * - When `apiKey` is configured, /api/* routes reject missing / wrong keys with 401.
 * - When `apiKey` is configured, the correct key grants access.
 * - When `apiKey` is NOT configured (undefined), /api/* routes are accessible
 *   without a key (local-dev no-op mode).
 * - Non-API routes (/health, /actions) are unaffected by the guard.
 */

import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../src/app.js";

const VALID_API_KEY = "a".repeat(32); // 32-char key that passes env validation

function getMockPrisma() {
  return {
    actionLedger: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([])
    },
    savedPool: { findMany: vi.fn().mockResolvedValue([]) },
    indexerCheckpoint: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: "singleton" })
    },
    vaultSettlement: { findMany: vi.fn().mockResolvedValue([]) },
    userQuest: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation(async (args: unknown) => {
      if (Array.isArray(args)) return [0, []];
      return (args as (tx: unknown) => unknown)(null);
    })
  } as any;
}

// ─── Guard enabled ────────────────────────────────────────────────────────────

describe("API key auth — guard enabled", () => {
  it("rejects /api/actions/:wallet with no key → 401", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({ method: "GET", url: "/api/actions/GWALLET" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("rejects /api/actions/:wallet with wrong key → 401", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({
      method: "GET",
      url: "/api/actions/GWALLET",
      headers: { "x-api-key": "wrong-key" }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("allows /api/actions/:wallet with correct key → 200", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({
      method: "GET",
      url: "/api/actions/GWALLET",
      headers: { "x-api-key": VALID_API_KEY }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects /api/metrics with no key → 401", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("allows /api/metrics with correct key → 200", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { "x-api-key": VALID_API_KEY }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects /api/metrics/round with no key → 401", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({ method: "GET", url: "/api/metrics/round" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects /api/metrics/history with no key → 401", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({ method: "GET", url: "/api/metrics/history" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// ─── Guard disabled (no API_KEY set) ─────────────────────────────────────────

describe("API key auth — guard disabled (no apiKey configured)", () => {
  it("allows /api/actions/:wallet without key → 200", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret" /* no apiKey */ });
    const res = await app.inject({ method: "GET", url: "/api/actions/GWALLET" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("allows /api/metrics without key → 200", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret" });
    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

// ─── Non-API routes are unaffected ───────────────────────────────────────────

describe("API key auth — non-API routes unaffected", () => {
  it("/health is accessible without a key even when guard is enabled", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("/actions (cursor list) is accessible without api key (uses wallet-scoping only)", async () => {
    const app = buildApp({ prisma: getMockPrisma(), internalSecret: "secret", apiKey: VALID_API_KEY });
    const res = await app.inject({ method: "GET", url: "/actions?wallet=GWALLET" });
    // 200 — the guard does NOT apply to the public /actions route
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
