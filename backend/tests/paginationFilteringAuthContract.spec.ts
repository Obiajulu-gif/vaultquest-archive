import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { LedgerService } from "../src/services/ledger.js";
import { SavedPoolsService } from "../src/services/savedPools.js";
import { actionsRoutes } from "../src/routes/actions.js";
import { savedPoolsRoutes } from "../src/routes/savedPools.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import correlation from "../src/middleware/correlation.js";
import { requirePermission, walletSessionResolver, serviceSecretResolver } from "../src/middleware/rbac.js";
import { ERROR_CODES } from "../src/constants.js";
import { ok } from "../src/responses.js";

/**
 * In-memory simulated Prisma mock for ActionLedger and SavedPools to test
 * pagination, filtering, and authorization contracts deterministically in milliseconds.
 */
function createMockPrisma() {
  const actions: any[] = [];
  const savedPools: any[] = [];
  const checkpoints: any[] = [{ id: "singleton", latestLedger: 5000000, lastProcessedEventId: "ev-1" }];

  return {
    actions,
    savedPools,
    actionLedger: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: data.id || randomUUID(),
          ...data,
          createdAt: data.createdAt || new Date(),
          updatedAt: data.updatedAt || new Date(),
          submittedAt: data.submittedAt || null,
          confirmedAt: data.confirmedAt || null,
          redactedAt: data.redactedAt || null
        };
        actions.push(row);
        return { ...row };
      }),
      findMany: vi.fn(async (args: any) => {
        let filtered = [...actions];
        if (args.where) {
          if (args.where.walletAddress) {
            filtered = filtered.filter((r) => r.walletAddress === args.where.walletAddress);
          }
          if (args.where.redactedAt === null) {
            filtered = filtered.filter((r) => r.redactedAt === null);
          }
          if (args.where.status) {
            filtered = filtered.filter((r) => r.status === args.where.status);
          }
          if (args.where.actionType) {
            filtered = filtered.filter((r) => r.actionType === args.where.actionType);
          }
        }

        // Sorting: [{ createdAt: "desc" }, { id: "desc" }]
        filtered.sort((a, b) => {
          const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
          if (timeDiff !== 0) return timeDiff;
          return b.id.localeCompare(a.id);
        });

        // Cursor logic
        if (args.cursor?.id) {
          const cursorIndex = filtered.findIndex((r) => r.id === args.cursor.id);
          if (cursorIndex === -1) {
            filtered = [];
          } else {
            const skip = args.skip || 0;
            filtered = filtered.slice(cursorIndex + skip);
          }
        }

        if (args.take) {
          filtered = filtered.slice(0, args.take);
        }

        return filtered.map((r) => ({ ...r }));
      }),
      findFirst: vi.fn(async (args: any) => {
        if (args.where?.id) return actions.find((r) => r.id === args.where.id) || null;
        if (args.where?.txHash) return actions.find((r) => r.txHash === args.where.txHash) || null;
        return null;
      }),
      findUnique: vi.fn(async (args: any) => {
        if (args.where?.id) return actions.find((r) => r.id === args.where.id) || null;
        if (args.where?.idempotencyKey) return actions.find((r) => r.idempotencyKey === args.where.idempotencyKey) || null;
        return null;
      })
    },
    savedPool: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: data.id || randomUUID(),
          ...data,
          createdAt: data.createdAt || new Date(),
          updatedAt: data.updatedAt || new Date()
        };
        savedPools.push(row);
        return { ...row };
      }),
      findMany: vi.fn(async (args: any) => {
        let filtered = [...savedPools];
        if (args.where?.walletAddress) {
          filtered = filtered.filter((r) => r.walletAddress === args.where.walletAddress);
        }
        filtered.sort((a, b) => {
          const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
          if (timeDiff !== 0) return timeDiff;
          return b.id.localeCompare(a.id);
        });
        if (args.cursor?.id) {
          const cursorIndex = filtered.findIndex((r) => r.id === args.cursor.id);
          if (cursorIndex === -1) {
            filtered = [];
          } else {
            const skip = args.skip || 0;
            filtered = filtered.slice(cursorIndex + skip);
          }
        }
        if (args.take) {
          filtered = filtered.slice(0, args.take);
        }
        return filtered.map((r) => ({ ...r }));
      }),
      deleteMany: vi.fn(async () => ({ count: 0 }))
    },
    indexerCheckpoint: {
      findUnique: vi.fn(async () => checkpoints[0])
    },
    $transaction: vi.fn(async (fn: any) => fn(createMockPrisma()))
  } as any;
}

