import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

describe("admin audit routes", () => {
  let db: TestDb;
  let app: FastifyInstance;
  const adminWallet = "GADMIN";

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({
      prisma: db.prisma,
      internalSecret: "test-secret",
      adminWalletAddresses: [adminWallet]
    });
  });
  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  async function createSession(walletAddress = adminWallet) {
    const session = await db.prisma.walletSession.create({
      data: {
        walletAddress,
        publicKey: walletAddress,
        network: "TESTNET",
        token: randomUUID(),
        refreshToken: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
    return session.token;
  }

  async function authHeaders(walletAddress = adminWallet) {
    const token = await createSession(walletAddress);
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
  }

  it("rejects requests without a server-verified wallet session", async () => {
    const res = await app.inject({
      method: "GET", url: "/admin/audit",
      headers: { authorization: "Bearer forged-client-token" }
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects non-admin wallet sessions", async () => {
    const res = await app.inject({
      method: "GET", url: "/admin/audit",
      headers: await authHeaders("GNOTADMIN")
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /admin/audit returns empty list when no records", async () => {
    const res = await app.inject({
      method: "GET", url: "/admin/audit",
      headers: await authHeaders()
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.meta.pagination.has_more).toBe(false);
  });

  it("POST /admin/audit creates an audit record", async () => {
    const res = await app.inject({
      method: "POST", url: "/admin/audit",
      headers: await authHeaders(),
      payload: {
        parameter_name: "max_deposit",
        previous_value: 1000,
        new_value: 5000,
        actor: "GADMIN123",
        tx_hash: "tx_abc_123"
      }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.parameter_name).toBe("max_deposit");
    expect(body.previous_value).toBe(1000);
    expect(body.new_value).toBe(5000);
    expect(body.actor).toBe("GADMIN123");
    expect(body.tx_hash).toBe("tx_abc_123");
    expect(body.id).toBeDefined();
  });

  it("POST /admin/audit rejects missing required fields", async () => {
    const res = await app.inject({
      method: "POST", url: "/admin/audit",
      headers: await authHeaders(),
      payload: { parameter_name: "max_deposit" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /admin/audit lists records with pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST", url: "/admin/audit",
        headers: await authHeaders(),
        payload: {
          parameter_name: `param_${i}`,
          previous_value: 0,
          new_value: i,
          actor: "GADMIN"
        }
      });
    }
    const res = await app.inject({
      method: "GET", url: "/admin/audit?limit=3",
      headers: await authHeaders()
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(3);
    expect(body.meta.pagination.has_more).toBe(true);
    expect(body.meta.pagination.next_cursor).not.toBeNull();

    const next = await app.inject({
      method: "GET", url: `/admin/audit?limit=3&cursor=${body.meta.pagination.next_cursor}`,
      headers: await authHeaders()
    });
    expect(next.statusCode).toBe(200);
    const nextBody = next.json();
    expect(nextBody.data).toHaveLength(2);
    expect(nextBody.meta.pagination.has_more).toBe(false);
  });

  it("GET /admin/audit filters by parameter_name", async () => {
    await app.inject({
      method: "POST", url: "/admin/audit",
      headers: await authHeaders(),
      payload: { parameter_name: "fee_rate", previous_value: 0.05, new_value: 0.03, actor: "GADMIN" }
    });
    await app.inject({
      method: "POST", url: "/admin/audit",
      headers: await authHeaders(),
      payload: { parameter_name: "max_deposit", previous_value: 1000, new_value: 5000, actor: "GADMIN" }
    });
    const res = await app.inject({
      method: "GET", url: "/admin/audit?parameter_name=fee_rate",
      headers: await authHeaders()
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].parameter_name).toBe("fee_rate");
  });

  it("GET /admin/audit/export returns CSV", async () => {
    await app.inject({
      method: "POST", url: "/admin/audit",
      headers: await authHeaders(),
      payload: { parameter_name: "fee_rate", previous_value: 0.05, new_value: 0.03, actor: "GADMIN" }
    });
    const res = await app.inject({
      method: "GET", url: "/admin/audit/export",
      headers: await authHeaders()
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.split("\n").filter((l: string) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("parameter_name");
    expect(lines[1]).toContain("fee_rate");
  });

  it("GET /admin/audit/export returns empty CSV when no data", async () => {
    const res = await app.inject({
      method: "GET", url: "/admin/audit/export",
      headers: await authHeaders()
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n").filter((l: string) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("parameter_name");
  });
});
