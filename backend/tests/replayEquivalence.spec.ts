import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { startTestDb, type TestDb } from "./helpers/db.js";
import { LedgerService, type ReconcileEventInput } from "../src/services/ledger.js";
import {
  StellarIndexer,
  defaultXdrDecoder,
  firstEventIdOfLedger,
  type HorizonEventSource,
  type RawHorizonEvent,
  type XdrDecoder
} from "../src/services/stellarIndexer.js";
import {
  ChainEventLogSource,
  diffChainState,
  refillEventLog,
  replayEventLog,
  resetChainDerivedState,
  runReplayEquivalence
} from "../src/services/replayEquivalence.js";
import { tablesOfKind } from "../src/services/dataClassification.js";

/**
 * #751 — replay determinism: a fresh replay of the chain event log must
 * reproduce live chain-derived state, and the job must catch deliberately
 * introduced non-determinism. #754 — the same engine rebuilds a fresh
 * database from backup + chain history alone.
 */

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");
const hash = (n: number) => n.toString(16).padStart(64, "0");
const eventId = (ledger: number, index: number) =>
  `${((BigInt(ledger) << 32n) | (BigInt(index) << 12n)).toString().padStart(19, "0")}-0000000000`;

function chainEvent(ledger: number, index: number, txHash: string, value: Record<string, unknown>, successful = true): RawHorizonEvent {
  return {
    id: eventId(ledger, index),
    ledger,
    ledgerClosedAt: new Date(Date.UTC(2026, 8, 24, 0, 0, ledger % 60)).toISOString(),
    txHash,
    contractId: "CPOOL",
    topicXdr: [b64("deposit")],
    valueXdr: b64(value),
    successful
  };
}

/** Serves a fixed event list the way the RPC does: by cursor or by ledger window. */
type FetchOpts = Parameters<HorizonEventSource["fetchEvents"]>[0];

function listSource(events: RawHorizonEvent[], tip?: number): HorizonEventSource & { requests: FetchOpts[] } {
  const requests: FetchOpts[] = [];
  return {
    requests,
    async fetchEvents(opts) {
      requests.push(opts);
      const from = opts.cursor
        ? events.findIndex((e) => e.id === opts.cursor) + 1
        : events.findIndex((e) => e.ledger >= (opts.startLedger ?? 0));
      if (from < 0) return [];
      return events
        .slice(from)
        .filter((e) => opts.endLedger === undefined || e.ledger <= opts.endLedger)
        .slice(0, opts.limit ?? 100);
    },
    latestObservedLedger: () => tip ?? null
  };
}

async function truncateAll(prisma: PrismaClient): Promise<void> {
  const tables = [...tablesOfKind("chain-derived"), ...tablesOfKind("mixed"), ...tablesOfKind("ephemeral")];
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")}`);
}

async function intent(ledger: LedgerService, txHash?: string) {
  const action = await ledger.createAction({
    idempotencyKey: randomUUID(),
    walletAddress: "GWALLET",
    actionType: "deposit",
    actionPayload: { vault_id: "v1", amount: "100" }
  });
  return txHash ? ledger.attachTxHash(action.id, txHash, { workerId: "w", ttlMs: 60_000 }) : action;
}

/** Drives the live system exactly as the indexer cron does, persisting the checkpoint. */
async function runLiveIndexer(ledger: LedgerService, events: RawHorizonEvent[], decoder: XdrDecoder = defaultXdrDecoder) {
  const indexer = new StellarIndexer({ ledger, source: listSource(events), decoder, batchSize: 2 });
  for (;;) {
    const result = await indexer.tick();
    if (result.processed === 0) break;
    await ledger.updateIndexerCheckpoint({ latestLedger: result.latestLedger ?? 0, lastProcessedEventId: result.cursor, success: true });
  }
}

/**
 * A realistic interleaving: intent attached before its event, event before
 * its intent (attachTxHash consumes the parked event), an event with no
 * intent, a revert, and a second event in the same transaction.
 */
async function liveScenario(live: LedgerService, decoder?: XdrDecoder) {
  await intent(live, hash(1));
  const late = await intent(live);
  await runLiveIndexer(
    live,
    [
      chainEvent(1000, 1, hash(1), { amount: "100", vault_id: "v1" }),
      chainEvent(1001, 1, hash(2), { amount: "250", vault_id: "v1" }),
      chainEvent(1002, 1, hash(3), { amount: "5", vault_id: "v2" }),
      chainEvent(1003, 1, hash(4), { amount: "7", vault_id: "v1" }, false),
      chainEvent(1003, 2, hash(4), { amount: "7", vault_id: "v1" }, false)
    ],
    decoder
  );
  await live.attachTxHash(late.id, hash(2), { workerId: "w", ttlMs: 60_000 });
  await intent(live, hash(4));
}

