import { describe, it, expect, vi } from "vitest";
import { LedgerService } from "../src/services/ledger.js";
import { buildApp } from "../src/app.js";
import { checkDependencies } from "../src/routes/health.js";

describe("dependency health diagnostics", () => {
  const makeDeps = (overrides: Record<string, unknown> = {}) => ({
    prisma: { $queryRaw: vi.fn(async () => [{ "?column?": 1 }]) } as any,
    cacheService: { redisClient: { ping: vi.fn(async () => "PONG") } } as any,
    rpcUrls: "https://rpc.example.test",
    fetch: vi.fn(async () => new Response(JSON.stringify({ result: { status: "healthy" } }), { status: 200 })),
    ...overrides,
  });

  it("reports all configured dependencies healthy without returning endpoint values", async () => {
    const report = await checkDependencies(makeDeps());
    expect(report.status).toBe("healthy");
    expect(report.dependencies.map((item) => item.status)).toEqual(["healthy", "healthy", "healthy"]);
    expect(JSON.stringify(report)).not.toContain("rpc.example.test");
  });

  it("reports optional Redis as degraded when it is not configured", async () => {
    const report = await checkDependencies(makeDeps({ cacheService: undefined }));
    expect(report.status).toBe("degraded");
    expect(report.dependencies.find((item) => item.name === "redis_cache")?.status).toBe("degraded");
  });

  it("reports a required database failure as unavailable without leaking the error", async () => {
    const report = await checkDependencies(makeDeps({
      prisma: { $queryRaw: vi.fn(async () => { throw new Error("postgres://user:secret@host/db"); }) },
    }));
    expect(report.status).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain("secret");
  });

  it("reports missing and malformed RPC configuration without exposing values", async () => {
    for (const rpcUrls of [undefined, "https://user:password@bad.example"]) {
      const report = await checkDependencies(makeDeps({ rpcUrls }));
      expect(report.status).toBe("unavailable");
      expect(report.dependencies.find((item) => item.name === "soroban_rpc")?.status).toBe("misconfigured");
      expect(JSON.stringify(report)).not.toContain("password");
    }
  });

  it("marks partial RPC failure degraded and total RPC failure unavailable", async () => {
    const partial = await checkDependencies(makeDeps({
      rpcUrls: "https://one.example,https://two.example",
      fetch: vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ result: { status: "healthy" } }), { status: 200 }))
        .mockRejectedValueOnce(new Error("provider down")),
    }));
    expect(partial.status).toBe("degraded");

    const failed = await checkDependencies(makeDeps({
      fetch: vi.fn(async () => new Response("failure", { status: 503 })),
    }));
    expect(failed.status).toBe("unavailable");
  });
});

