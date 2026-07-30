import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

describe("public /actions routes", () => {
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

  it("POST /actions requires Idempotency-Key", async () => {
    const res = await app.inject({
      method: "POST", url: "/actions",
      payload: { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "1" } }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("POST /actions creates a pending action", async () => {
    const key = randomUUID();
    const res = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "1" } }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.status).toBe("pending");
    expect(body.correlation_id).toBeDefined();
  });

  it("POST /actions returns 200 on idempotent replay", async () => {
    const key = randomUUID();
    const payload = { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "1" } };
    const first = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload
    });
    const second = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.id).toBe(first.json().data.id);
  });

  it("POST /actions returns 409 on key reuse with different payload", async () => {
    const key = randomUUID();
    const first = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "1" } }
    });
    const second = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "999" } }
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD");
  });

  it("PATCH /actions/:id/submitted transitions to submitted", async () => {
    const key = randomUUID();
    const create = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "1" } }
    });
    const id = create.json().data.id;
    const patch = await app.inject({
      method: "PATCH", url: `/actions/${id}/submitted`,
      headers: { "content-type": "application/json" },
      payload: { tx_hash: "tx_1" }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.status).toBe("submitted");
    expect(patch.json().data.tx_hash).toBe("tx_1");
  });

  it("POST /actions/:id/cancel transitions to failed", async () => {
    const key = randomUUID();
    const create = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "1" } }
    });
    const id = create.json().data.id;
    const cancel = await app.inject({
      method: "POST", url: `/actions/${id}/cancel`,
      headers: { "content-type": "application/json" },
      payload: { error_code: "WALLET_REJECTED", error_detail: "user denied" }
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().data.status).toBe("failed");
    expect(cancel.json().data.error_code).toBe("WALLET_REJECTED");
  });

  it("GET /actions/:id returns record", async () => {
    const key = randomUUID();
    const create = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GABC", action_type: "deposit", action_payload: { vault_id: "1" } }
    });
    const id = create.json().data.id;
    const get = await app.inject({ method: "GET", url: `/actions/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().data.id).toBe(id);
  });

  it("GET /actions lists by wallet", async () => {
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "POST", url: "/actions",
        headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
        payload: { wallet_address: "GWALLET", action_type: "deposit", action_payload: { i } }
      });
    }
    const list = await app.inject({ method: "GET", url: "/actions?wallet=GWALLET&limit=10" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(2);
    expect(list.json().meta.pagination).toMatchObject({ limit: 10, has_more: false, next_cursor: null });
  });

  it("GET /actions/export returns CSV with expected columns", async () => {
    const key = randomUUID();
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GEXPORT", action_type: "deposit", action_payload: { vault_id: "v1", amount: "100", token: "USDC" } }
    });
    const res = await app.inject({ method: "GET", url: "/actions/export?wallet=GEXPORT&format=csv" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const body = res.body;
    const lines = body.split("\n").filter((l: string) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toBe("id,date,action_type,pool_id,asset,amount,status,tx_hash,error_code,submitted_at,confirmed_at");
    expect(lines[1]).toContain("GEXPORT");
  });

  it("GET /actions/export returns empty CSV when no activity", async () => {
    const res = await app.inject({ method: "GET", url: "/actions/export?wallet=GNODATA&format=csv" });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n").filter((l: string) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("id,date,action_type,pool_id,asset,amount,status,tx_hash,error_code,submitted_at,confirmed_at");
  });

  it("GET /actions/export respects action_type filter", async () => {
    const key1 = randomUUID();
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key1, "content-type": "application/json" },
      payload: { wallet_address: "GFILTER", action_type: "deposit", action_payload: { vault_id: "v1" } }
    });
    const key2 = randomUUID();
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key2, "content-type": "application/json" },
      payload: { wallet_address: "GFILTER", action_type: "withdraw", action_payload: { vault_id: "v1" } }
    });
    const res = await app.inject({ method: "GET", url: "/actions/export?wallet=GFILTER&format=csv&action_type=deposit" });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n").filter((l: string) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("deposit");
  });

  it("GET /actions/export respects date range filter", async () => {
    const key = randomUUID();
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GDATE", action_type: "deposit", action_payload: { amount: "50" } }
    });
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    const res = await app.inject({ method: "GET", url: `/actions/export?wallet=GDATE&format=csv&from=${past}&to=${future}` });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n").filter((l: string) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("deposit");
  });

  it("GET /actions/export returns JSON when format is json", async () => {
    const key = randomUUID();
    await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GJSON", action_type: "deposit", action_payload: { vault_id: "v1" } }
    });
    const res = await app.inject({ method: "GET", url: "/actions/export?wallet=GJSON&format=json" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(1);
    expect(body.data[0].action_type).toBe("deposit");
  });

  it("DELETE /actions?wallet=G... scrubs payload", async () => {
    const key = randomUUID();
    const create = await app.inject({
      method: "POST", url: "/actions",
      headers: { "idempotency-key": key, "content-type": "application/json" },
      payload: { wallet_address: "GSCRUB", action_type: "deposit", action_payload: { secret: "hidden" } }
    });
    const id = create.json().data.id;
    const del = await app.inject({ method: "DELETE", url: "/actions?wallet=GSCRUB" });
    expect(del.statusCode).toBe(200);
    expect(del.json().data.scrubbed).toBe(1);

    const get = await app.inject({ method: "GET", url: `/actions/${id}` });
    expect(get.json().data.action_payload).toBeNull();
    expect(get.json().data.redacted_at).not.toBeNull();
  });
});
