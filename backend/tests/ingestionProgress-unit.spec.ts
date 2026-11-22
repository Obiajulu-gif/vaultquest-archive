import { describe, it, expect, vi } from "vitest";
import { register } from "prom-client";
import {
  StellarIndexer,
  firstEventIdOfLedger,
  ledgerOfEventId,
  type HorizonEventSource,
  type RawHorizonEvent
} from "../src/services/stellarIndexer.js";
import { getPrometheusMetrics } from "../src/services/prometheusMetrics.js";
import type { LedgerService } from "../src/services/ledger.js";

/**
 * #752 — ingestion leading indicators (no database required).
 */

function eventAt(ledger: number, index = 1): RawHorizonEvent {
  return {
    id: `${((BigInt(ledger) << 32n) | (BigInt(index) << 12n)).toString().padStart(19, "0")}-0000000000`,
    ledger,
    ledgerClosedAt: "2026-09-24T00:00:00Z",
    txHash: index.toString(16).padStart(64, "0"),
    contractId: "CPOOL",
    topicXdr: [Buffer.from("deposit").toString("base64")],
    valueXdr: Buffer.from(JSON.stringify({ amount: "1" })).toString("base64"),
    successful: true
  };
}

function sourceWith(pages: RawHorizonEvent[][], tip: number): HorizonEventSource {
  let call = 0;
  return {
    async fetchEvents() {
      return pages[call++] ?? [];
    },
    latestObservedLedger: () => tip
  };
}

function fakeLedger() {
  return {
    appendChainEvents: vi.fn(async () => {}),
    reconcileEvents: vi.fn(async (events: Array<{ txHash: string }>) =>
      events.map((e) => ({ txHash: e.txHash, matched: false }))
    ),
    reconcileEvent: vi.fn(),
    quarantineEvent: vi.fn(),
    upsertPoolRegistryEntry: vi.fn()
  };
}

describe("event id <-> ledger (TOID)", () => {
  it("round-trips a ledger through its first event id", () => {
    expect(firstEventIdOfLedger(58_762_517)).toMatch(/^\d{19}-0{10}$/);
    expect(ledgerOfEventId(firstEventIdOfLedger(58_762_517))).toBe(58_762_517);
    expect(ledgerOfEventId(eventAt(1234, 7).id)).toBe(1234);
  });

  it("orders lexicographically in chain order", () => {
    expect(firstEventIdOfLedger(999) < eventAt(999, 1).id).toBe(true);
    expect(eventAt(999, 5).id < firstEventIdOfLedger(1000)).toBe(true);
  });

  it("returns null for non-TOID ids", () => {
    expect(ledgerOfEventId("1")).toBeNull();
  });
});

describe("StellarIndexer ingestion progress (#752)", () => {
  it("logs every fetched event before processing it", async () => {
    const ledger = fakeLedger();
    const events = [eventAt(100, 1), eventAt(101, 2)];
    const indexer = new StellarIndexer({
      ledger: ledger as unknown as LedgerService,
      source: sourceWith([events], 101),
      decoder: { decode: () => ({ type: "deposit" }) }
    });

    await indexer.tick();

    expect(ledger.appendChainEvents).toHaveBeenCalledWith(events);
    expect(ledger.appendChainEvents.mock.invocationCallOrder[0]).toBeLessThan(
      ledger.reconcileEvents.mock.invocationCallOrder[0]!
    );
  });

  it("reports the chain tip as ingested when a short page started inside the RPC scan window", async () => {
    const indexer = new StellarIndexer({
      ledger: fakeLedger() as unknown as LedgerService,
      source: sourceWith([[eventAt(5_000, 2)]], 5_020),
      decoder: { decode: () => ({ type: "deposit" }) },
      batchSize: 50
    });
    indexer.setCursor(eventAt(4_990, 1).id);

    const result = await indexer.tick();

    expect(result.chainLatestLedger).toBe(5_020);
    expect(result.ingestedLedger).toBe(5_020);
  });

  it("does not assume the tip was reached when the cursor is beyond the 10,000-ledger scan window (silent stall)", async () => {
    const indexer = new StellarIndexer({
      ledger: fakeLedger() as unknown as LedgerService,
      source: sourceWith([[]], 50_000),
      decoder: { decode: () => ({ type: "deposit" }) }
    });
    indexer.setCursor(eventAt(20_000, 1).id);

    const result = await indexer.tick();

    // Empty page, but the RPC only scanned 20,000..29,999: lag must show.
    expect(result.chainLatestLedger).toBe(50_000);
    expect(result.ingestedLedger).toBe(20_000);
  });

  it("reports the last processed ledger when the page was full (backlog)", async () => {
    const indexer = new StellarIndexer({
      ledger: fakeLedger() as unknown as LedgerService,
      source: sourceWith([[eventAt(700, 1), eventAt(701, 2)]], 900),
      decoder: { decode: () => ({ type: "deposit" }) },
      batchSize: 2
    });
    indexer.setCursor(eventAt(699, 9).id);

    const result = await indexer.tick();

    expect(result.ingestedLedger).toBe(701);
  });

  it("does not treat a quarantine halt as caught up", async () => {
    const ledger = fakeLedger();
    const indexer = new StellarIndexer({
      ledger: ledger as unknown as LedgerService,
      source: sourceWith([[eventAt(800, 1)]], 810),
      decoder: {
        decode: () => {
          throw new Error("bad xdr");
        }
      }
    });
    indexer.setCursor(eventAt(799, 1).id);

    const result = await indexer.tick();

    expect(result.quarantined).toBe(1);
    expect(result.ingestedLedger).toBe(799);
  });
});

describe("PrometheusMetrics.recordIngestionProgress (#752)", () => {
  it("exports lag, queue depth, and quarantine gauges", async () => {
    const metrics = getPrometheusMetrics();
    metrics.recordIngestionProgress({ chainLatestLedger: 5_100, ingestedLedger: 5_040, pendingEvents: 3, quarantinedEvents: 1 });

    const text = await register.metrics();
    expect(text).toMatch(/^indexer_chain_latest_ledger 5100$/m);
    expect(text).toMatch(/^indexer_latest_ledger 5040$/m);
    expect(text).toMatch(/^pending_events_total 3$/m);
    expect(text).toMatch(/^indexer_quarantined_events 1$/m);
  });

  it("leaves ledgers untouched when the source cannot report them", async () => {
    const metrics = getPrometheusMetrics();
    metrics.recordIngestionProgress({ chainLatestLedger: 6_000, ingestedLedger: 5_990, pendingEvents: 0, quarantinedEvents: 0 });
    metrics.recordIngestionProgress({ chainLatestLedger: null, ingestedLedger: null, pendingEvents: 0, quarantinedEvents: 0 });

    const text = await register.metrics();
    expect(text).toMatch(/^indexer_chain_latest_ledger 6000$/m);
    expect(text).toMatch(/^indexer_latest_ledger 5990$/m);
  });
});
