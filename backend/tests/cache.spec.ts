import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { CacheService } from "../src/services/cacheService.js";

type MockPrisma = {
  indexerCheckpoint: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  pendingEvent: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  cacheEntry: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  vault: {
    findUnique: ReturnType<typeof vi.fn>;
  };
  $wellKnown: boolean;
};

type MockLogger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

// Mock ioredis
const mockRedisInstance = {
  on: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
  del: vi.fn(),
  sscan: vi.fn(),
  hget: vi.fn(),
  sadd: vi.fn(),
  srem: vi.fn(),
  ping: vi.fn(),
  quit: vi.fn(),
};

vi.mock("ioredis", () => {
  return {
    Redis: vi.fn().mockImplementation(() => mockRedisInstance),
  };
});

describe("CacheService Fallback & Caching Logic Tests", () => {
  let mockPrisma: MockPrisma;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockPrisma = {
      indexerCheckpoint: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      pendingEvent: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      cacheEntry: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        upsert: vi.fn(),
        deleteMany: vi.fn(),
      },
      cacheRepairRun: {
        create: vi.fn().mockResolvedValue({ id: "repair-run-1" }),
        update: vi.fn().mockResolvedValue({})
      },
      vault: {
        findUnique: vi.fn(),
      },
      $wellKnown: true,
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    vi.clearAllMocks();
  });

  it("falls back to PostgreSQL when Redis is offline", async () => {
    // Instantiate CacheService
    const service = new CacheService(
      mockPrisma as unknown as PrismaClient,
      mockLogger as unknown as Logger,
      "redis://127.0.0.1:6379",
    );

    // Simulate offline state: isOnline is set to false because connection failed (we can trigger error callback)
    const errorCallback = mockRedisInstance.on.mock.calls.find(
      (c) => c[0] === "error",
    )?.[1];
    if (errorCallback) {
      errorCallback(new Error("Connection refused"));
    }

    mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
      id: "singuleton",
      latestLedger: 9999,
    });

    const checkpoint = await service.getCheckpoint();

    // Redis get should NOT be called (or if it fails/offline, fallback happens)
    expect(checkpoint?.latestLedger).toBe(9999);
    expect(mockPrisma.indexerCheckpoint.findUnique).toHaveBeenCalledTimes(1);
  });

  it("uses Redis cache when online", async () => {
    const service = new CacheService(
      mockPrisma as unknown as PrismaClient,
      mockLogger as unknown as Logger,
      "redis://127.0.0.1:6379",
    );

    // Simulate online state
    const connectCallback = mockRedisInstance.on.mock.calls.find(
      (c) => c[0] === "connect",
    )?.[1];
    if (connectCallback) {
      connectCallback();
    }

    // Set mock data in Redis
    mockRedisInstance.get.mockImplementation(async (key: string) => {
      if (key === "indexer:checkpoint") {
        return JSON.stringify({
          latestLedger: 54321,
          lastSyncTime: new Date().toISOString(),
          lastSuccessSyncTime: new Date().toISOString(),
          lastError: null,
        });
      }
      return null;
    });

    const checkpoint = await service.getCheckpoint();

    expect(checkpoint?.latestLedger).toBe(54321);
    // Database query is offloaded! Prisma findUnique should NOT be called.
    expect(mockPrisma.indexerCheckpoint.findUnique).not.toHaveBeenCalled();
  });

  it("caches pending events and handles write-through/invalidation", async () => {
    const service = new CacheService(
      mockPrisma as unknown as PrismaClient,
      mockLogger as unknown as Logger,
      "redis://127.0.0.1:6379",
    );

    // Simulate online state
    const connectCallback = mockRedisInstance.on.mock.calls.find(
      (c) => c[0] === "connect",
    )?.[1];
    if (connectCallback) {
      connectCallback();
    }

    const txHash = "0xabc123";
    const pendingEvent: Parameters<CacheService["setPendingEvent"]>[0] = {
      txHash,
      sorobanEventId: "evt_1",
      eventPayload: { amount: 50 },
      statusHint: "confirmed",
      receivedAt: new Date(),
      consumedAt: null,
    };

    // setPendingEvent writes-through to both database and cache
    await service.setPendingEvent(pendingEvent);

    expect(mockPrisma.pendingEvent.upsert).toHaveBeenCalledTimes(1);
    expect(mockRedisInstance.set).toHaveBeenCalledTimes(1); // caches active event

    // Simulate event being consumed (consumedAt is set)
    pendingEvent.consumedAt = new Date();
    await service.setPendingEvent(pendingEvent);

    // Deletes from cache because it is consumed
    expect(mockRedisInstance.del).toHaveBeenCalled();
  });

  describe("stale cache detection and repair", () => {
    it("detects source-version drift and returns an actionable, scoped finding", async () => {
      const service = new CacheService(mockPrisma, mockLogger);
      await service.setAssetMetadata({
        asset: "USDC",
        decimals: 7,
        lastUpdated: new Date(),
        version: 3,
      });
      await service.markSourceVersion("asset:USDC", 4);

      const result = await service.detectStale({ kind: "asset_metadata" });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        key: "asset:USDC",
        reason: "drift",
        sourceVersion: 4,
        cachedVersion: 3,
        recommendation: "invalidate_and_refetch",
    it("detects a cache hit with matching source version", async () => {
      const service = new CacheService(
        mockPrisma,
        mockLogger,
        "redis://127.0.0.1:6379",
      );
      const connectCallback = mockRedisInstance.on.mock.calls.find(
        (c) => c[0] === "connect",
      )?.[1];
      if (connectCallback) {
        connectCallback();
      }

      mockPrisma.cacheEntry.findUnique.mockResolvedValue({
        key: "vault:v1:summary",
        sourceVersion: 7,
        payload: { totalDeposits: 1000 },
        updatedAt: new Date(),
      });
      expect(await service.detectStale({ kind: "protocol_config" })).toHaveLength(0);
    });

    it("scans a bounded Redis page and audits targeted invalidation", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((call) => call[0] === "connect")?.[1];
      connectCallback?.();
      mockRedisInstance.sscan.mockResolvedValueOnce(["12", ["vault:rollup:1"]]);
      mockRedisInstance.get.mockResolvedValueOnce(JSON.stringify({ version: 2 }));
      mockRedisInstance.hget.mockResolvedValueOnce("5");

      const inspection = await service.inspectStale({ kind: "generic", limit: 1 });
      const findings = inspection.entries;
      expect(inspection).toMatchObject({ scanned: 1, complete: false });
      expect(findings).toMatchObject([
        {
          key: "vault:rollup:1",
          sourceVersion: 5,
          cachedVersion: 2,
          recommendation: "invalidate_and_refetch",
        },
      const result = await service.detectStaleEntries([
        { key: "vault:v1:summary", sourceVersion: 7 },
      ]);
      expect(mockRedisInstance.sscan).toHaveBeenCalledWith(
        "vaultquest:cache:index",
        "0",
        "COUNT",
        1,
      );

      mockRedisInstance.get.mockResolvedValueOnce(JSON.stringify({ version: 2 }));
      mockRedisInstance.hget.mockResolvedValueOnce("5");
      const result = await service.repairStaleCache({
        dryRun: false,
        kind: "generic",
        keys: ["vault:rollup:1"],
      });
      expect(result.repaired).toEqual(["vault:rollup:1"]);
      expect(mockRedisInstance.del).toHaveBeenCalledWith("vault:rollup:1");
      expect(mockRedisInstance.srem).toHaveBeenCalledWith(
        "vaultquest:cache:index",
        "vault:rollup:1",
      );
      expect(mockPrisma.cacheRepairRun.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.cacheRepairRun.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ repairedCount: 1, failedCount: 0 }),
        }),
      );
    });

    it("detects and invalidates a checkpoint that lags PostgreSQL without touching dirty writes", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((call) => call[0] === "connect")?.[1];
      connectCallback?.();
      const sourceCheckpoint = {
        id: "singleton",
        latestLedger: 5,
        lastProcessedEventId: "event-5",
        lastSyncTime: new Date("2026-10-01T00:00:00.000Z"),
        lastSuccessSyncTime: new Date("2026-10-01T00:00:00.000Z"),
        lastError: null,
        indexerVersion: "v1",
      };
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue(sourceCheckpoint);
      mockRedisInstance.eval.mockResolvedValue(1);
      const staleCheckpoint = JSON.stringify({
        latestLedger: 4,
        lastProcessedEventId: "event-4",
        lastSyncTime: "2026-09-30T00:00:00.000Z",
        indexerVersion: "v1",
      });
      mockRedisInstance.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(staleCheckpoint)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(staleCheckpoint);

      const findings = await service.detectStale({ kind: "checkpoint" });
      expect(findings).toMatchObject([
        {
          key: "indexer:checkpoint",
          sourceVersion: 5,
          cachedVersion: 4,
          recommendation: "invalidate_and_refetch",
        },
      ]);

      const result = await service.repairStaleCache({
        dryRun: false,
        kind: "checkpoint",
    it("detects a stale cache entry when source version differs", async () => {
      const service = new CacheService(
        mockPrisma,
        mockLogger,
        "redis://127.0.0.1:6379",
      );
      const connectCallback = mockRedisInstance.on.mock.calls.find(
        (c) => c[0] === "connect",
      )?.[1];
      if (connectCallback) {
        connectCallback();
      }

      mockPrisma.cacheEntry.findUnique.mockResolvedValue({
        key: "vault:v1:summary",
        sourceVersion: 3,
        payload: { totalDeposits: 500 },
        updatedAt: new Date(),
      });
      expect(result.repaired).toEqual(["indexer:checkpoint"]);
      expect(mockRedisInstance.eval).toHaveBeenCalled();
    });

    it("atomically defers checkpoint eviction if a write-behind update races with repair", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((call) => call[0] === "connect")?.[1];
      connectCallback?.();
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
        id: "singleton",
        latestLedger: 5,
        lastProcessedEventId: "event-5",
        lastSyncTime: new Date("2026-10-01T00:00:00.000Z"),
        lastSuccessSyncTime: new Date("2026-10-01T00:00:00.000Z"),
        lastError: null,
        indexerVersion: "v1",
      });
      mockRedisInstance.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(JSON.stringify({
          latestLedger: 4,
          lastProcessedEventId: "event-4",
          lastSyncTime: "2026-09-30T00:00:00.000Z",
          indexerVersion: "v1",
        }));
      mockRedisInstance.eval.mockResolvedValue(0);

      const result = await service.repairStaleCache({
        dryRun: false,
        kind: "checkpoint",
      });
      const result = await service.detectStaleEntries([
        { key: "vault:v1:summary", sourceVersion: 7 },
      ]);

      expect(result.repaired).toHaveLength(0);
      expect(result.failed).toMatchObject([
        { key: "indexer:checkpoint", error: expect.stringContaining("deferred") },
      ]);
      expect(mockRedisInstance.eval).toHaveBeenCalled();
      expect(mockRedisInstance.del).not.toHaveBeenCalledWith("indexer:checkpoint");
    });

    it("does not classify a write-behind checkpoint as stale before database sync", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((call) => call[0] === "connect")?.[1];
      connectCallback?.();
      mockRedisInstance.get.mockResolvedValueOnce("true");
    it("reports a missing cache entry as stale", async () => {
      const service = new CacheService(
        mockPrisma,
        mockLogger,
        "redis://127.0.0.1:6379",
      );
      const connectCallback = mockRedisInstance.on.mock.calls.find(
        (c) => c[0] === "connect",
      )?.[1];
      if (connectCallback) {
        connectCallback();
      }

      const findings = await service.detectStale({ kind: "checkpoint" });

      expect(findings).toHaveLength(0);
      expect(mockPrisma.indexerCheckpoint.findUnique).not.toHaveBeenCalled();
    });
      const result = await service.detectStaleEntries([
        { key: "vault:v1:summary", sourceVersion: 7 },
      ]);

    it("requires manual review for a malformed checkpoint payload", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((call) => call[0] === "connect")?.[1];
      connectCallback?.();
      mockRedisInstance.get
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("{invalid");

      const result = await service.repairStaleCache({
        dryRun: false,
        kind: "checkpoint",
      });

      expect(result.stale).toMatchObject([
        { key: "indexer:checkpoint", recommendation: "review_before_repair" },
      ]);
      expect(result.failed).toMatchObject([
        { key: "indexer:checkpoint", error: "checkpoint cache payload is invalid" },
      ]);
      expect(mockRedisInstance.eval).not.toHaveBeenCalled();
    });

    it("writes the checkpoint and dirty marker in one atomic Redis operation", async () => {
      const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
      const connectCallback = mockRedisInstance.on.mock.calls.find((call) => call[0] === "connect")?.[1];
      connectCallback?.();
      mockRedisInstance.eval.mockResolvedValue(1);
      const checkpoint = {
        latestLedger: 7,
        lastProcessedEventId: "event-7",
        lastSyncTime: new Date("2026-10-01T00:00:00.000Z"),
        lastSuccessSyncTime: new Date("2026-10-01T00:00:00.000Z"),
        lastError: null,
      };

      await service.setCheckpoint(checkpoint);

      expect(mockRedisInstance.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("SET", KEYS[1], "true")'),
        2,
        "indexer:checkpoint:dirty",
        "indexer:checkpoint",
        expect.stringContaining('"latestLedger":7'),
      );
      expect(mockPrisma.indexerCheckpoint.upsert).not.toHaveBeenCalled();
    });

    it("uses the source timestamp rather than recent cache access to detect age", async () => {
      const service = new CacheService(mockPrisma, mockLogger);
      await service.setAssetMetadata({
        asset: "XLM",
        decimals: 7,
        lastUpdated: new Date("2020-01-01T00:00:00.000Z"),
    it("repair job is idempotent and supports dry-run", async () => {
      const service = new CacheService(
        mockPrisma,
        mockLogger,
        "redis://127.0.0.1:6379",
      );
      const connectCallback = mockRedisInstance.on.mock.calls.find(
        (c) => c[0] === "connect",
      )?.[1];
      if (connectCallback) {
        connectCallback();
      }

      mockPrisma.cacheEntry.findUnique.mockResolvedValue({
        key: "vault:v1:summary",
        sourceVersion: 3,
        payload: { totalDeposits: 500 },
        updatedAt: new Date(),
      });

      const result = await service.detectStale({ now: new Date("2020-01-01T00:06:00.000Z") });
      const dryRun = await service.repairStaleEntries(
        [
          {
            key: "vault:v1:summary",
            sourceVersion: 7,
            payload: { totalDeposits: 1000 },
          },
        ],
        { dryRun: true },
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ reason: "stale" });
    });

    it("keeps dry-run read-only and makes eviction idempotent", async () => {
      const service = new CacheService(mockPrisma, mockLogger);
      await service.setAssetMetadata({
        asset: "USDC",
        decimals: 7,
        lastUpdated: new Date("2020-01-01T00:00:00.000Z"),
      });
      const applied = await service.repairStaleEntries(
        [
          {
            key: "vault:v1:summary",
            sourceVersion: 7,
            payload: { totalDeposits: 1000 },
          },
        ],
        { dryRun: false },
      );

      const dryRun = await service.repairStaleCache({
        dryRun: true,
        now: new Date("2020-01-01T00:06:00.000Z"),
      });
      expect(dryRun.repaired).toHaveLength(0);
      expect(await service.getAssetMetadata("USDC")).not.toBeNull();

      const applied = await service.repairStaleCache({
        dryRun: false,
        now: new Date("2020-01-01T00:06:00.000Z"),
      });
      expect(applied.repaired).toEqual(["asset:USDC"]);
      expect(await service.getAssetMetadata("USDC")).toBeNull();
      // Idempotency: a repeated repair of an already-current entry is a no-op.
      mockPrisma.cacheEntry.findUnique.mockResolvedValue({
        key: "vault:v1:summary",
        sourceVersion: 7,
        payload: { totalDeposits: 1000 },
        updatedAt: new Date(),
      });
      const second = await service.repairStaleEntries(
        [
          {
            key: "vault:v1:summary",
            sourceVersion: 7,
            payload: { totalDeposits: 1000 },
          },
        ],
        { dryRun: false },
      );

      const repeated = await service.repairStaleCache({
        dryRun: false,
        now: new Date("2020-01-01T00:06:00.000Z"),
      });
      expect(repeated.stale).toHaveLength(0);
      expect(repeated.failed).toHaveLength(0);
    });

    it("does not persist successful no-op automatic sweeps", async () => {
      const service = new CacheService(mockPrisma, mockLogger);
      const result = await service.repairStaleCache({
        dryRun: false,
        auditNoop: false,
      });

      expect(result.scanned).toBe(0);
      expect(mockPrisma.cacheRepairRun.create).not.toHaveBeenCalled();
    });
    it("reports a repair failure without throwing", async () => {
      const service = new CacheService(
        mockPrisma,
        mockLogger,
        "redis://127.0.0.1:6379",
      );
      const connectCallback = mockRedisInstance.on.mock.calls.find(
        (c) => c[0] === "connect",
      )?.[1];
      if (connectCallback) {
        connectCallback();
      }

      mockPrisma.cacheEntry.findUnique.mockResolvedValue(null);
      mockPrisma.cacheEntry.upsert.mockRejectedValue(
        new Error("db write failed"),
      );

      const result = await service.repairStaleEntries(
        [
          {
            key: "vault:v1:summary",
            sourceVersion: 7,
            payload: { totalDeposits: 1000 },
          },
        ],
        { dryRun: false },
      );

    it("does not mutate cache when the repair audit cannot be started", async () => {
      const service = new CacheService(mockPrisma, mockLogger);
      await service.setAssetMetadata({
        asset: "USDC",
        decimals: 7,
        lastUpdated: new Date("2020-01-01T00:00:00.000Z"),
      });
      mockPrisma.cacheRepairRun.create.mockRejectedValueOnce(
        new Error("audit database unavailable"),
      );

      await expect(
        service.repairStaleCache({
          dryRun: false,
          now: new Date("2020-01-01T00:06:00.000Z"),
        }),
      ).rejects.toThrow("audit database unavailable");
      expect(await service.getAssetMetadata("USDC")).not.toBeNull();
    });
  });
});