describe("replay equivalence (#751)", () => {
  let liveDb: TestDb;
  let replayDb: TestDb;
  let live: LedgerService;

  beforeAll(async () => {
    [liveDb, replayDb] = await Promise.all([startTestDb(), startTestDb()]);
  });
  afterAll(async () => {
    await Promise.all([liveDb.stop(), replayDb.stop()]);
  });
  beforeEach(async () => {
    await Promise.all([truncateAll(liveDb.prisma), truncateAll(replayDb.prisma)]);
    live = new LedgerService(liveDb.prisma);
  });

  it("reproduces live chain-derived state byte-for-byte from the event log", async () => {
    await liveScenario(live);

    const report = await runReplayEquivalence(liveDb.prisma, replayDb.prisma, { decoder: defaultXdrDecoder });

    expect(report.horizon).toEqual({ fromEventId: eventId(1000, 1), toEventId: eventId(1003, 2) });
    // >= 5: a duplicate that ends a batch is re-fetched once (idempotent no-op).
    expect(report.eventsReplayed).toBeGreaterThanOrEqual(5);
    expect(report.divergences).toBe(0);
    const actions = report.tables.find((t) => t.table === "action_ledger")!;
    const parked = report.tables.find((t) => t.table === "pending_events")!;
    expect(actions.compared).toBe(3);
    expect(parked.compared).toBe(1);
  });

  it("confirms with the event's ledger close time, not the wall clock", async () => {
    await intent(live, hash(9));
    await runLiveIndexer(live, [chainEvent(1234, 1, hash(9), { amount: "1" })]);

    const row = await liveDb.prisma.actionLedger.findUnique({ where: { txHash: hash(9) } });
    expect(row?.confirmedAt?.toISOString()).toBe(chainEvent(1234, 1, hash(9), {}).ledgerClosedAt);
  });

  it("catches a deliberately introduced non-deterministic decoder (random value outside the payload)", async () => {
    const nondeterministic: XdrDecoder = {
      decode: (e) => ({ ...defaultXdrDecoder.decode(e), decodedNonce: randomUUID() })
    };
    await liveScenario(live, nondeterministic);

    const report = await runReplayEquivalence(liveDb.prisma, replayDb.prisma, { decoder: nondeterministic });

    expect(report.divergences).toBeGreaterThan(0);
    expect(report.tables.find((t) => t.table === "action_ledger")!.mismatched).toBeGreaterThan(0);
    expect(report.tables.find((t) => t.table === "pending_events")!.mismatched).toBe(1);
  });

  it("catches a deliberately introduced wall-clock regression in reconciliation", async () => {
    // The pre-#751 behaviour: confirmedAt stamped from new Date().
    class WallClockLedger extends LedgerService {
      override reconcileEvents(events: ReconcileEventInput[]) {
        return super.reconcileEvents(events.map((e) => ({ ...e, ledgerClosedAt: undefined })));
      }
    }
    await liveScenario(new WallClockLedger(liveDb.prisma));

    const report = await runReplayEquivalence(liveDb.prisma, replayDb.prisma, { decoder: defaultXdrDecoder });

    const actions = report.tables.find((t) => t.table === "action_ledger")!;
    expect(actions.mismatched).toBeGreaterThan(0);
    expect(actions.samples.every((s) => s.startsWith("mismatch:"))).toBe(true);
  });

  it("ignores logged events the live indexer has not applied yet (past the checkpoint)", async () => {
    await liveScenario(live);
    // Fetched and logged by a tick that has not committed its reconcile yet.
    await live.appendChainEvents([chainEvent(1010, 1, hash(7), { amount: "3" })]);

    const report = await runReplayEquivalence(liveDb.prisma, replayDb.prisma, { decoder: defaultXdrDecoder });

    expect(report.divergences).toBe(0);
    expect(await replayDb.prisma.chainEvent.count({ where: { txHash: hash(7) } })).toBe(0);
  });

  it("reports nothing to compare when the live log is empty", async () => {
    await intent(live, hash(1));

    const report = await runReplayEquivalence(liveDb.prisma, replayDb.prisma, { decoder: defaultXdrDecoder });

    expect(report.horizon).toBeNull();
    expect(report.divergences).toBe(0);
  });
});

