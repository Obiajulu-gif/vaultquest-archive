import type { PrismaClient, SavedPool } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { SavedPoolsService, type SavedPoolMetadataInput } from "../src/services/savedPools.js";
import { SavedPoolsCache } from "../src/services/savedPoolsCache.js";

const WALLET_A = "GA-ALICE-WALLET";
const WALLET_B = "GB-BOB-WALLET";

function pool(poolId: string, poolName = poolId): SavedPoolMetadataInput {
  return {
    poolId,
    poolName,
    status: "open",
    tvl: "10000",
    asset: "USDC",
    participantCount: 5,
    expectedYield: "5.2% APY",
    prize: "500 USDC",
    opensAt: new Date("2026-07-01T00:00:00.000Z"),
    locksAt: new Date("2026-07-31T00:00:00.000Z"),
    drawsAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

function createPrismaHarness() {
  const rows = new Map<string, SavedPool>();
  let sequence = 0;
  const key = (walletAddress: string, poolId: string) => `${walletAddress}:${poolId}`;

  const findUnique = vi.fn(async (args: any) => {
    const selector = args.where.walletAddress_poolId;
    return rows.get(key(selector.walletAddress, selector.poolId)) ?? null;
  });

  const upsert = vi.fn(async (args: any) => {
    const selector = args.where.walletAddress_poolId;
    const rowKey = key(selector.walletAddress, selector.poolId);
    const existing = rows.get(rowKey);
    const timestamp = new Date(`2026-07-15T00:00:${String(sequence).padStart(2, "0")}.000Z`);
    sequence += 1;

    const row: SavedPool = existing
      ? { ...existing, ...args.update, updatedAt: timestamp }
      : {
          id: `saved-${sequence}`,
          ...args.create,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    rows.set(rowKey, row);
    return row;
  });

  const deleteMany = vi.fn(async (args: any) => {
    const rowKey = key(args.where.walletAddress, args.where.poolId);
    const deleted = rows.delete(rowKey);
    return { count: deleted ? 1 : 0 };
  });

  const findMany = vi.fn(async (args: any) =>
    [...rows.values()]
      .filter((row) => row.walletAddress === args.where.walletAddress)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
  );

  const prisma = {
    savedPool: { findUnique, upsert, deleteMany, findMany },
  } as unknown as PrismaClient;

  return { prisma, rows, findUnique, upsert, deleteMany, findMany };
}

describe("SavedPoolsService wallet isolation", () => {
  it("keeps overlapping and unique pools scoped to their owning wallets", async () => {
    const harness = createPrismaHarness();
    const service = new SavedPoolsService(harness.prisma, new SavedPoolsCache());

    await service.savePool({ walletAddress: WALLET_A, pool: pool("shared", "Shared A") });
    await service.savePool({ walletAddress: WALLET_A, pool: pool("a-only") });
    await service.savePool({ walletAddress: WALLET_B, pool: pool("shared", "Shared B") });
    await service.savePool({ walletAddress: WALLET_B, pool: pool("b-only") });

    const alice = await service.listSavedPools(WALLET_A);
    const bob = await service.listSavedPools(WALLET_B);

    expect(alice.map((item) => item.poolId)).toEqual(expect.arrayContaining(["shared", "a-only"]));
    expect(bob.map((item) => item.poolId)).toEqual(expect.arrayContaining(["shared", "b-only"]));
    expect(alice.every((item) => item.walletAddress === WALLET_A)).toBe(true);
    expect(bob.every((item) => item.walletAddress === WALLET_B)).toBe(true);
    expect(alice.find((item) => item.poolId === "shared")?.poolName).toBe("Shared A");
    expect(bob.find((item) => item.poolId === "shared")?.poolName).toBe("Shared B");
  });

  it("does not let wallet A delete wallet B's record", async () => {
    const harness = createPrismaHarness();
    const service = new SavedPoolsService(harness.prisma, new SavedPoolsCache());

    await service.savePool({ walletAddress: WALLET_B, pool: pool("b-only") });

    expect(await service.unsavePool(WALLET_A, "b-only")).toBe(0);
    expect((await service.listSavedPools(WALLET_B)).map((item) => item.poolId)).toEqual(["b-only"]);
  });

  it("deletes an overlapping pool only for the requesting wallet", async () => {
    const harness = createPrismaHarness();
    const service = new SavedPoolsService(harness.prisma, new SavedPoolsCache());

    await service.savePool({ walletAddress: WALLET_A, pool: pool("shared") });
    await service.savePool({ walletAddress: WALLET_B, pool: pool("shared") });

    expect(await service.unsavePool(WALLET_A, "shared")).toBe(1);
    expect(await service.listSavedPools(WALLET_A)).toEqual([]);
    expect((await service.listSavedPools(WALLET_B)).map((item) => item.poolId)).toEqual(["shared"]);
  });

  it("serves wallet-qualified cache hits and invalidates only the mutated wallet", async () => {
    const harness = createPrismaHarness();
    const cache = new SavedPoolsCache();
    const service = new SavedPoolsService(harness.prisma, cache);

    await service.savePool({ walletAddress: WALLET_A, pool: pool("shared") });
    await service.savePool({ walletAddress: WALLET_B, pool: pool("shared") });

    await service.listSavedPools(WALLET_A);
    await service.listSavedPools(WALLET_B);
    expect(harness.findMany).toHaveBeenCalledTimes(2);

    // Both reads are now cache hits.
    await service.listSavedPools(WALLET_A);
    await service.listSavedPools(WALLET_B);
    expect(harness.findMany).toHaveBeenCalledTimes(2);

    await service.savePool({ walletAddress: WALLET_A, pool: pool("a-new") });
    expect(cache.hasWallet(WALLET_A)).toBe(false);
    expect(cache.hasWallet(WALLET_B)).toBe(true);

    // Bob remains a cache hit; only Alice is reloaded from persistence.
    await service.listSavedPools(WALLET_B);
    await service.listSavedPools(WALLET_A);
    expect(harness.findMany).toHaveBeenCalledTimes(3);
  });

  it("refreshes metadata without changing another wallet's overlapping record", async () => {
    const harness = createPrismaHarness();
    const service = new SavedPoolsService(harness.prisma, new SavedPoolsCache());

    await service.savePool({ walletAddress: WALLET_A, pool: pool("shared", "Alice v1") });
    await service.savePool({ walletAddress: WALLET_B, pool: pool("shared", "Bob pool") });
    const refreshed = await service.savePool({ walletAddress: WALLET_A, pool: pool("shared", "Alice v2") });

    expect(refreshed.created).toBe(false);
    expect(refreshed.record.poolName).toBe("Alice v2");
    expect((await service.listSavedPools(WALLET_B))[0]?.poolName).toBe("Bob pool");
  });
});
