import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { resetDb, startTestDb, type TestDb } from "./helpers/db.js";

const walletA = "GAUTHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const walletB = "GAUTHBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const pool = (pool_id: string) => ({
  pool_id,
  pool_name: `Pool ${pool_id}`,
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

async function save(app: FastifyInstance, wallet_address: string, poolId: string) {
  return app.inject({
    method: "POST",
    url: "/saved-pools",
    headers: { "content-type": "application/json" },
    payload: { wallet_address, pool: pool(poolId) },
  });
}

describe("saved pool wallet scoping regressions", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "test-secret" });
  });
  beforeEach(async () => resetDb(db.prisma));
  afterAll(async () => { await app.close(); await db.stop(); });

  it("keeps overlapping and unique pool saves isolated per wallet", async () => {
    await save(app, walletA, "shared");
    await save(app, walletA, "only-a");
    await save(app, walletB, "shared");
    await save(app, walletB, "only-b");

    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: `/saved-pools?wallet=${walletA}` }),
      app.inject({ method: "GET", url: `/saved-pools?wallet=${walletB}` }),
    ]);

    expect(a.json().data.map((entry: { pool_id: string }) => entry.pool_id).sort()).toEqual(["only-a", "shared"]);
    expect(b.json().data.map((entry: { pool_id: string }) => entry.pool_id).sort()).toEqual(["only-b", "shared"]);
  });

  it("does not let wallet A delete wallet B's saved pool", async () => {
    await save(app, walletB, "protected");

    const deletion = await app.inject({
      method: "DELETE",
      url: `/saved-pools/protected?wallet=${walletA}`,
    });
    expect(deletion.statusCode).toBe(200);
    expect(deletion.json().data.deleted).toBe(0);

    const b = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletB}` });
    expect(b.json().data).toHaveLength(1);
    expect(b.json().data[0].pool_id).toBe("protected");
  });

  it("evicts a deleted wallet entry without affecting the same pool in another wallet", async () => {
    await save(app, walletA, "shared");
    await save(app, walletB, "shared");

    await app.inject({ method: "DELETE", url: `/saved-pools/shared?wallet=${walletA}` });

    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: `/saved-pools?wallet=${walletA}` }),
      app.inject({ method: "GET", url: `/saved-pools?wallet=${walletB}` }),
    ]);
    expect(a.json().data).toEqual([]);
    expect(b.json().data).toHaveLength(1);
  });

  it("re-saving after eviction creates one fresh wallet-scoped record", async () => {
    await save(app, walletA, "retry");
    await app.inject({ method: "DELETE", url: `/saved-pools/retry?wallet=${walletA}` });
    const recreated = await save(app, walletA, "retry");

    expect(recreated.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/saved-pools?wallet=${walletA}` });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].pool_id).toBe("retry");
  });
});