describe("disaster recovery from backup + chain history (#754)", () => {
  let liveDb: TestDb;
  let freshDb: TestDb;

  beforeAll(async () => {
    [liveDb, freshDb] = await Promise.all([startTestDb(), startTestDb()]);
  });
  afterAll(async () => {
    await Promise.all([liveDb.stop(), freshDb.stop()]);
  });
  beforeEach(async () => {
    await Promise.all([truncateAll(liveDb.prisma), truncateAll(freshDb.prisma)]);
  });

  /** Simulates restoring a backup taken at this moment: copies the off-chain intents only. */
  async function restoreBackupOfIntents() {
    const rows = await liveDb.prisma.actionLedger.findMany();
    await freshDb.prisma.actionLedger.createMany({
      data: rows.map((r) => ({ ...r, actionPayload: r.actionPayload as object, verifiedPayload: (r.verifiedPayload ?? undefined) as object | undefined }))
    });
  }

  it("rebuilds chain-derived state in a fresh database from chain history alone and matches live", async () => {
    const live = new LedgerService(liveDb.prisma);
    const chain = [
      chainEvent(20_000, 1, hash(11), { amount: "10" }),
      chainEvent(35_000, 1, hash(12), { amount: "20" }), // > one RPC scan window later
      chainEvent(35_001, 1, hash(13), { amount: "30" }) // no intent: parked
    ];
    await intent(live, hash(11));
    await intent(live, hash(12));
    await restoreBackupOfIntents();
    await runLiveIndexer(live, chain);

    // Recovery: backup restored (above), chain state dropped, log re-fetched, replayed.
    await resetChainDerivedState(freshDb.prisma);
    const rpc = listSource(chain, 36_000);
    const refetched = await refillEventLog(freshDb.prisma, rpc, 20_000, 2);
    const replay = await replayEventLog(freshDb.prisma, new ChainEventLogSource(freshDb.prisma), { decoder: defaultXdrDecoder });
    const checkpoint = await liveDb.prisma.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
    const tables = await diffChainState(liveDb.prisma, freshDb.prisma, {
      fromEventId: firstEventIdOfLedger(20_000),
      toEventId: checkpoint!.lastProcessedEventId!
    });

    expect(refetched).toBe(3);
    // Walked 10,000-ledger windows: [20000..29999], [30000..39999].
    expect(rpc.requests.filter((r) => r.startLedger !== undefined).map((r) => [r.startLedger, r.endLedger])).toEqual([
      [20_000, 29_999],
      [30_000, 39_999]
    ]);
    expect(replay.events).toBe(3);
    for (const t of tables) {
      expect({ table: t.table, mismatched: t.mismatched, missing: t.missingInTarget, extra: t.extraInTarget }).toEqual({
        table: t.table,
        mismatched: 0,
        missing: 0,
        extra: 0
      });
    }
  });

  it("reports intents created after the backup as recovery-point loss, not as mismatches", async () => {
    const live = new LedgerService(liveDb.prisma);
    await intent(live, hash(21));
    await restoreBackupOfIntents();
    await intent(live, hash(22)); // after the backup
    const chain = [chainEvent(5_000, 1, hash(21), { amount: "1" }), chainEvent(5_001, 1, hash(22), { amount: "2" })];
    await runLiveIndexer(live, chain);

    await resetChainDerivedState(freshDb.prisma);
    await refillEventLog(freshDb.prisma, listSource(chain, 5_001), 5_000);
    await replayEventLog(freshDb.prisma, new ChainEventLogSource(freshDb.prisma), { decoder: defaultXdrDecoder });
    const tables = await diffChainState(liveDb.prisma, freshDb.prisma, {
      fromEventId: firstEventIdOfLedger(5_000),
      toEventId: chain[1]!.id
    });

    const actions = tables.find((t) => t.table === "action_ledger")!;
    expect(actions.mismatched).toBe(0);
    expect(actions.missingInTarget).toBe(1);
    // The lost intent's event is parked in the recovered DB, awaiting re-attachment.
    expect(tables.find((t) => t.table === "pending_events")!.extraInTarget).toBe(1);
  });

  it("drops ephemeral state and keeps operator-resolved quarantine on reset", async () => {
    await freshDb.prisma.walletSession.create({
      data: { walletAddress: "G", publicKey: "G", network: "testnet", token: randomUUID(), expiresAt: new Date(Date.now() + 60_000) }
    });
    await freshDb.prisma.poisonEvent.createMany({
      data: [
        { sorobanEventId: eventId(1, 1), ledger: 1, contractId: "C", txHash: hash(1), rawEvent: {}, reason: "x", resolvedAt: new Date() },
        { sorobanEventId: eventId(1, 2), ledger: 1, contractId: "C", txHash: hash(2), rawEvent: {}, reason: "y" }
      ]
    });

    await resetChainDerivedState(freshDb.prisma);

    expect(await freshDb.prisma.walletSession.count()).toBe(0);
    expect((await freshDb.prisma.poisonEvent.findMany()).map((p) => p.sorobanEventId)).toEqual([eventId(1, 1)]);
  });
});