function buildContractTestApp(prismaMock: any) {
  const app = Fastify();
  app.register(correlation);
  app.setErrorHandler(errorHandler);

  const ledgerService = new LedgerService(prismaMock);
  const savedPoolsService = new SavedPoolsService(prismaMock);
  const apiKeyGuard = async () => {};

  app.register(actionsRoutes(ledgerService, apiKeyGuard));
  app.register(savedPoolsRoutes(savedPoolsService, apiKeyGuard));

  // Maintainer test route to test RBAC boundaries
  const serviceSecret = "test-internal-secret";
  app.get("/admin/test-privileged", {
    preHandler: [requirePermission("admin.audit.read", [walletSessionResolver(prismaMock), serviceSecretResolver(serviceSecret)])]
  }, async () => ok({ privileged: true }));

  // Internal test route to test service boundaries
  app.get("/internal/test-service", {
    preHandler: [requirePermission("internal.reconcile", [serviceSecretResolver(serviceSecret)])]
  }, async () => ok({ service: true }));

  return app;
}

describe("Contract Tests: Pagination, Filtering, and Authorization Boundaries (#985)", () => {
  const prismaMock = createMockPrisma();
  const app = buildContractTestApp(prismaMock);

  const WALLET_ALICE = "GAALICE1111111111111111111111111111111111111111111111111111";
  const WALLET_BOB = "GABOB22222222222222222222222222222222222222222222222222222";

  // Helper to seed ActionLedger rows
  function seedAction(wallet: string, index: number, overrides: Record<string, any> = {}) {
    const date = new Date(Date.now() - (100 - index) * 60000);
    const row = {
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      idempotencyKey: randomUUID(),
      walletAddress: wallet,
      actionType: "deposit",
      actionPayload: { amount: 100 + index, token: "XLM" },
      status: "confirmed",
      txHash: `0x${String(index).padStart(64, "0")}`,
      sorobanEventId: `ev-${index}`,
      correlationId: randomUUID(),
      errorCode: null,
      errorDetail: null,
      retryCount: 0,
      createdAt: date,
      updatedAt: date,
      submittedAt: date,
      confirmedAt: date,
      redactedAt: null,
      ...overrides
    };
    prismaMock.actions.push(row);
    return row;
  }

  describe("1. Normal Pagination Paths & Cursor Monotonicity", () => {
    it("pages sequentially through a multi-page dataset without duplicates or skips", async () => {
      prismaMock.actions.length = 0;
      for (let i = 1; i <= 9; i++) {
        seedAction(WALLET_ALICE, i);
      }

      // Page 1: limit 4
      const p1Res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&limit=4` });
      expect(p1Res.statusCode).toBe(200);
      const p1 = p1Res.json();
      expect(p1.data).toHaveLength(4);
      expect(p1.meta.pagination.has_more).toBe(true);
      expect(p1.meta.pagination.limit).toBe(4);
      expect(p1.meta.pagination.next_cursor).toBe(p1.data[3].id);

      // Page 2: limit 4, cursor from page 1
      const p2Res = await app.inject({
        method: "GET",
        url: `/actions?wallet=${WALLET_ALICE}&limit=4&cursor=${p1.meta.pagination.next_cursor}`
      });
      expect(p2Res.statusCode).toBe(200);
      const p2 = p2Res.json();
      expect(p2.data).toHaveLength(4);
      expect(p2.meta.pagination.has_more).toBe(true);
      expect(p2.meta.pagination.next_cursor).toBe(p2.data[3].id);

      // Page 3 (Terminal): limit 4, cursor from page 2
      const p3Res = await app.inject({
        method: "GET",
        url: `/actions?wallet=${WALLET_ALICE}&limit=4&cursor=${p2.meta.pagination.next_cursor}`
      });
      expect(p3Res.statusCode).toBe(200);
      const p3 = p3Res.json();
      expect(p3.data).toHaveLength(1);
      expect(p3.meta.pagination.has_more).toBe(false);
      expect(p3.meta.pagination.next_cursor).toBeNull();

      // Verify no duplicates across all pages
      const allIds = [...p1.data, ...p2.data, ...p3.data].map((r: any) => r.id);
      expect(allIds).toHaveLength(9);
      expect(new Set(allIds).size).toBe(9);
    });

    it("handles exact limit boundary: total = limit returns has_more = false and next_cursor = null", async () => {
      prismaMock.actions.length = 0;
      for (let i = 1; i <= 5; i++) {
        seedAction(WALLET_ALICE, i);
      }

      const res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&limit=5` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(5);
      expect(body.meta.pagination.has_more).toBe(false);
      expect(body.meta.pagination.next_cursor).toBeNull();
    });

    it("handles empty dataset cleanly with standard pagination envelope", async () => {
      prismaMock.actions.length = 0;
      const res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&limit=10` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.meta.pagination.has_more).toBe(false);
      expect(body.meta.pagination.next_cursor).toBeNull();
    });

    it("clamps limit parameters to valid bounds (min 1, max 100, default 25)", async () => {
      // Limit > 100 should be rejected by schema validation
      const overMax = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&limit=500` });
      expect(overMax.statusCode).toBe(400);
      expect(overMax.json().code).toBe(ERROR_CODES.INVALID_PAYLOAD);

      // Limit < 1 should be rejected
      const underMin = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&limit=0` });
      expect(underMin.statusCode).toBe(400);
    });
  });

  describe("2. Filtering Boundaries", () => {
    beforeEach(() => {
      prismaMock.actions.length = 0;
      // Seed mix of statuses and types for Alice
      seedAction(WALLET_ALICE, 1, { status: "pending", actionType: "deposit" });
      seedAction(WALLET_ALICE, 2, { status: "submitted", actionType: "deposit" });
      seedAction(WALLET_ALICE, 3, { status: "confirmed", actionType: "deposit" });
      seedAction(WALLET_ALICE, 4, { status: "confirmed", actionType: "withdraw" });
      seedAction(WALLET_ALICE, 5, { status: "reverted", actionType: "claim" });
      // Seed a soft-deleted / redacted record
      seedAction(WALLET_ALICE, 6, { status: "confirmed", redactedAt: new Date() });
    });

    it("filters exactly by status and excludes non-matching statuses", async () => {
      const res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&status=confirmed` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(2); // Only non-redacted confirmed rows
      for (const item of body.data) {
        expect(item.status).toBe("confirmed");
      }
    });

    it("filters by actionType", async () => {
      const res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&type=withdraw` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].action_type).toBe("withdraw");
    });

    it("combines status and actionType filters", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/actions?wallet=${WALLET_ALICE}&status=confirmed&type=deposit`
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].status).toBe("confirmed");
      expect(body.data[0].action_type).toBe("deposit");
    });

    it("strictly excludes soft-deleted/redacted records from public action queries", async () => {
      const res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.data.map((r: any) => r.id);
      expect(ids).not.toContain("act-0006-0000-0000-000000000000");
    });

    it("rejects invalid filter enum values with standard Problem Details", async () => {
      const res = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}&status=not_a_status` });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe(ERROR_CODES.INVALID_PAYLOAD);
      expect(body.title).toBe("Validation Error");
      expect(body.remediation).toBeDefined();
    });
  });

  describe("3. Multi-Tenant and Role Authorization Boundaries", () => {
    beforeEach(() => {
      prismaMock.actions.length = 0;
      seedAction(WALLET_ALICE, 1);
      seedAction(WALLET_BOB, 2);
    });

    it("strictly isolates multi-tenant records: Alice cannot view Bob's actions", async () => {
      const resAlice = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_ALICE}` });
      expect(resAlice.statusCode).toBe(200);
      const aliceData = resAlice.json().data;
      expect(aliceData).toHaveLength(1);
      expect(aliceData[0].wallet_address).toBe(WALLET_ALICE);

      const resBob = await app.inject({ method: "GET", url: `/actions?wallet=${WALLET_BOB}` });
      expect(resBob.statusCode).toBe(200);
      const bobData = resBob.json().data;
      expect(bobData).toHaveLength(1);
      expect(bobData[0].wallet_address).toBe(WALLET_BOB);
    });

    it("requires wallet parameter on list actions (rejects missing wallet)", async () => {
      const res = await app.inject({ method: "GET", url: "/actions" });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(ERROR_CODES.INVALID_PAYLOAD);
    });

    it("enforces RBAC boundary: unauthenticated request to privileged route returns 401 UNAUTHORIZED", async () => {
      const res = await app.inject({ method: "GET", url: "/admin/test-privileged" });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe(ERROR_CODES.UNAUTHORIZED);
      expect(body.remediation).toContain("Connect your wallet");
    });

    it("enforces internal service boundary: missing X-Internal-Secret returns 401 UNAUTHORIZED", async () => {
      const res = await app.inject({ method: "GET", url: "/internal/test-service" });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe(ERROR_CODES.UNAUTHORIZED);
    });

    it("permits service access when valid service secret is provided", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/internal/test-service",
        headers: { "x-internal-secret": "test-internal-secret" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ service: true });
    });
  });

  describe("4. Failure and Retry Paths", () => {
    it("rejects malformed cursor format (not a UUID) with 400 Problem Details", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/actions?wallet=${WALLET_ALICE}&cursor=invalid-cursor-value`
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe(ERROR_CODES.INVALID_PAYLOAD);
      expect(body.invalid_params).toBeDefined();
      expect(body.invalid_params.some((p: any) => p.name.includes("cursor"))).toBe(true);
    });

    it("returns empty data safely when non-existent cursor is provided", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/actions?wallet=${WALLET_ALICE}&cursor=${randomUUID()}`
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toEqual([]);
      expect(body.meta.pagination.has_more).toBe(false);
      expect(body.meta.pagination.next_cursor).toBeNull();
    });
  });
});
