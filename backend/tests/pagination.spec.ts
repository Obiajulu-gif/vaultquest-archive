import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";

describe("cursor pagination", () => {
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

  describe("actions pagination", () => {
    async function seedActions(wallet: string, count: number) {
      for (let i = 0; i < count; i++) {
        await app.inject({
          method: "POST", url: "/actions",
          headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
          payload: { wallet_address: wallet, action_type: "deposit", action_payload: { i } }
        });
      }
    }

    it("returns first page with cursor", async () => {
      await seedActions("GPAGE", 10);
      const res = await app.inject({ method: "GET", url: "/actions?wallet=GPAGE&limit=4" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(4);
      expect(body.meta.pagination.has_more).toBe(true);
      expect(body.meta.pagination.next_cursor).toBeDefined();
    });

    it("returns middle page via cursor", async () => {
      await seedActions("GPAGE", 10);
      const first = await app.inject({ method: "GET", url: "/actions?wallet=GPAGE&limit=3" });
      const cursor = first.json().meta.pagination.next_cursor;
      const second = await app.inject({ method: "GET", url: `/actions?wallet=GPAGE&limit=3&cursor=${cursor}` });
      expect(second.statusCode).toBe(200);
      expect(second.json().data).toHaveLength(3);
      expect(second.json().meta.pagination.has_more).toBe(true);
    });

    it("returns final page with no next_cursor", async () => {
      await seedActions("GPAGE", 5);
      const first = await app.inject({ method: "GET", url: "/actions?wallet=GPAGE&limit=3" });
      const cursor = first.json().meta.pagination.next_cursor;
      const second = await app.inject({ method: "GET", url: `/actions?wallet=GPAGE&limit=3&cursor=${cursor}` });
      expect(second.json().data).toHaveLength(2);
      expect(second.json().meta.pagination.has_more).toBe(false);
      expect(second.json().meta.pagination.next_cursor).toBeNull();
    });

    it("ordering remains stable between pages", async () => {
      await seedActions("GPAGE", 6);
      const first = await app.inject({ method: "GET", url: "/actions?wallet=GPAGE&limit=3" });
      const second = await app.inject({ method: "GET", url: `/actions?wallet=GPAGE&limit=3&cursor=${first.json().meta.pagination.next_cursor}` });
      const allIds = [...first.json().data, ...second.json().data].map((d: any) => d.id);
      const sorted = [...allIds].sort();
      expect(allIds).toEqual(sorted);  // IDs are UUIDs, so this just checks they're not duplicated
      expect(new Set(allIds).size).toBe(6);
    });

    it("invalid cursor returns empty data", async () => {
      const res = await app.inject({ method: "GET", url: "/actions?wallet=GPAGE&cursor=00000000-0000-0000-0000-000000000000" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(0);
    });

    it("invalid cursor format is rejected", async () => {
      const res = await app.inject({ method: "GET", url: "/actions?wallet=GPAGE&cursor=not-a-uuid" });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("saved pools pagination", () => {
    async function seedPools(wallet: string, count: number) {
      for (let i = 0; i < count; i++) {
        await app.inject({
          method: "POST", url: "/saved-pools",
          headers: { "content-type": "application/json" },
          payload: {
            wallet_address: wallet,
            pool: {
              pool_id: `pool_${i}`,
              pool_name: `Pool ${i}`,
              status: "open",
              tvl: "1000",
              asset: "USDC",
              participant_count: 10,
              expected_yield: "5.0",
            }
          }
        });
      }
    }

    it("lists first page of saved pools with cursor", async () => {
      await seedPools("GPOOL", 10);
      const res = await app.inject({ method: "GET", url: "/saved-pools?wallet=GPOOL&limit=4" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(4);
      expect(body.meta.pagination.has_more).toBe(true);
      expect(body.meta.pagination.next_cursor).toBeDefined();
    });

    it("navigates to middle page of saved pools", async () => {
      await seedPools("GPOOL", 10);
      const first = await app.inject({ method: "GET", url: "/saved-pools?wallet=GPOOL&limit=3" });
      const cursor = first.json().meta.pagination.next_cursor;
      const second = await app.inject({ method: "GET", url: `/saved-pools?wallet=GPOOL&limit=3&cursor=${cursor}` });
      expect(second.statusCode).toBe(200);
      expect(second.json().data).toHaveLength(3);
      expect(second.json().meta.pagination.has_more).toBe(true);
    });

    it("completes final page of saved pools", async () => {
      await seedPools("GPOOL", 5);
      const first = await app.inject({ method: "GET", url: "/saved-pools?wallet=GPOOL&limit=3" });
      const cursor = first.json().meta.pagination.next_cursor;
      const second = await app.inject({ method: "GET", url: `/saved-pools?wallet=GPOOL&limit=3&cursor=${cursor}` });
      expect(second.json().data).toHaveLength(2);
      expect(second.json().meta.pagination.has_more).toBe(false);
      expect(second.json().meta.pagination.next_cursor).toBeNull();
    });

    it("invalid cursor returns empty saved pools list", async () => {
      const res = await app.inject({ method: "GET", url: "/saved-pools?wallet=GPOOL&cursor=00000000-0000-0000-0000-000000000000" });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(0);
    });

    it("respects limit bounds for saved pools", async () => {
      const res = await app.inject({ method: "GET", url: "/saved-pools?wallet=GPOOL&limit=200" });
      expect(res.statusCode).toBe(400);
    });
  });
});