describe("Indexer Health & Sync-Lag Tests", () => {
  describe("LedgerService.updateIndexerCheckpoint (Unit)", () => {
    it("upserts the singleton checkpoint with expected parameters", async () => {
      let upsertArgs: any = null;
      const mockPrisma = {
        indexerCheckpoint: {
          upsert: async (args: any) => {
            upsertArgs = args;
            return {
              id: "singleton",
              latestLedger: args.create.latestLedger,
              lastProcessedEventId: args.create.lastProcessedEventId,
              lastSyncTime: args.create.lastSyncTime,
              lastError: args.create.lastError,
              lastSuccessSyncTime: args.create.lastSuccessSyncTime
            };
          },
          findUnique: async () => ({
            id: "singleton",
            latestLedger: 12345,
            lastProcessedEventId: "evt-1",
            lastSyncTime: new Date(),
            lastError: null,
            lastSuccessSyncTime: new Date()
          })
        }
      } as any;

      const svc = new LedgerService(mockPrisma);
      await svc.updateIndexerCheckpoint({
        latestLedger: 12345,
        lastError: "Connection lost",
        success: false
      });

      expect(upsertArgs).not.toBeNull();
      expect(upsertArgs.where.id).toBe("singleton");
      expect(upsertArgs.create.latestLedger).toBe(12345);
      expect(upsertArgs.create.lastError).toBe("Connection lost");
      expect(upsertArgs.update.latestLedger).toBe(12345);
      expect(upsertArgs.update.lastError).toBe("Connection lost");
    });
  });

  describe("LedgerService.getIndexerHealth (Unit)", () => {
    it("returns degraded if no checkpoint exists", async () => {
      const mockPrisma = {
        indexerCheckpoint: {
          findUnique: async () => null
        }
      } as any;

      const svc = new LedgerService(mockPrisma);
      const health = await svc.getIndexerHealth();

      expect(health.status).toBe("degraded");
      expect(health.latest_ledger).toBe(0);
      expect(health.sync_lag).toBe(0);
      expect(health.message).toContain("No indexer checkpoint found");
    });

    it("returns healthy if checkpoint is recently updated without errors", async () => {
      const lastSync = new Date("2026-05-30T03:00:00Z");
      const mockPrisma = {
        indexerCheckpoint: {
          findUnique: async () => ({
            id: "singleton",
            latestLedger: 50000,
            lastProcessedEventId: "evt-50000",
            lastSyncTime: lastSync,
            lastError: null,
            lastSuccessSyncTime: lastSync
          })
        }
      } as any;

      const svc = new LedgerService(mockPrisma);
      const health = await svc.getIndexerHealth({
        now: new Date("2026-05-30T03:02:00Z"), // 2 minutes later
        staleAfterMs: 5 * 60 * 1000
      });

      expect(health.status).toBe("healthy");
      expect(health.latest_ledger).toBe(50000);
      expect(health.sync_lag).toBe(24); // 120 seconds / 5 seconds = 24 ledgers lag
      expect(health.last_error).toBeNull();
    });

    it("returns degraded if a hard error is registered", async () => {
      const lastSync = new Date("2026-05-30T03:00:00Z");
      const mockPrisma = {
        indexerCheckpoint: {
          findUnique: async () => ({
            id: "singleton",
            latestLedger: 50000,
            lastProcessedEventId: "evt-50000",
            lastSyncTime: lastSync,
            lastError: "Horizon RPC 429 Rate Limit Exceeded",
            lastSuccessSyncTime: lastSync
          })
        }
      } as any;

      const svc = new LedgerService(mockPrisma);
      const health = await svc.getIndexerHealth({
        now: new Date("2026-05-30T03:02:00Z"),
        staleAfterMs: 5 * 60 * 1000
      });

      expect(health.status).toBe("degraded");
      expect(health.last_error).toBe("Horizon RPC 429 Rate Limit Exceeded");
      expect(health.message).toContain("Horizon RPC 429 Rate Limit Exceeded");
    });

    it("returns lagging if last successful sync time exceeds staleAfterMs threshold", async () => {
      const lastSync = new Date("2026-05-30T03:00:00Z");
      const mockPrisma = {
        indexerCheckpoint: {
          findUnique: async () => ({
            id: "singleton",
            latestLedger: 50000,
            lastProcessedEventId: "evt-50000",
            lastSyncTime: lastSync,
            lastError: null,
            lastSuccessSyncTime: lastSync
          })
        }
      } as any;

      const svc = new LedgerService(mockPrisma);
      const health = await svc.getIndexerHealth({
        now: new Date("2026-05-30T03:06:00Z"), // 6 minutes later (exceeds 5m threshold)
        staleAfterMs: 5 * 60 * 1000
      });

      expect(health.status).toBe("lagging");
      expect(health.sync_lag).toBe(72); // 360 seconds / 5 seconds = 72 ledgers lag
      expect(health.message).toContain("lagging");
    });
  });

  describe("Indexer API Endpoints (Integration Mocks)", () => {
    const internalSecret = "test-secret-456";

    it("GET /health/indexer returns indexer health successfully", async () => {
      const lastSync = new Date("2026-05-30T03:00:00Z");
      const mockPrisma = {
        indexerCheckpoint: {
          findUnique: async () => ({
            id: "singleton",
            latestLedger: 45000,
            lastProcessedEventId: "evt-45000",
            lastSyncTime: lastSync,
            lastError: null,
            lastSuccessSyncTime: lastSync
          })
        }
      } as any;

      const app = buildApp({ prisma: mockPrisma, internalSecret });
      const res = await app.inject({
        method: "GET",
        url: "/health/indexer"
      });

      expect(res.statusCode).toBe(200);
      const payload = res.json();
      expect(payload.data.status).toBeDefined();
      expect(payload.data.latest_ledger).toBe(45000);
      await app.close();
    });

    it("POST /internal/checkpoint rejects unauthorized requests", async () => {
      const mockPrisma = {} as any;
      const app = buildApp({ prisma: mockPrisma, internalSecret });

      const res = await app.inject({
        method: "POST",
        url: "/internal/checkpoint",
        payload: {
          latest_ledger: 50000,
          success: true
        }
      });

      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it("POST /internal/checkpoint updates checkpoint with correct auth secret", async () => {
      let calledUpsert = false;
      const mockPrisma = {
        indexerCheckpoint: {
          findUnique: async () => ({
            id: "singleton",
            latestLedger: 50000,
            lastProcessedEventId: "evt_50000",
            lastSyncTime: new Date(),
            lastError: null,
            lastSuccessSyncTime: new Date()
          }),
          upsert: async (args: any) => {
            calledUpsert = true;
            expect(args.create.latestLedger).toBe(51000);
            expect(args.create.lastProcessedEventId).toBe("evt_51000");
            expect(args.create.lastError).toBeNull();
            return { id: "singleton" };
          }
        }
      } as any;

      const app = buildApp({ prisma: mockPrisma, internalSecret });
      const res = await app.inject({
        method: "POST",
        url: "/internal/checkpoint",
        headers: {
          "x-internal-secret": internalSecret,
          "content-type": "application/json"
        },
        payload: {
          latest_ledger: 51000,
          last_processed_event_id: "evt_51000",
          success: true
        }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.updated).toBe(true);
      expect(calledUpsert).toBe(true);
      await app.close();
    });
  });
});
