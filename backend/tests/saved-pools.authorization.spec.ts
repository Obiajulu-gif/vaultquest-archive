import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { resetDb, startTestDb, type TestDb } from "./helpers/db.js";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBXQ";

const pool = (id: string, name = id) => ({
  pool_id: id,
  pool_name: name,
  status: "open" as const,
  tvl: "10000",
  asset: "USDC",
  participant_count: 5,
  expected_yield: "5.2% APY",
  prize: "500 USDC",
  opens_at: "2026-01-01T00:00:00.000Z",
  locks_at: "2026-06-01T00:00:00.000Z",
  draws_at: "2026-07-01T00:00:00.000Z",
});

describe("saved pools wallet scoping regressions", () => {
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

  async function save(wallet: string, poolId: string) {
    return app.inject({
      method: "POST",
      url: "/saved-pools",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: wallet, pool: pool(poolId) },
    });
  }

  async function list(wallet: string) {
    return app.inject({ method: "GET", url: `/saved-pools?wallet=${wallet}` });
  }

  it("keeps overlapping and wallet-specific pools isolated", async () => {
    await save(WALLET_A, "shared");
    await save(WALLET_A, "a-only");
    await save(WALLET_B, "shared");
    await save(WALLET_B, "b-only");

    const [a, b] = await Promise.all([list(WALLET_A), list(WALLET_B)]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().data.map((item: { pool_id: string }) => item.pool_id).sort()).toEqual([
      "a-only",
      "shared",
    ]);
    expect(b.json().data.map((item: { pool_id: string }) => item.pool_id).sort()).toEqual([
      "b-only",
      "shared",
    ]);
  });

  it("does not allow wallet A to delete wallet B's saved pool", async () => {
    await save(WALLET_B, "private-b");

    const deletion = await app.inject({
      method: "DELETE",
      url: `/saved-pools/private-b?wallet=${WALLET_A}`,
    });

    expect(deletion.statusCode).toBe(200);
    expect(deletion.json().data.deleted).toBe(0);
    expect((await list(WALLET_B)).json().data).toHaveLength(1);
  });

  it("evicts stale data only for the mutated wallet", async () => {
    await save(WALLET_A, "a-stale");
    await save(WALLET_B, "b-stable");

    // Prime both read paths before mutation. Implementations may use an in-memory
    // or distributed cache, but cache identity must include the wallet scope.
    expect((await list(WALLET_A)).json().data).toHaveLength(1);
    expect((await list(WALLET_B)).json().data).toHaveLength(1);

    await app.inject({
      method: "DELETE",
      url: `/saved-pools/a-stale?wallet=${WALLET_A}`,
    });

    expect((await list(WALLET_A)).json().data).toEqual([]);
    expect((await list(WALLET_B)).json().data.map((item: { pool_id: string }) => item.pool_id)).toEqual([
      "b-stable",
    ]);
  });

  it("re-saving after eviction creates one local record only", async () => {
    await save(WALLET_A, "retryable");
    await app.inject({
      method: "DELETE",
      url: `/saved-pools/retryable?wallet=${WALLET_A}`,
    });

    expect((await save(WALLET_A, "retryable")).statusCode).toBe(201);
    expect((await save(WALLET_A, "retryable")).statusCode).toBe(200);
    expect((await list(WALLET_A)).json().data).toHaveLength(1);
  });
});
