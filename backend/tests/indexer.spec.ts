import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { seedAction } from "./helpers/factory.js";
import { LedgerService } from "../src/services/ledger.js";
import {
  StellarIndexer,
  defaultXdrDecoder,
  type RawHorizonEvent,
  type HorizonEventSource
} from "../src/services/stellarIndexer.js";

function b64(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");
}

function makeEvent(overrides: Partial<RawHorizonEvent> = {}): RawHorizonEvent {
  return {
    id: overrides.id ?? "1",
    ledger: overrides.ledger ?? 100,
    txHash: overrides.txHash ?? "tx_1",
    contractId: overrides.contractId ?? "CDRIP",
    topicXdr: overrides.topicXdr ?? [b64("deposit")],
    valueXdr: overrides.valueXdr ?? b64({ amount: "100", vault_id: "v1" }),
    successful: overrides.successful ?? true
  };
}

/** Event source backed by a fixed in-memory list, paged by cursor. */
function staticSource(events: RawHorizonEvent[]): HorizonEventSource {
  return {
    async fetchEvents({ cursor, limit }) {
      const start = cursor ? events.findIndex((e) => e.id === cursor) + 1 : 0;
      return events.slice(start, start + limit);
    }
  };
}

describe("StellarIndexer", () => {
  let db: TestDb;
  let ledger: LedgerService;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => {
    await resetDb(db.prisma);
    ledger = new LedgerService(db.prisma);
  });

  it("decodes XDR payloads and imports events as pending_events when unmatched", async () => {
    const indexer = new StellarIndexer({
      ledger,
      source: staticSource([makeEvent({ id: "1", txHash: "tx_a" })]),
      decoder: defaultXdrDecoder
    });

    const result = await indexer.tick();
    expect(result.processed).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.cursor).toBe("1");

    const parked = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_a" } });
    expect(parked).not.toBeNull();
    expect((parked!.eventPayload as any).type).toBe("deposit");
    expect((parked!.eventPayload as any).vault_id).toBe("v1");
  });

  it("confirms a matching action on its tx hash", async () => {
    const action = await seedAction(db.prisma, { status: "submitted", txHash: "tx_match" });
    const indexer = new StellarIndexer({
      ledger,
      source: staticSource([makeEvent({ id: "1", txHash: "tx_match" })]),
      decoder: defaultXdrDecoder
    });

    await indexer.tick();
    const refreshed = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
    expect(refreshed?.status).toBe("confirmed");
  });

  it("is idempotent across re-runs and safely handles duplicate tx hashes", async () => {
    const events = [
      makeEvent({ id: "1", txHash: "tx_dup" }),
      makeEvent({ id: "2", txHash: "tx_dup" })
    ];
    const indexer = new StellarIndexer({ ledger, source: staticSource(events), decoder: defaultXdrDecoder });

    const first = await indexer.tick();
    expect(first.duplicates).toBe(1); // second event shares the tx hash

    // Re-running from the start must not create a second pending_event row.
    indexer.setCursor(null);
    await indexer.tick();
    const rows = await db.prisma.pendingEvent.findMany({ where: { txHash: "tx_dup" } });
    expect(rows).toHaveLength(1);
  });

  it("marks reverted transactions accordingly", async () => {
    const action = await seedAction(db.prisma, { status: "submitted", txHash: "tx_rev" });
    const indexer = new StellarIndexer({
      ledger,
      source: staticSource([makeEvent({ id: "1", txHash: "tx_rev", successful: false })]),
      decoder: defaultXdrDecoder
    });

    await indexer.tick();
    const refreshed = await db.prisma.actionLedger.findUnique({ where: { id: action.id } });
    expect(refreshed?.status).toBe("reverted");
  });

  it("resumes from the persisted processed-event cursor after downtime", async () => {
    await db.prisma.indexerCheckpoint.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        latestLedger: 102,
        lastProcessedEventId: "2",
        lastSyncTime: new Date("2026-06-23T00:00:00Z"),
        lastError: null,
        lastSuccessSyncTime: new Date("2026-06-23T00:00:00Z")
      },
      update: {
        latestLedger: 102,
        lastProcessedEventId: "2",
        lastSyncTime: new Date("2026-06-23T00:00:00Z"),
        lastError: null,
        lastSuccessSyncTime: new Date("2026-06-23T00:00:00Z")
      }
    });

    let seenCursor: string | null = null;
    const indexer = new StellarIndexer({
      ledger,
      source: {
        async fetchEvents({ cursor, limit }) {
          seenCursor = cursor;
          expect(limit).toBe(200);
          return cursor === "2"
            ? [makeEvent({ id: "3", ledger: 103, txHash: "tx_resume" })]
            : [];
        }
      },
      decoder: defaultXdrDecoder
    });

    const result = await indexer.tick();

    expect(seenCursor).toBe("2");
    expect(result.cursor).toBe("3");
    expect(result.processed).toBe(1);
    expect(result.imported).toBe(1);

    const checkpoint = await db.prisma.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
    expect(checkpoint?.lastProcessedEventId).toBe("3");
    expect(checkpoint?.latestLedger).toBe(103);

    const parked = await db.prisma.pendingEvent.findUnique({ where: { txHash: "tx_resume" } });
    expect(parked).not.toBeNull();
  });
});
