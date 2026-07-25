import type { SavedPool } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { SavedPoolsCache, savedPoolsCacheKey } from "../src/services/savedPoolsCache.js";

const WALLET_A = "GA-WALLET-A";
const WALLET_B = "GB-WALLET-B";
const WALLET_C = "GC-WALLET-C";

function record(walletAddress: string, poolId: string): SavedPool {
  const timestamp = new Date("2026-07-15T00:00:00.000Z");
  return {
    id: `${walletAddress}-${poolId}`,
    walletAddress,
    poolId,
    poolName: poolId,
    status: "open",
    tvl: "1000",
    asset: "USDC",
    participantCount: 1,
    expectedYield: "5% APY",
    prize: null,
    opensAt: null,
    locksAt: null,
    drawsAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("SavedPoolsCache", () => {
  it("qualifies every cache key with the wallet address", () => {
    expect(savedPoolsCacheKey(WALLET_A)).toBe(`saved-pools:${WALLET_A}`);
    expect(savedPoolsCacheKey(WALLET_B)).not.toBe(savedPoolsCacheKey(WALLET_A));
  });

  it("keeps overlapping pool ids isolated between wallets", () => {
    const cache = new SavedPoolsCache();
    cache.set(WALLET_A, [record(WALLET_A, "shared"), record(WALLET_A, "a-only")]);
    cache.set(WALLET_B, [record(WALLET_B, "shared"), record(WALLET_B, "b-only")]);

    expect(cache.get(WALLET_A)?.map((item) => item.poolId)).toEqual(["shared", "a-only"]);
    expect(cache.get(WALLET_B)?.map((item) => item.poolId)).toEqual(["shared", "b-only"]);
    expect(cache.get(WALLET_A)?.every((item) => item.walletAddress === WALLET_A)).toBe(true);
    expect(cache.get(WALLET_B)?.every((item) => item.walletAddress === WALLET_B)).toBe(true);
  });

  it("invalidates one wallet without flushing another wallet", () => {
    const cache = new SavedPoolsCache();
    cache.set(WALLET_A, [record(WALLET_A, "shared")]);
    cache.set(WALLET_B, [record(WALLET_B, "shared")]);

    cache.invalidateWallet(WALLET_A);

    expect(cache.get(WALLET_A)).toBeNull();
    expect(cache.get(WALLET_B)?.map((item) => item.poolId)).toEqual(["shared"]);
  });

  it("evicts the deterministic least-recently-used wallet entry", () => {
    const cache = new SavedPoolsCache({ maxEntries: 2 });
    cache.set(WALLET_A, [record(WALLET_A, "a")]);
    cache.set(WALLET_B, [record(WALLET_B, "b")]);

    // Touch A, making B the least recently used entry.
    expect(cache.get(WALLET_A)).not.toBeNull();
    cache.set(WALLET_C, [record(WALLET_C, "c")]);

    expect(cache.get(WALLET_B)).toBeNull();
    expect(cache.get(WALLET_A)).not.toBeNull();
    expect(cache.get(WALLET_C)).not.toBeNull();
    expect(cache.keys()).toEqual([
      savedPoolsCacheKey(WALLET_A),
      savedPoolsCacheKey(WALLET_C),
    ]);
  });

  it("expires stale wallet data without affecting a newer wallet entry", () => {
    let now = 0;
    const cache = new SavedPoolsCache({ ttlMs: 10, now: () => now });

    cache.set(WALLET_A, [record(WALLET_A, "stale")]);
    now = 5;
    cache.set(WALLET_B, [record(WALLET_B, "fresh")]);
    now = 11;

    expect(cache.get(WALLET_A)).toBeNull();
    expect(cache.get(WALLET_B)?.map((item) => item.poolId)).toEqual(["fresh"]);
    expect(cache.hasWallet(WALLET_B)).toBe(true);
  });

  it("returns defensive list copies", () => {
    const cache = new SavedPoolsCache();
    cache.set(WALLET_A, [record(WALLET_A, "pool-1")]);

    const first = cache.get(WALLET_A)!;
    first.push(record(WALLET_A, "mutated"));

    expect(cache.get(WALLET_A)?.map((item) => item.poolId)).toEqual(["pool-1"]);
  });
});
