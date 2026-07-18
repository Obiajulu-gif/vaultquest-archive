import { describe, expect, it, vi } from "vitest";
import {
  SavedPoolsService,
  savedPoolsCacheKey,
  type SavedPoolRecord,
  type SavedPoolsCache,
} from "../src/services/savedPools.js";

function record(walletAddress: string, poolId: string): SavedPoolRecord {
  return { walletAddress, poolId, createdAt: new Date("2026-07-15T00:00:00Z") };
}

function setup() {
  const rows = [record("wallet-a", "shared"), record("wallet-a", "a-only"), record("wallet-b", "shared")];
  const prisma = {
    savedPool: {
      findUnique: vi.fn(async ({ where }) =>
        rows.find(
          (row) =>
            row.walletAddress === where.walletAddress_poolId.walletAddress &&
            row.poolId === where.walletAddress_poolId.poolId,
        ) ?? null,
      ),
      findMany: vi.fn(async ({ where }) => rows.filter((row) => row.walletAddress === where.walletAddress)),
      create: vi.fn(async ({ data }) => {
        const created = record(data.walletAddress, data.poolId);
        rows.push(created);
        return created;
      }),
      deleteMany: vi.fn(async ({ where }) => {
        const index = rows.findIndex(
          (row) => row.walletAddress === where.walletAddress && row.poolId === where.poolId,
        );
        if (index < 0) return { count: 0 };
        rows.splice(index, 1);
        return { count: 1 };
      }),
    },
  };
  const values = new Map<string, SavedPoolRecord[]>();
  const cache: SavedPoolsCache = {
    get: vi.fn(async (key) => values.get(key)),
    set: vi.fn(async (key, value) => void values.set(key, value)),
    delete: vi.fn(async (key) => void values.delete(key)),
  };
  return { service: new SavedPoolsService(prisma as never, cache), prisma, cache, values };
}

describe("SavedPoolsService wallet isolation", () => {
  it("uses wallet-scoped cache keys", () => {
    expect(savedPoolsCacheKey(" Wallet-A ")).toBe("saved-pools:wallet-a");
    expect(savedPoolsCacheKey("wallet-b")).not.toBe(savedPoolsCacheKey("wallet-a"));
  });

  it("never lists another wallet's overlapping saved pools", async () => {
    const { service } = setup();
    expect((await service.listSavedPools("wallet-a")).map((row) => row.poolId)).toEqual([
      "shared",
      "a-only",
    ]);
    expect((await service.listSavedPools("wallet-b")).map((row) => row.poolId)).toEqual(["shared"]);
  });

  it("cannot delete another wallet's saved pool", async () => {
    const { service } = setup();
    expect(await service.unsavePool("wallet-a", "shared")).toBe(1);
    expect((await service.listSavedPools("wallet-b")).map((row) => row.poolId)).toEqual(["shared"]);
  });

  it("evicts only the mutated wallet cache entry", async () => {
    const { service, values } = setup();
    await service.listSavedPools("wallet-a");
    await service.listSavedPools("wallet-b");

    await service.unsavePool("wallet-a", "a-only");

    expect(values.has(savedPoolsCacheKey("wallet-a"))).toBe(false);
    expect(values.has(savedPoolsCacheKey("wallet-b"))).toBe(true);
  });

  it("evicts stale list data after create without touching another wallet", async () => {
    const { service, values } = setup();
    await service.listSavedPools("wallet-a");
    await service.listSavedPools("wallet-b");

    await service.savePool({ walletAddress: "wallet-a", poolId: "new-pool" });

    expect(values.has(savedPoolsCacheKey("wallet-a"))).toBe(false);
    expect(values.get(savedPoolsCacheKey("wallet-b"))?.map((row) => row.poolId)).toEqual(["shared"]);
  });
});
