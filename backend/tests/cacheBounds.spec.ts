import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import { CacheService } from "../src/services/cacheService.js";

function metadata(asset: string) {
  return { asset, decimals: 7, lastUpdated: new Date() };
}

describe("CacheService in-memory bounds", () => {
  const prisma = {} as PrismaClient;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts the least recently accessed entry once the bound is exceeded", async () => {
    const cache = new CacheService(prisma, logger, undefined, 2);

    await cache.setAssetMetadata(metadata("A"));
    vi.advanceTimersByTime(1000);
    await cache.setAssetMetadata(metadata("B"));
    vi.advanceTimersByTime(1000);
    expect(await cache.getAssetMetadata("A")).not.toBeNull();
    vi.advanceTimersByTime(1000);
    await cache.setAssetMetadata(metadata("C"));

    expect(await cache.getAssetMetadata("B")).toBeNull();
    expect(await cache.getAssetMetadata("A")).not.toBeNull();
    expect(await cache.getAssetMetadata("C")).not.toBeNull();
  });

  it("does not evict when an existing key is refreshed within the bound", async () => {
    const cache = new CacheService(prisma, logger, undefined, 2);

    await cache.setAssetMetadata(metadata("A"));
    await cache.setAssetMetadata(metadata("B"));
    vi.advanceTimersByTime(1000);
    await cache.setAssetMetadata(metadata("A"));

    expect(await cache.getAssetMetadata("A")).not.toBeNull();
    expect(await cache.getAssetMetadata("B")).not.toBeNull();
  });
});
