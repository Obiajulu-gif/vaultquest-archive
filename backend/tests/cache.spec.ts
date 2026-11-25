import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { CacheService } from "../src/services/cacheService.js";

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

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(() => mockRedisInstance),
}));

describe("CacheService fallback, caching, and stale repair", () => {
  let prisma: {
    indexerCheckpoint: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    pendingEvent: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
    cacheEntry: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      upsert: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
    cacheRepairRun: { create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    vault: { findUnique: ReturnType<typeof vi.fn> };
  };
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const serviceWithRedis = () => {
    const service = new CacheService(
      prisma as unknown as PrismaClient,
      logger as unknown as Logger,
      "redis://127.0.0.1:6379",
    );
    const connectCallback = mockRedisInstance.on.mock.calls.find(
      (call) => call[0] === "connect",
    )?.[1];
    connectCallback?.();
    return service;
  };

  beforeEach(() => {
    prisma = {
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
        update: vi.fn().mockResolvedValue({}),
      },
      vault: {
        findUnique: vi.fn(),
      },
    };
    logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    for (const mock of Object.values(mockRedisInstance)) mock.mockReset();
  });

  it("falls back to PostgreSQL when Redis is offline", async () => {
    const service = serviceWithRedis();
    const errorCallback = mockRedisInstance.on.mock.calls.find(
      (call) => call[0] === "error",
    )?.[1];
    errorCallback?.(new Error("Connection refused"));
    prisma.indexerCheckpoint.findUnique.mockResolvedValue({
      id: "singleton",
      latestLedger: 9999,
    });

    const checkpoint = await service.getCheckpoint();

    expect(checkpoint?.latestLedger).toBe(9999);
    expect(prisma.indexerCheckpoint.findUnique).toHaveBeenCalledOnce();
  });

  it("uses the Redis checkpoint when online", async () => {
    const service = serviceWithRedis();
    mockRedisInstance.get.mockResolvedValue(JSON.stringify({
      latestLedger: 54321,
      lastSyncTime: new Date().toISOString(),
      lastSuccessSyncTime: new Date().toISOString(),
      lastError: null,
    }));

    const checkpoint = await service.getCheckpoint();

    expect(checkpoint?.latestLedger).toBe(54321);
    expect(prisma.indexerCheckpoint.findUnique).not.toHaveBeenCalled();
  });

  it("persists pending events and invalidates consumed events", async () => {
    const service = serviceWithRedis();
    const event: Parameters<CacheService["setPendingEvent"]>[0] = {
      txHash: "0xabc123",
      sorobanEventId: "evt_1",
      eventPayload: { amount: 50 },
      statusHint: "confirmed",
      receivedAt: new Date(),
      consumedAt: null,
    };

    await service.setPendingEvent(event);
    expect(prisma.pendingEvent.upsert).toHaveBeenCalledOnce();
    expect(mockRedisInstance.set).toHaveBeenCalledOnce();

    event.consumedAt = new Date();
    await service.setPendingEvent(event);
    expect(mockRedisInstance.del).toHaveBeenCalled();
  });

  it("detects source-version drift with scoped repair recommendations", async () => {
    const service = new CacheService(
      prisma as unknown as PrismaClient,
      logger as unknown as Logger,
    );
    await service.setAssetMetadata({
      asset: "USDC",
      decimals: 7,
      lastUpdated: new Date("2026-10-01T00:00:00.000Z"),
      version: 3,
    });
    await service.markSourceVersion("asset:USDC", 4);

    const findings = await service.inspectStale({
      kind: "asset_metadata",
      now: new Date("2026-10-01T00:01:00.000Z"),
    });

    expect(findings.entries).toMatchObject([
      {
        key: "asset:USDC",
        reason: "drift",
        sourceVersion: 4,
        cachedVersion: 3,
        recommendation: "invalidate_and_refetch",
      },
    ]);
    expect((await service.detectStale({ kind: "protocol_config" }))).toEqual([]);
  });

  it("scans a bounded Redis page and audits targeted invalidation", async () => {
    const service = serviceWithRedis();
    mockRedisInstance.sscan.mockResolvedValueOnce(["12", ["vault:rollup:1"]]);
    mockRedisInstance.get.mockResolvedValueOnce(JSON.stringify({ version: 2 }));
    mockRedisInstance.hget.mockResolvedValueOnce("5");

    const inspection = await service.inspectStale({ kind: "generic", limit: 1 });

    expect(inspection).toMatchObject({
      scanned: 1,
      complete: false,
      entries: [{
        key: "vault:rollup:1",
        sourceVersion: 5,
        cachedVersion: 2,
        recommendation: "invalidate_and_refetch",
      }],
    });
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
    expect(prisma.cacheRepairRun.create).toHaveBeenCalledOnce();
    expect(prisma.cacheRepairRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ repairedCount: 1, failedCount: 0 }),
      }),
    );
  });

  it("allows a failed cache invalidation to succeed on retry", async () => {
    const service = serviceWithRedis();
    const key = "vault:rollup:retry";
    const options = { dryRun: false, kind: "generic" as const, keys: [key] };
    mockRedisInstance.get.mockResolvedValue(JSON.stringify({ version: 2 }));
    mockRedisInstance.hget.mockResolvedValue("5");
    mockRedisInstance.del.mockRejectedValueOnce(new Error("Redis temporarily unavailable"));

    const failedAttempt = await service.repairStaleCache(options);
    expect(failedAttempt.repaired).toEqual([]);
    expect(failedAttempt.failed).toMatchObject([
      { key, error: "Redis temporarily unavailable" },
    ]);

    mockRedisInstance.del.mockResolvedValueOnce(1);
    const retry = await service.repairStaleCache(options);

    expect(retry.failed).toEqual([]);
    expect(retry.repaired).toEqual([key]);
    expect(mockRedisInstance.del).toHaveBeenCalledTimes(2);
    expect(prisma.cacheRepairRun.create).toHaveBeenCalledTimes(2);
  });

  it("requires manual review and does not evict malformed cache payloads", async () => {
    const service = serviceWithRedis();
    mockRedisInstance.get.mockResolvedValueOnce("{invalid");
    mockRedisInstance.hget.mockResolvedValueOnce("5");

    const result = await service.repairStaleCache({
      dryRun: false,
      kind: "generic",
      keys: ["vault:malformed"],
    });

    expect(result.stale).toMatchObject([
      { key: "vault:malformed", recommendation: "review_before_repair" },
    ]);
    expect(result.failed).toMatchObject([
      { key: "vault:malformed", error: "cache payload is not valid JSON" },
    ]);
    expect(mockRedisInstance.del).not.toHaveBeenCalled();
  });

  it("defers checkpoint invalidation when a write-behind update races with repair", async () => {
    const service = serviceWithRedis();
    prisma.indexerCheckpoint.findUnique.mockResolvedValue({
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

    expect(result.repaired).toEqual([]);
    expect(result.failed).toMatchObject([
      { key: "indexer:checkpoint", error: expect.stringContaining("deferred") },
    ]);
    expect(mockRedisInstance.eval).toHaveBeenCalled();
    expect(mockRedisInstance.del).not.toHaveBeenCalledWith("indexer:checkpoint");
  });

  it("keeps dry-run read-only and makes stale-entry eviction idempotent", async () => {
    const service = new CacheService(
      prisma as unknown as PrismaClient,
      logger as unknown as Logger,
    );
    await service.setAssetMetadata({
      asset: "USDC",
      decimals: 7,
      lastUpdated: new Date("2020-01-01T00:00:00.000Z"),
    });

    const dryRun = await service.repairStaleCache({
      dryRun: true,
      now: new Date("2020-01-01T00:06:00.000Z"),
    });
    expect(dryRun.repaired).toEqual([]);
    expect(await service.getAssetMetadata("USDC")).not.toBeNull();

    const applied = await service.repairStaleCache({
      dryRun: false,
      now: new Date("2020-01-01T00:06:00.000Z"),
    });
    expect(applied.repaired).toEqual(["asset:USDC"]);
    expect(await service.getAssetMetadata("USDC")).toBeNull();

    const repeated = await service.repairStaleCache({
      dryRun: false,
      now: new Date("2020-01-01T00:06:00.000Z"),
    });
    expect(repeated.stale).toEqual([]);
    expect(repeated.failed).toEqual([]);
  });

  it("leaves cache data untouched when the repair audit cannot be started", async () => {
    const service = new CacheService(
      prisma as unknown as PrismaClient,
      logger as unknown as Logger,
    );
    await service.setAssetMetadata({
      asset: "USDC",
      decimals: 7,
      lastUpdated: new Date("2020-01-01T00:00:00.000Z"),
    });
    prisma.cacheRepairRun.create.mockRejectedValueOnce(
      new Error("audit database unavailable"),
    );

    await expect(service.repairStaleCache({
      dryRun: false,
      now: new Date("2020-01-01T00:06:00.000Z"),
    })).rejects.toThrow("audit database unavailable");
    expect(await service.getAssetMetadata("USDC")).not.toBeNull();
  });
});

}
);
