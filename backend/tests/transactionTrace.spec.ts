import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { actionsRoutes } from "../src/routes/actions.js";
import { internalRoutes } from "../src/routes/internal.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { LedgerService } from "../src/services/ledger.js";
import { TransactionTraceService } from "../src/services/transactionTrace.js";
import { StellarIndexer, defaultXdrDecoder, type RawHorizonEvent } from "../src/services/stellarIndexer.js";

/**
 * #753 — cross-layer tracing keyed by transaction hash, exercised end to end:
 * intent (POST /actions) -> signing hand-off (PATCH /actions/:id/submitted)
 * -> chain event -> indexer ingestion -> ledger confirmation -> dashboard.
 */

const SECRET = "trace-test-internal-secret";
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");

function chainEvent(txHash: string, ledger: number): RawHorizonEvent {
  return {
    id: `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-0000000001`,
    ledger,
    ledgerClosedAt: "2026-09-24T10:00:05.000Z",
    txHash,
    contractId: "CDRIPPOOL",
    topicXdr: [b64("deposit")],
    valueXdr: b64({ amount: "100", vault_id: "v1" }),
    successful: true
  };
}

async function ingest(ledger: LedgerService, events: RawHorizonEvent[]) {
  const indexer = new StellarIndexer({
    ledger,
    source: { fetchEvents: async ({ cursor }) => (cursor ? [] : events) },
    decoder: defaultXdrDecoder
  });
  await indexer.tick();
}

describe("GET /internal/trace/:txHash (#753)", () => {
  let db: TestDb;
  let app: FastifyInstance;
  let ledger: LedgerService;

  beforeAll(async () => {
    db = await startTestDb();
    ledger = new LedgerService(db.prisma);
    // Only the routes under test: the intent API and the internal trace route.
    app = Fastify();
    app.setErrorHandler(errorHandler);
    app.register(actionsRoutes(ledger, (async () => {}) as preHandlerHookHandler));
    app.register(internalRoutes(ledger, SECRET, new TransactionTraceService(db.prisma)));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
    await db.prisma.poisonEvent.deleteMany({});
  });

  const trace = (txHash: string, secret: string | null = SECRET) =>
    app.inject({ method: "GET", url: `/internal/trace/${txHash}`, headers: secret ? { "x-internal-secret": secret } : {} });

  it("reconstructs the full timeline for a deposit from intent to dashboard", async () => {
    const txHash = "a".repeat(64);
    const created = await app.inject({
      method: "POST",
      url: "/actions",
      headers: { "idempotency-key": randomUUID(), "content-type": "application/json" },
      payload: { wallet_address: "GWALLET", action_type: "deposit", action_payload: { vault_id: "v1", amount: "100" } }
    });
    const actionId = created.json().data.id as string;
    // The signing hand-off that PATCH /actions/:id/submitted performs.
    await ledger.attachTxHash(actionId, txHash, { workerId: "wallet", ttlMs: 60_000 });
    await ingest(ledger, [chainEvent(txHash, 777)]);

    const res = await trace(txHash);

    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body).toMatchObject({ txHash, actionId, walletAddress: "GWALLET", status: "confirmed", gaps: [] });
    const stages = body.timeline.map((e: { stage: string }) => e.stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        "intent_recorded",
        "tx_hash_attached",
        "event_emitted",
        "event_logged",
        "action_confirmed",
        "visible_on_dashboard"
      ])
    );
    const emitted = body.timeline.find((e: { stage: string }) => e.stage === "event_emitted");
    expect(emitted).toMatchObject({ layer: "chain", at: "2026-09-24T10:00:05.000Z", detail: { ledger: 777, contractId: "CDRIPPOOL" } });
    const confirmed = body.timeline.find((e: { stage: string }) => e.stage === "action_confirmed");
    expect(confirmed.detail.confirmedAt).toBe("2026-09-24T10:00:05.000Z");
    // Chronological within each layer's own clock.
    expect(stages.indexOf("intent_recorded")).toBeLessThan(stages.indexOf("tx_hash_attached"));
    expect(stages.indexOf("event_logged")).toBeLessThan(stages.indexOf("visible_on_dashboard"));
  });

  it("names the gap when an ingested event never got an intent", async () => {
    const txHash = "b".repeat(64);
    await ingest(ledger, [chainEvent(txHash, 778)]);

    const body = (await trace(txHash)).json().data;

    expect(body.status).toBeNull();
    expect(body.timeline.map((e: { stage: string }) => e.stage)).toContain("event_parked_awaiting_intent");
    expect(body.gaps).toEqual([
      "event ingested but no action intent carries this tx_hash (PATCH /actions/:id/submitted never called)"
    ]);
  });

  it("names the gap when an intent was submitted but no event was ingested", async () => {
    const txHash = "c".repeat(64);
    const action = await ledger.createAction({
      idempotencyKey: randomUUID(),
      walletAddress: "GWALLET",
      actionType: "deposit",
      actionPayload: { amount: "1" }
    });
    await ledger.attachTxHash(action.id, txHash, { workerId: "w", ttlMs: 60_000 });

    const body = (await trace(txHash)).json().data;

    expect(body.status).toBe("submitted");
    expect(body.gaps[0]).toMatch(/^no on-chain event in the chain event log/);
  });

  it("shows a quarantined event as the blocking gap", async () => {
    const txHash = "d".repeat(64);
    const indexer = new StellarIndexer({
      ledger,
      source: { fetchEvents: async () => [chainEvent(txHash, 779)] },
      decoder: {
        decode: () => {
          throw new Error("unrecognized event type");
        }
      }
    });
    await indexer.tick();

    const body = (await trace(txHash)).json().data;

    expect(body.timeline.map((e: { stage: string }) => e.stage)).toContain("event_quarantined");
    expect(body.gaps[0]).toMatch(/quarantined and holds the indexer cursor: unrecognized event type/);
  });

  it("returns 404 for an unknown hash and 401 without the internal secret", async () => {
    expect((await trace("f".repeat(64))).statusCode).toBe(404);
    expect((await trace("f".repeat(64), null)).statusCode).toBe(401);
  });
});
