/**
 * saved-pools-auth.spec.ts
 *
 * Cross-user authorization, wallet-scoped isolation, and cache-key regression
 * tests for the saved pools feature (issue #364).
 *
 * Design invariant: a saved pool record is identified by
 * (walletAddress, poolId). All reads and mutations MUST be scoped to the
 * requesting wallet — Wallet A must never see, modify, or evict Wallet B's
 * records.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

// ── Shared fixtures ────────────────────────────────────────────────────────────

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
const WALLET_C = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF";

const poolFixture = (overrides: Partial<{
  pool_id: string;
  pool_name: string;
  status: "open" | "locked" | "drawing" | "settled";
}> = {}) => ({
  pool_id: overrides.pool_id ?? "pool-shared",
  pool_name: overrides.pool_name ?? "Shared Pool",
  status: overrides.status ?? ("open" as const),
  tvl: "50000",
  asset: "USDC",
  participant_count: 10,
  expected_yield: "4.0% APY",
  prize: "1000 USDC",
  opens_at: "2026-01-01T00:00:00.000Z",
  locks_at: "2026-06-01T00:00:00.000Z",
  draws_at: "2026-07-01T00:00:00.000Z",
});

async function save(app: FastifyInstance, wallet: string, pool_id: string, extra = {}) {
  return app.inject({
    method: "POST",
    url: "/saved-pools",
    headers: { "content-type": "application/json" },
    payload: { wallet_address: wallet, pool: poolFixture({ pool_id, ...extra }) },
  });
}

async function list(app: FastifyInstance, wallet: string) {
  return app.inject({ method: "GET", url: `/saved-pools?wallet=${wallet}` });
}

async function del(app: FastifyInstance, wallet: string, pool_id: string) {
  return app.inject({ method: "DELETE", url: `/saved-pools/${pool_id}?wallet=${wallet}` });
}

// ── Test suite ─────────────────────────────────────────────────────────────────

describe("Saved pools — cross-user authorization and wallet isolation", () => {
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

  // ── List isolation ───────────────────────────────────────────────────────────

  it("wallet A listing returns only wallet A's pools, not wallet B's", async () => {
    await save(app, WALLET_A, "pool-a-only");
    await save(app, WALLET_B, "pool-b-only");

    const resA = await list(app, WALLET_A);
    expect(resA.statusCode).toBe(200);
    const idsA = resA.json().data.map((p: any) => p.pool_id);
    expect(idsA).toContain("pool-a-only");
    expect(idsA).not.toContain("pool-b-only");
  });

  it("wallet B listing returns only wallet B's pools, not wallet A's", async () => {
    await save(app, WALLET_A, "pool-a-only");
    await save(app, WALLET_B, "pool-b-only");

    const resB = await list(app, WALLET_B);
    const idsB = resB.json().data.map((p: any) => p.pool_id);
    expect(idsB).toContain("pool-b-only");
    expect(idsB).not.toContain("pool-a-only");
  });

  it("both wallets can independently save the same pool id", async () => {
    await save(app, WALLET_A, "pool-shared");
    await save(app, WALLET_B, "pool-shared");

    const resA = await list(app, WALLET_A);
    const resB = await list(app, WALLET_B);

    expect(resA.json().data).toHaveLength(1);
    expect(resA.json().data[0].pool_id).toBe("pool-shared");
    expect(resB.json().data).toHaveLength(1);
    expect(resB.json().data[0].pool_id).toBe("pool-shared");
  });

  it("wallet A saving a pool does not appear in wallet B's list", async () => {
    const resBefore = await list(app, WALLET_B);
    expect(resBefore.json().data).toHaveLength(0);

    await save(app, WALLET_A, "pool-a-exclusive");

    const resAfter = await list(app, WALLET_B);
    expect(resAfter.json().data).toHaveLength(0);
  });

  it("three wallets with overlapping and unique pools each see only their own", async () => {
    await save(app, WALLET_A, "pool-shared");
    await save(app, WALLET_A, "pool-a-only");
    await save(app, WALLET_B, "pool-shared");
    await save(app, WALLET_B, "pool-b-only");
    await save(app, WALLET_C, "pool-c-only");

    const aIds = (await list(app, WALLET_A)).json().data.map((p: any) => p.pool_id);
    const bIds = (await list(app, WALLET_B)).json().data.map((p: any) => p.pool_id);
    const cIds = (await list(app, WALLET_C)).json().data.map((p: any) => p.pool_id);

    expect(aIds.sort()).toEqual(["pool-a-only", "pool-shared"].sort());
    expect(bIds.sort()).toEqual(["pool-b-only", "pool-shared"].sort());
    expect(cIds).toEqual(["pool-c-only"]);
  });

  // ── Delete isolation / cross-wallet authorization ────────────────────────────

  it("wallet A deleting with wallet B's pool id does not remove wallet B's record", async () => {
    await save(app, WALLET_B, "pool-b-target");

    // Wallet A attempts to delete pool-b-target using its own wallet scope
    const delRes = await del(app, WALLET_A, "pool-b-target");
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().data.deleted).toBe(0); // nothing deleted — wallet A has no such record

    // Wallet B's record must still be there
    const resB = await list(app, WALLET_B);
    expect(resB.json().data.map((p: any) => p.pool_id)).toContain("pool-b-target");
  });

  it("wallet A deleting its own copy of a shared pool does not remove wallet B's copy", async () => {
    await save(app, WALLET_A, "pool-shared");
    await save(app, WALLET_B, "pool-shared");

    await del(app, WALLET_A, "pool-shared");

    const resA = await list(app, WALLET_A);
    const resB = await list(app, WALLET_B);

    expect(resA.json().data).toHaveLength(0);
    expect(resB.json().data.map((p: any) => p.pool_id)).toContain("pool-shared");
  });

  it("deleting a non-existent pool for a wallet returns deleted: 0", async () => {
    const res = await del(app, WALLET_A, "does-not-exist");
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(0);
  });

  it("wallet B cannot unilaterally clear all of wallet A's saved pools via sequential deletes", async () => {
    await save(app, WALLET_A, "pool-1");
    await save(app, WALLET_A, "pool-2");
    await save(app, WALLET_A, "pool-3");

    // Wallet B fires deletes for wallet A's known pool ids — scoped to wallet B
    for (const pid of ["pool-1", "pool-2", "pool-3"]) {
      const res = await del(app, WALLET_B, pid);
      expect(res.json().data.deleted).toBe(0);
    }

    const resA = await list(app, WALLET_A);
    expect(resA.json().data).toHaveLength(3);
  });

  // ── Cache-key wallet scoping (SavedPoolsService unit tests) ─────────────────
  //
  // The service layer queries the DB using walletAddress as a required filter.
  // These tests assert the wallet scope at the service level, verifying the
  // underlying query never leaks records across wallets.

  it("service listSavedPools is scoped: different wallet address returns empty list", async () => {
    await save(app, WALLET_A, "pool-a");

    // Query DB via API with a completely different wallet
    const res = await list(app, "GNEWWALLET11111111111111111111111111111111111111111111");
    expect(res.json().data).toHaveLength(0);
  });

  it("service listSavedPools returns all records for the correct wallet", async () => {
    const poolIds = ["pool-x", "pool-y", "pool-z"];
    for (const id of poolIds) {
      await save(app, WALLET_A, id);
    }

    const res = await list(app, WALLET_A);
    const ids = res.json().data.map((p: any) => p.pool_id).sort();
    expect(ids).toEqual(poolIds.sort());
  });

  // ── Eviction / invalidation isolation ────────────────────────────────────────
  //
  // Deleting or unsaving one wallet's records must not affect another wallet's
  // persisted rows. These tests serve as regression guards for any future
  // bulk-delete or cache-flush implementation.

  it("clearing all of wallet A's saved pools does not evict wallet B's pools", async () => {
    await save(app, WALLET_A, "pool-1");
    await save(app, WALLET_A, "pool-2");
    await save(app, WALLET_B, "pool-1");
    await save(app, WALLET_B, "pool-3");

    // Delete all wallet A pools
    for (const pid of ["pool-1", "pool-2"]) {
      await del(app, WALLET_A, pid);
    }

    const resA = await list(app, WALLET_A);
    const resB = await list(app, WALLET_B);

    expect(resA.json().data).toHaveLength(0);
    expect(resB.json().data).toHaveLength(2);
    const bIds = resB.json().data.map((p: any) => p.pool_id).sort();
    expect(bIds).toEqual(["pool-1", "pool-3"].sort());
  });

  it("invalidating wallet A's pool does not change wallet B's pool count", async () => {
    await save(app, WALLET_A, "pool-shared");
    await save(app, WALLET_B, "pool-shared");
    await save(app, WALLET_B, "pool-b-extra");

    await del(app, WALLET_A, "pool-shared"); // evict from wallet A

    const resB = await list(app, WALLET_B);
    expect(resB.json().data).toHaveLength(2);
  });

  it("re-saving a pool after deletion restores only that wallet's record", async () => {
    await save(app, WALLET_A, "pool-shared");
    await save(app, WALLET_B, "pool-shared");

    await del(app, WALLET_A, "pool-shared");

    // Re-save for wallet A
    const reSave = await save(app, WALLET_A, "pool-shared");
    expect(reSave.statusCode).toBe(201);

    const resA = await list(app, WALLET_A);
    const resB = await list(app, WALLET_B);

    expect(resA.json().data).toHaveLength(1);
    expect(resB.json().data).toHaveLength(1);
  });
});
