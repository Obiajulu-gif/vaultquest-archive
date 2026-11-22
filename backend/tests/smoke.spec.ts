import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { DegradedModeService } from "../src/services/degradedModeService.js";

function createMockPrisma(): PrismaClient {
  const mock: any = {
    $queryRaw: async () => [{ 1: 1 }],
    $executeRawUnsafe: async () => 0,
    $transaction: async (fn: any) => fn(mock),
    actionLedger: {
      findFirst: async () => null,
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async ({ data }: any) => ({ id: "act_1", ...data }),
      update: async ({ data }: any) => ({ id: "act_1", ...data }),
    },
    actionLease: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: any) => ({ ...data }),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
    pendingEvent: {
      upsert: async () => ({}),
      findUnique: async () => null,
      findFirst: async () => null,
      create: async () => ({}),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
    },
    walletSession: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: any) => ({ ...data }),
      deleteMany: async () => ({ count: 0 }),
    },
    walletChallenge: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: any) => ({ ...data }),
      deleteMany: async () => ({ count: 0 }),
    },
    savedPool: {
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
    },
    userQuest: {
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
    },
    featureFlagRollout: {
      findMany: async () => [],
      findUnique: async () => null,
      create: async () => ({}),
      update: async () => ({}),
    },
    flagRolloutAudit: {
      create: async () => ({}),
      findMany: async () => [],
    },
    auditTrail: {
      create: async () => ({}),
      findMany: async () => [],
      findFirst: async () => null,
    },
    receiptRecord: {
      create: async () => ({}),
      findMany: async () => [],
      findUnique: async () => null,
    },
    pendingRecoveryCase: {
      create: async () => ({}),
      findMany: async () => [],
      findUnique: async () => null,
    },
    operationLimitOverride: {
      create: async () => ({}),
      findMany: async () => [],
      findUnique: async () => null,
    },
    webhookEventRecord: {
      create: async () => ({}),
      findMany: async () => [],
      findUnique: async () => null,
    },
    protocolAudit: {
      create: async () => ({}),
      findMany: async () => [],
    },
  };
  return mock as unknown as PrismaClient;
}

describe("smoke and release readiness verification", () => {
  let db: TestDb | null = null;
  let app: FastifyInstance;
  let degradedService: DegradedModeService;
  const internalSecret = "test-internal-secret-for-smoke-972";

  beforeAll(async () => {
    try {
      db = await startTestDb();
    } catch {
      // Docker runtime unavailable; fall back gracefully to mock Prisma
      db = null;
    }

    const prisma = db ? db.prisma : createMockPrisma();
    degradedService = new DegradedModeService();

    app = buildApp({
      prisma,
      internalSecret,
      degradedModeService: degradedService,
    });
  });

  afterAll(async () => {
    await app.close();
    if (db) {
      await db.stop();
    }
  });

  describe("Normal paths", () => {
    it("GET /health returns 200 with service status and uptime", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.data.status).toBe("ok");
      expect(json.data.service).toBe("vaultquest-backend");
      expect(typeof json.data.uptime).toBe("number");
      expect(typeof json.data.timestamp).toBe("string");
    });

    it("GET /health/attestation returns 200 with attestation state", async () => {
      const res = await app.inject({ method: "GET", url: "/health/attestation" });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(typeof json.data.ok).toBe("boolean");
      expect(typeof json.data.verified).toBe("boolean");
    });

    it("GET /health/status aggregates component health into structured status", async () => {
      const res = await app.inject({ method: "GET", url: "/health/status" });
      expect([200, 503]).toContain(res.statusCode);
      const json = res.json();
      expect(json.data.status).toBeDefined();
      expect(json.data.components.api.status).toBe("healthy");
      expect(json.data.components.indexer).toBeDefined();
    });
  });

  describe("Failure paths", () => {
    it("GET /non-existent-route returns 404 Problem Details", async () => {
      const res = await app.inject({ method: "GET", url: "/non-existent-route-972" });
      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json.statusCode).toBe(404);
      expect(json.error).toBe("Not Found");
    });

    it("POST /internal/reconcile with malformed body fails validation with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/reconcile",
        headers: { "x-internal-secret": internalSecret },
        payload: { invalidField: true },
      });
      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error).toBeDefined();
    });
  });

  describe("Retry paths", () => {
    it("GET /health/degraded returns 503 with Retry-After header when dependency fails", async () => {
      // Simulate upstream dependency outage
      degradedService.setDependencyStatus("database", "unavailable", "Simulated maintenance");

      const res = await app.inject({ method: "GET", url: "/health/degraded" });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("30");

      const json = res.json();
      expect(json.data.status).toBe("unavailable");
      expect(json.data.retryAfterSeconds).toBe(30);

      // Verify recovery path: after restoring health, client retry succeeds with 200
      degradedService.setDependencyStatus("database", "healthy");
      const retryRes = await app.inject({ method: "GET", url: "/health/degraded" });
      expect(retryRes.statusCode).toBe(200);
      expect(retryRes.json().data.status).toBe("healthy");
    });
  });

  describe("Authorization paths", () => {
    it("POST /internal/reconcile without x-internal-secret returns 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/reconcile",
        payload: {
          tx_hash: "0x123",
          soroban_event_id: "evt_1",
          event_payload: {},
          status_hint: "confirmed",
        },
      });
      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /internal/reconcile with invalid secret returns 401 Unauthorized", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/reconcile",
        headers: { "x-internal-secret": "wrong-secret" },
        payload: {
          tx_hash: "0x123",
          soroban_event_id: "evt_1",
          event_payload: {},
          status_hint: "confirmed",
        },
      });
      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /internal/reconcile with valid secret passes authentication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/internal/reconcile",
        headers: { "x-internal-secret": internalSecret },
        payload: {
          tx_hash: "0xabc",
          soroban_event_id: "evt_123",
          event_payload: { amount: "100" },
          status_hint: "confirmed",
        },
      });
      // 200 or 202 depending on match result
      expect([200, 202]).toContain(res.statusCode);
    });
  });
});
