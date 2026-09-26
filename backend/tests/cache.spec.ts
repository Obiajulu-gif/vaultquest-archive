import { describe, it, expect, vi, beforeEach } from "vitest";
import { CacheService } from "../src/services/cacheService.js";

// Mock ioredis
const mockRedisInstance = {
  on: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  ping: vi.fn(),
  quit: vi.fn()
};

vi.mock("ioredis", () => {
  return {
    Redis: vi.fn().mockImplementation(() => mockRedisInstance)
  };
});

describe("CacheService Fallback & Caching Logic Tests", () => {
  let mockPrisma: any;
  let mockLogger: any;

  beforeEach(() => {
    mockPrisma = {
      indexerCheckpoint: {
        findUnique: vi.fn(),
        upsert: vi.fn()
      },
      pendingEvent: {
        findUnique: vi.fn(),
        upsert: vi.fn()
      }
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    vi.clearAllMocks();
  });

  it("falls back to PostgreSQL when Redis is offline", async () => {
    // Instantiate CacheService
    const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
    
    // Simulate offline state: isOnline is set to false because connection failed (we can trigger error callback)
    const errorCallback = mockRedisInstance.on.mock.calls.find(c => c[0] === "error")?.[1];
    if (errorCallback) {
      errorCallback(new Error("Connection refused"));
    }

    mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
      id: "singleton",
      latestLedger: 9999
    });

    const checkpoint = await service.getCheckpoint();
    
    // Redis get should NOT be called (or if it fails/offline, fallback happens)
    expect(checkpoint?.latestLedger).toBe(9999);
    expect(mockPrisma.indexerCheckpoint.findUnique).toHaveBeenCalledTimes(1);
  });

  it("uses Redis cache when online", async () => {
    const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
    
    // Simulate online state
    const connectCallback = mockRedisInstance.on.mock.calls.find(c => c[0] === "connect")?.[1];
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
          lastError: null
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
    const service = new CacheService(mockPrisma, mockLogger, "redis://127.0.0.1:6379");
    
    // Simulate online state
    const connectCallback = mockRedisInstance.on.mock.calls.find(c => c[0] === "connect")?.[1];
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
      consumedAt: null
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
});
