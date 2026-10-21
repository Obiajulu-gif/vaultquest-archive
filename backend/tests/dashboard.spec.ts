import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import { createRequester, type Requester } from "./helpers/request.js";
import type { FastifyInstance } from "fastify";

describe("GET /dashboard/summary (#14)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let inject: Requester;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret: "test-secret" });
    inject = createRequester(app);
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  async function postAction(wallet: string, type = "deposit"): Promise<string> {
    const res = await inject({
      method: "POST",
      url: "/actions",
      headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: {
        wallet_address: wallet,
        action_type: type,
        action_payload: { vault_id: "1" }
      }
    });
    expect(res.statusCode).toBe(201);
    return res.json().data.id as string;
  }

  it("rejects requests without ?wallet=", async () => {
    const res = await inject({ method: "GET", url: "/dashboard/summary" });
    expect(res.statusCode).toBe(400);
  });

  it("returns zeroed summary for an unknown wallet", async () => {
    const res = await inject({
      method: "GET",
      url: "/dashboard/summary?wallet=GUNKNOWN"
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toMatchObject({
      wallet_address: "GUNKNOWN",
      total_actions: 0,
      pending_tx_hashes: [],
      is_stale: false,
      latest_activity_at: null,
      latest_confirmed_at: null
    });
    expect(body.data.by_status).toEqual({
      pending: 0,
      submitted: 0,
      confirmed: 0,
      failed: 0,
      reverted: 0,
      orphaned: 0
    });
  });

  it("aggregates by_status and surfaces in-flight tx hashes", async () => {
    const wallet = "GAGGREGATE";
    const a = await postAction(wallet);
    const b = await postAction(wallet);
    await postAction(wallet);

    // Move two actions through pending → submitted with tx hashes.
    await inject({
      method: "PATCH",
      url: `/actions/${a}/submitted`,
      payload: { tx_hash: "TX_A_HASH" }
    });
    await inject({
      method: "PATCH",
      url: `/actions/${b}/submitted`,
      payload: { tx_hash: "TX_B_HASH" }
    });

    const res = await inject({
      method: "GET",
      url: `/dashboard/summary?wallet=${wallet}`
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.total_actions).toBe(3);
    expect(body.by_status.submitted).toBe(2);
    expect(body.by_status.pending).toBe(1);
    expect(body.pending_tx_hashes).toHaveLength(2);
    expect(body.pending_tx_hashes).toEqual(
      expect.arrayContaining(["TX_A_HASH", "TX_B_HASH"])
    );
    expect(body.latest_activity_at).not.toBeNull();
  });

  it("flags is_stale=true when the most recent update predates stale_after_ms", async () => {
    const wallet = "GSTALE";
    await postAction(wallet);

    const res = await inject({
      method: "GET",
      url: `/dashboard/summary?wallet=${wallet}&stale_after_ms=0`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.is_stale).toBe(true);
  });

  it("does not leak other wallets' actions into the summary", async () => {
    await postAction("GA");
    await postAction("GA");
    await postAction("GB");

    const res = await inject({
      method: "GET",
      url: "/dashboard/summary?wallet=GA"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.total_actions).toBe(2);
  });
});
