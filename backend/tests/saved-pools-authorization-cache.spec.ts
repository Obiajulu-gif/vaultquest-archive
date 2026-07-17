import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient, SavedPool } from "@prisma/client";
import { buildApp } from "../src/app.js";
import { SavedPoolsService, savedPoolsCacheKey } from "../src/services/savedPools.js";
import { resetDb, startTestDb, type TestDb } from "./helpers/db.js";

const walletA = "GAUTHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const walletB = "GAUTHBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function apiPool(poolId: string, poolName: string) {
  return {
    pool_id: poolId,
    pool_name: poolName,
    status: "open" as const,
    tvl: "10000",
    asset: "USDC",
    participant_count: 5,
    expected_yield: "5.2% APY",
    prize: "500 USDC",
    opens_at: "2026-01-01T00:00:00.000Z",
    locks_at: "2026-06-01T00:00:00.000Z",
    draws_at: "2026-07-01T00:00:00.000Z",
  };
}

async function save(app: FastifyInstance, wallet: string, poolId: string, name: string) {
  return app.inject({
    method: "POST",
    url: "/saved-pools",
    headers: { "content-type": "application/json" },
    payload: { wallet_address: wallet, pool: apiPool(poolId, name) },
  });
}

async function list(app: FastifyInstance, wallet: string) {
  const response = await app.inject({ method: "GET", url: `/saved-pools?wallet=${wallet}` });
  return response.json().data as Array<{ pool_id: string }>;
}

describe("saved pools cross-wallet authorization", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "test-secret" });
  });

  afterAll(async () => {
    await app.close();
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  it("isolates overlapping and wallet-specific pools on list/create/delete paths", async () => {
    expect((await save(app, walletA, "shared", "Shared pool")).statusCode).toBe(201);
    expect((await save(app, walletA, "a-only", "A only")).statusCode).toBe(201);
    expect((await save(app, walletB, "shared", "Shared pool")).statusCode).toBe(201);
    expect((await save(app, walletB, "b-only", "B only")).statusCode).toBe(201);

    expect((await list(app, walletA)).map((row) => row.pool_id).sort()).toEqual(["a-only", "shared"]);
    expect((await list(app, walletB)).map((row) => row.pool_id).sort()).toEqual(["b-only", "shared"]);

    const crossDelete = await app.inject({
      method: "DELETE",
      url: `/saved-pools/b-only?wallet=${walletA}`,
    });
    expect(crossDelete.statusCode).toBe(200);
    expect(crossDelete.json().data.deleted).toBe(0);
    expect((await list(app, walletB)).map((row) => row.pool_id).sort()).toEqual(["b-only", "shared"]);

    const deleteBShared = await app.inject({
      method: "DELETE",
      url: `/saved-pools/shared?wallet=${walletB}`,
    });
    expect(deleteBShared.json().data.deleted).toBe(1);
    expect((await list(app, walletA)).map((row) => row.pool_id).sort()).toEqual(["a-only", "shared"]);
    expect((await list(app, walletB)).map((row) => row.pool_id)).toEqual(["b-only"]);
  });
});

function row(walletAddress: string, poolId: string): SavedPool {
  return {
    id: `${walletAddress}:${poolId}`,
    walletAddress,
    poolId,
    poolName: poolId,
    status: "open",
    tvl: "100",
    asset: "USDC",
    participantCount: 1,
    expectedYield: "5%",
    prize: null,
    opensAt: null,
    locksAt: null,
    drawsAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function mockPrisma(rowsByWallet: Map<string, SavedPool[]>) {
  const findMany = vi.fn(async ({ where }: { where: { walletAddress: string } }) => [
    ...(rowsByWallet.get(where.walletAddress) ?? []),
  ]);
  const findUnique = vi.fn().mockResolvedValue(null);
  const upsert = vi.fn(async ({ create }: { create: SavedPool }) => create);
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });

  const prisma = {
    savedPool: { findMany, findUnique, upsert, deleteMany },
  } as unknown as PrismaClient;

  return { prisma, findMany, findUnique, upsert, deleteMany };
}

describe("SavedPoolsService wallet-scoped LRU cache", () => {
  it("includes the wallet in every cache key", () => {
    expect(savedPoolsCacheKey(walletA)).not.toBe(savedPoolsCacheKey(walletB));
    expect(savedPoolsCacheKey(walletA)).toBe(`saved-pools:${walletA}`);
  });

  it("evicts the least recently used wallet without flushing another wallet", async () => {
    const walletC = "GAUTHCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const mock = mockPrisma(
      new Map([
        [walletA, [row(walletA, "a")]],
        [walletB, [row(walletB, "b")]],
        [walletC, [row(walletC, "c")]],
      ]),
    );
    const service = new SavedPoolsService(mock.prisma, 2);

    await service.listSavedPools(walletA);
    await service.listSavedPools(walletB);
    await service.listSavedPools(walletA); // A becomes most recently used.
    await service.listSavedPools(walletC); // B is evicted.
    expect(mock.findMany).toHaveBeenCalledTimes(3);

    await service.listSavedPools(walletA);
    expect(mock.findMany).toHaveBeenCalledTimes(3);
    await service.listSavedPools(walletB);
    expect(mock.findMany).toHaveBeenCalledTimes(4);
  });

  it("invalidates only the mutated wallet and keeps other wallet reads hot", async () => {
    const rows = new Map([
      [walletA, [row(walletA, "a")]],
      [walletB, [row(walletB, "b")]],
    ]);
    const mock = mockPrisma(rows);
    const service = new SavedPoolsService(mock.prisma, 2);

    await service.listSavedPools(walletA);
    await service.listSavedPools(walletB);
    expect(mock.findMany).toHaveBeenCalledTimes(2);

    await service.savePool({
      walletAddress: walletA,
      pool: {
        poolId: "new-a",
        poolName: "New A",
        status: "open",
        tvl: "1",
        asset: "USDC",
        participantCount: 1,
        expectedYield: "5%",
        prize: null,
        opensAt: null,
        locksAt: null,
        drawsAt: null,
      },
    });

    await service.listSavedPools(walletB);
    expect(mock.findMany).toHaveBeenCalledTimes(2);
    await service.listSavedPools(walletA);
    expect(mock.findMany).toHaveBeenCalledTimes(3);
  });
});
