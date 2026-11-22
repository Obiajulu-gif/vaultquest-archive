import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";

describe("authenticated public activity timeline", () => {
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

  async function createSession(walletAddress: string, token: string) {
    await db.prisma.walletSession.create({
      data: {
        walletAddress,
        publicKey: walletAddress,
        network: "TESTNET",
        token,
        expiresAt: new Date(Date.now() + 60_000)
      }
    });
  }

  async function createAction(input: {
    walletAddress: string;
    actionType: "deposit" | "withdraw" | "claim" | "select_winner" | "compensating";
    createdAt?: Date;
    redactedAt?: Date | null;
    actionPayload?: Record<string, unknown>;
  }) {
    return db.prisma.actionLedger.create({
      data: {
        idempotencyKey: randomUUID(),
        walletAddress: input.walletAddress,
        actionType: input.actionType,
        actionPayload: input.actionPayload ?? {},
        status: "confirmed",
        createdAt: input.createdAt,
        redactedAt: input.redactedAt
      }
    });
  }

  function getActivity(wallet: string, token: string, query = "") {
    return app.inject({
      method: "GET",
      url: `/api/activity?wallet=${encodeURIComponent(wallet)}${query}`,
      headers: { authorization: `Bearer ${token}` }
    });
  }

  it("requires a valid wallet session", async () => {
    const response = await app.inject({ method: "GET", url: `/api/activity?wallet=${WALLET_A}` });
    expect(response.statusCode).toBe(401);
  });

  it("returns only the authenticated wallet's events and denies address mismatch", async () => {
    await createSession(WALLET_A, "session-a");
    await createSession(WALLET_B, "session-b");
    const own = await createAction({ walletAddress: WALLET_A, actionType: "deposit" });
    const other = await createAction({ walletAddress: WALLET_B, actionType: "deposit" });

    const response = await getActivity(WALLET_A, "session-a");
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((event: { id: string }) => event.id)).toEqual([own.id]);
    expect(response.json().data.map((event: { id: string }) => event.id)).not.toContain(other.id);
    expect((await getActivity(WALLET_B, "session-a")).statusCode).toBe(403);
  });

  it("omits scrubbed, restricted, and maintainer-only action details", async () => {
    await createSession(WALLET_A, "session-a");
    const visible = await createAction({
      walletAddress: WALLET_A,
      actionType: "deposit",
      actionPayload: {
        amount: "125.50",
        token: "USDC",
        vault_id: "vault_7",
        private_note: "not for the timeline"
      }
    });
    await db.prisma.actionLedger.update({
      where: { id: visible.id },
      data: { errorCode: "INTERNAL_DIAGNOSTIC", errorDetail: "private maintainer detail" }
    });
    await createAction({ walletAddress: WALLET_A, actionType: "deposit", redactedAt: new Date() });
    await createAction({ walletAddress: WALLET_A, actionType: "select_winner" });
    await createAction({ walletAddress: WALLET_A, actionType: "compensating" });

    const response = await getActivity(WALLET_A, "session-a");
    const [event] = response.json().data;

    expect(response.statusCode).toBe(200);
    expect(event).toEqual({
      id: visible.id,
      type: "deposit",
      status: "confirmed",
      occurred_at: visible.createdAt.toISOString(),
      amount: "125.50",
      asset: "USDC",
      href: `/app/activity#activity-${visible.id}`,
      resource_href: "/app/vaults/vault_7"
    });
    expect(JSON.stringify(event)).not.toContain("private");
    expect(JSON.stringify(event)).not.toContain("INTERNAL_DIAGNOSTIC");
  });

  it("uses stable descending timestamp/id pagination and binds cursors to the wallet", async () => {
    await createSession(WALLET_A, "session-a");
    await createSession(WALLET_B, "session-b");
    const oldest = await createAction({
      walletAddress: WALLET_A,
      actionType: "deposit",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    const newestTie = await createAction({
      walletAddress: WALLET_A,
      actionType: "withdraw",
      createdAt: new Date("2026-01-03T00:00:00.000Z")
    });
    const middle = await createAction({
      walletAddress: WALLET_A,
      actionType: "withdraw",
      createdAt: new Date("2026-01-02T00:00:00.000Z")
    });
    const newest = await createAction({
      walletAddress: WALLET_A,
      actionType: "claim",
      createdAt: new Date("2026-01-03T00:00:00.000Z")
    });

    const first = await getActivity(WALLET_A, "session-a", "&limit=2");
    const firstBody = first.json();
    const sameTimestampOrder = [newest.id, newestTie.id].sort((left, right) => right.localeCompare(left));
    expect(firstBody.data.map((event: { id: string }) => event.id)).toEqual(sameTimestampOrder);
    const cursor = firstBody.meta.pagination.next_cursor;
    expect(typeof cursor).toBe("string");

    const second = await getActivity(WALLET_A, "session-a", `&limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(second.json().data.map((event: { id: string }) => event.id)).toEqual([middle.id, oldest.id]);
    expect(second.json().meta.pagination.next_cursor).toBeNull();

    const crossWalletCursor = await getActivity(
      WALLET_B,
      "session-b",
      `&cursor=${encodeURIComponent(cursor)}`
    );
    expect(crossWalletCursor.statusCode).toBe(400);
  });
});