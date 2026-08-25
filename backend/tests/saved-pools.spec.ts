import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

describe("Saved pools API", () => {
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

  const walletAddress = "GSAVED1234567890123456789012345678901234567890123456789";
  const samplePool = {
    pool_id: "pool-1",
    pool_name: "Test Pool",
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

  it("saves a pool and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: {
        wallet_address: walletAddress,
        pool: samplePool,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.saved.wallet_address).toBe(walletAddress);
    expect(body.data.saved.pool_id).toBe("pool-1");
    expect(body.data.saved.pool_name).toBe("Test Pool");
    expect(body.data.saved.status).toBe("open");
  });

  it("returns 200 on re-saving an already saved pool (upsert)", async () => {
    await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: walletAddress, pool: samplePool },
    });

    const res = await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: walletAddress, pool: samplePool },
    });

    expect(res.statusCode).toBe(200);
  });

  it("lists saved pools for a wallet", async () => {
    const pool2 = { ...samplePool, pool_id: "pool-2", pool_name: "Pool Two" };

    await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: walletAddress, pool: samplePool },
    });
    await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: walletAddress, pool: pool2 },
    });

    const res = await app.inject({
      method: "GET",
      url: `/saved-pools?wallet=${walletAddress}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(2);
    expect(res.json().data.map((p: any) => p.pool_id)).toEqual(
      expect.arrayContaining(["pool-1", "pool-2"])
    );
  });

  it("unsaves a pool", async () => {
    await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: walletAddress, pool: samplePool },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/saved-pools/pool-1?wallet=${walletAddress}`,
    });

    expect(del.statusCode).toBe(200);
    expect(del.json().data.deleted).toBe(1);

    const list = await app.inject({
      method: "GET",
      url: `/saved-pools?wallet=${walletAddress}`,
    });
    expect(list.json().data).toHaveLength(0);
  });

  it("returns empty list for wallet with no saved pools", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/saved-pools?wallet=${walletAddress}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("rejects save with missing wallet address", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { pool: samplePool },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects save with invalid pool data", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: {
        wallet_address: walletAddress,
        pool: { pool_id: "p1", pool_name: "Bad", status: "unknown" },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("isolates saved pools between different wallets", async () => {
    const walletB = "GSAVED9876543210987654321098765432109876543210987654321";

    await app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: walletAddress, pool: samplePool },
    });

    const resB = await app.inject({
      method: "GET",
      url: `/saved-pools?wallet=${walletB}`,
    });
    expect(resB.json().data).toHaveLength(0);
  });
});
