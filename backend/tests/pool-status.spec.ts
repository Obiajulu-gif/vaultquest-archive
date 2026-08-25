import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

describe("Pool status API endpoints", () => {
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

  const validStellarAddress = "GABCDEF1234567890123456789012345678901234567890123456789";

  async function createPoolAction(wallet: string, vaultId: string, status = "pending") {
    const res = await app.inject({
      method: "POST",
      url: "/actions",
      headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: {
        wallet_address: wallet,
        action_type: "deposit",
        action_payload: { vault_id: vaultId, amount: "100", token: "USDC" }
      }
    });
    const id = res.json().data.id;

    if (status === "confirmed") {
      await app.inject({
        method: "PATCH",
        url: `/actions/${id}/submitted`,
        payload: { tx_hash: randomUUID() }
      });
    }

    return id;
  }

  it("returns pool action history for a wallet", async () => {
    await createPoolAction("GPOOL1", "pool-1");
    await createPoolAction("GPOOL1", "pool-1");
    const different = await createPoolAction("GPOOL2", "pool-2");

    const res = await app.inject({
      method: "GET",
      url: "/actions?wallet=GPOOL1&limit=10"
    });
    expect(res.statusCode).toBe(200);

    const { data, meta } = res.json();
    expect(data).toHaveLength(2);
    data.forEach((action: any) => {
      expect(action.wallet_address).toBe("GPOOL1");
      expect(action.action_type).toBe("deposit");
      expect(action.action_payload).toMatchObject({ vault_id: "pool-1" });
      expect(action.correlation_id).toBeDefined();
    });
    expect(meta.pagination.has_more).toBe(false);
  });

  it("rejects pool action with invalid idempotency key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/actions",
      headers: { "content-type": "application/json" },
      payload: { wallet_address: "GINVALID", action_type: "deposit", action_payload: { vault_id: "1" } }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects pool action with invalid wallet address on portfolio", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/portfolio/summary?wallet=invalidAddress"
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("returns pool dashboard summary with correct counts across statuses", async () => {
    const wallet = "GPOOLDASH";
    const a = await createPoolAction(wallet, "pool-1", "pending");
    const b = await createPoolAction(wallet, "pool-2", "pending");

    await app.inject({
      method: "PATCH",
      url: `/actions/${a}/submitted`,
      headers: { "content-type": "application/json" },
      payload: { tx_hash: "TX_POOL_A" }
    });

    const res = await app.inject({
      method: "GET",
      url: `/dashboard/summary?wallet=${wallet}`
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.total_actions).toBe(2);
    expect(data.by_status.submitted).toBe(1);
    expect(data.by_status.pending).toBe(1);
    expect(data.pending_tx_hashes).toContain("TX_POOL_A");
    expect(data.wallet_address).toBe(wallet);
  });

  it("handles empty pool actions for unknown wallet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/actions?wallet=GUNKNOWN&limit=5"
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });

  it("returns stable error shape for non-existent pool action", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/actions/00000000-0000-0000-0000-000000000000"
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: expect.stringContaining("not found")
      }
    });
  });

  it("paginates pool actions correctly", async () => {
    const wallet = "GPAGINATE";
    for (let i = 0; i < 3; i++) {
      await createPoolAction(wallet, `pool-${i}`);
    }

    const page1 = await app.inject({
      method: "GET",
      url: `/actions?wallet=${wallet}&limit=2`
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().data).toHaveLength(2);
    expect(page1.json().meta.pagination.has_more).toBe(true);

    const cursor = page1.json().meta.pagination.next_cursor;
    const page2 = await app.inject({
      method: "GET",
      url: `/actions?wallet=${wallet}&limit=2&cursor=${cursor}`
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().meta.pagination.has_more).toBe(false);
  });
});
