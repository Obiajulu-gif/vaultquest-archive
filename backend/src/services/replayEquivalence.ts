/**
 * Replay-equivalence engine (#751), shared with the disaster-recovery drill (#754).
 *
 * Proves that replaying the append-only chain event log through the
 * production StellarIndexer/LedgerService code reproduces the live
 * chain-derived state. The replay target is a scratch database: it is
 * seeded with the live off-chain intents (chain-derived columns reset), the
 * log is replayed in event-id (= chain) order, and the chain-derived
 * projections of both databases are diffed.
 *
 * Complexity (A actions, E log events, P parked events, R registry rows):
 *  - seeding:  O(A) time, O(PAGE_SIZE) memory (keyset pages + createMany)
 *  - replay:   O(E) time in E / batchSize transactions
 *  - diff:     O(A + P + R) time, O(PAGE_SIZE) memory — a streaming merge
 *              join over both databases in key order, never materialized.
 */

import { Prisma, type ActionLedger, type PrismaClient } from "@prisma/client";
import { LedgerService, stableStringify } from "./ledger.js";
import {
  StellarIndexer,
  RPC_MAX_SCAN_LEDGERS,
  ledgerOfEventId,
  type HorizonEventSource,
  type RawHorizonEvent,
  type XdrDecoder
} from "./stellarIndexer.js";
import { tablesOfKind } from "./dataClassification.js";

type Db = PrismaClient | Prisma.TransactionClient;

const PAGE_SIZE = 500;
const SAMPLE_LIMIT = 20;

/** Event-id range the comparison covers; events outside it never reached the log being replayed. */
export interface ReplayHorizon {
  /** Inclusive lower bound (first event id covered). */
  fromEventId: string;
  /** Inclusive upper bound (last event id the live indexer is known to have processed). */
  toEventId: string;
}

export interface TableDiff {
  table: string;
  compared: number;
  mismatched: number;
  missingInTarget: number;
  extraInTarget: number;
  /** Up to SAMPLE_LIMIT `kind:key` entries for triage. */
  samples: string[];
}

export interface ReplayOptions {
  decoder: XdrDecoder;
  factoryAddress?: string;
  batchSize?: number;
}

export interface ReplayEquivalenceOptions extends ReplayOptions {
  /** Upper bound for holding the live read snapshot open. */
  snapshotTimeoutMs?: number;
}

export interface ReplayEquivalenceReport {
  horizon: ReplayHorizon | null;
  intentsSeeded: number;
  eventsReplayed: number;
  haltedOnQuarantine: boolean;
  tables: TableDiff[];
  /** Total mismatched + missing + extra rows across all tables. */
  divergences: number;
  durationMs: number;
}

// ─── Event source over the stored log ─────────────────────────────────────────

/**
 * Serves the chain event log in id order, exactly as SorobanRpcEventSource
 * serves the chain, so the replay drives the unmodified StellarIndexer.
 */
export class ChainEventLogSource implements HorizonEventSource {
  constructor(
    private readonly db: Db,
    private readonly bounds: { toEventId?: string; skipEventIds?: readonly string[] } = {}
  ) {}

  async fetchEvents(opts: { cursor?: string | null; limit?: number }): Promise<RawHorizonEvent[]> {
    const { toEventId, skipEventIds = [] } = this.bounds;
    const rows = await this.db.chainEvent.findMany({
      where: {
        id: {
          gt: opts.cursor ?? "",
          ...(toEventId !== undefined ? { lte: toEventId } : {}),
          ...(skipEventIds.length > 0 ? { notIn: [...skipEventIds] } : {})
        }
      },
      orderBy: { id: "asc" },
      take: opts.limit ?? PAGE_SIZE
    });
    return rows.map((r) => ({
      id: r.id,
      ledger: r.ledger,
      ledgerClosedAt: r.ledgerClosedAt?.toISOString(),
      txHash: r.txHash,
      contractId: r.contractId,
      topicXdr: r.topicXdr,
      valueXdr: r.valueXdr,
      successful: r.successful
    }));
  }
}

// ─── Target preparation ──────────────────────────────────────────────────────

function quoteTables(tables: string[]): string {
  // Identifiers come from the static DATA_CLASSIFICATION map, never input.
  return tables.map((t) => `"${t}"`).join(", ");
}

/**
 * Drops all chain-derived and ephemeral state and resets the chain-derived
 * columns of mixed tables, leaving only what replay cannot rebuild. Actions
 * that reached the chain return to `submitted`, their pre-outcome status.
 */
export async function resetChainDerivedState(db: PrismaClient): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe(`TRUNCATE TABLE ${quoteTables([...tablesOfKind("chain-derived"), ...tablesOfKind("ephemeral")])}`),
    db.poisonEvent.deleteMany({ where: { resolvedAt: null } }),
    db.actionLedger.updateMany({
      where: { txHash: { not: null } },
      data: {
        status: "submitted",
        sorobanEventId: null,
        verifiedPayload: Prisma.DbNull,
        confirmedAt: null,
        errorCode: null,
        errorDetail: null
      }
    })
  ]);
}

/** Copies every action row (off-chain intent included) from `from` into `to` in keyset pages. */
async function copyIntents(from: Db, to: PrismaClient): Promise<number> {
  let copied = 0;
  let after: string | null = null;
  for (;;) {
    const rows: ActionLedger[] = await from.actionLedger.findMany({
      where: after ? { id: { gt: after } } : {},
      orderBy: { id: "asc" },
      take: PAGE_SIZE
    });
    if (rows.length > 0) {
      await to.actionLedger.createMany({
        data: rows.map((r) => ({
          ...r,
          actionPayload: (r.actionPayload ?? Prisma.DbNull) as Prisma.InputJsonValue,
          verifiedPayload: (r.verifiedPayload ?? Prisma.DbNull) as Prisma.InputJsonValue
        }))
      });
      copied += rows.length;
      after = rows[rows.length - 1]!.id;
    }
    if (rows.length < PAGE_SIZE) return copied;
  }
}

// ─── Replay ───────────────────────────────────────────────────────────────────

/**
 * Replays `source` into `target` through the production indexer until the
 * source is exhausted or a quarantined event halts it — the same place the
 * live indexer halts, so both sides stop at the identical cursor.
 */
export async function replayEventLog(
  target: PrismaClient,
  source: HorizonEventSource,
  opts: ReplayOptions
): Promise<{ events: number; haltedOnQuarantine: boolean; cursor: string | null }> {
  const indexer = new StellarIndexer({
    ledger: new LedgerService(target),
    source,
    decoder: opts.decoder,
    factoryAddress: opts.factoryAddress,
    batchSize: opts.batchSize
  });

  let events = 0;
  for (;;) {
    const before = indexer.getCursor();
    const result = await indexer.tick();
    events += result.processed;
    if (result.quarantined > 0) return { events, haltedOnQuarantine: true, cursor: indexer.getCursor() };
    if (result.processed === 0) return { events, haltedOnQuarantine: false, cursor: indexer.getCursor() };
    if (indexer.getCursor() === before) {
      throw new Error(`replay made no progress past cursor ${before ?? "<start>"}`);
    }
  }
}

/**
 * DR (#754): re-fetches the chain event log from `startLedger` to the chain
 * tip into `target`. Walks fixed windows of RPC_MAX_SCAN_LEDGERS because
 * the RPC scans at most that many ledgers per request, so a short page
 * alone never proves the tip was reached.
 */
export async function refillEventLog(
  target: PrismaClient,
  source: HorizonEventSource,
  startLedger: number,
  pageSize = 200
): Promise<number> {
  const ledger = new LedgerService(target);
  let total = 0;
  for (let from = startLedger; ; ) {
    const to = from + RPC_MAX_SCAN_LEDGERS - 1;
    let page = await source.fetchEvents({ startLedger: from, endLedger: to, limit: pageSize });
    for (;;) {
      await ledger.appendChainEvents(page);
      total += page.length;
      if (page.length < pageSize) break;
      page = await source.fetchEvents({ cursor: page[page.length - 1]!.id, endLedger: to, limit: pageSize });
    }
    const tip = source.latestObservedLedger?.() ?? null;
    if (tip === null || to >= tip) return total;
    from = to + 1;
  }
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

interface ProjectedRow {
  key: string;
  value: string;
}

type ProjectionFetch = (db: Db, after: string | null, take: number) => Promise<ProjectedRow[]>;

/**
 * Streams a projection in key order. Keys are fixed-format ASCII (uuid, hex
 * hash, strkey, TOID id), for which PostgreSQL collation order equals
 * JavaScript code-unit order; the monotonicity check turns any violation of
 * that assumption into a loud failure instead of a silently wrong diff.
 */
async function* scan(db: Db, fetch: ProjectionFetch): AsyncGenerator<ProjectedRow> {
  let after: string | null = null;
  for (;;) {
    const page = await fetch(db, after, PAGE_SIZE);
    for (const row of page) {
      if (after !== null && row.key <= after) {
        throw new Error(`projection keys out of order at "${row.key}": database collation disagrees with code-unit order`);
      }
      after = row.key;
      yield row;
    }
    if (page.length < PAGE_SIZE) return;
  }
}

/** Streaming merge join of one projection across both databases. */
async function diffProjection(table: string, live: Db, target: Db, fetch: ProjectionFetch): Promise<TableDiff> {
  const diff: TableDiff = { table, compared: 0, mismatched: 0, missingInTarget: 0, extraInTarget: 0, samples: [] };
  const note = (kind: string, key: string) => {
    if (diff.samples.length < SAMPLE_LIMIT) diff.samples.push(`${kind}:${key}`);
  };

  const left = scan(live, fetch);
  const right = scan(target, fetch);
  let l = await left.next();
  let r = await right.next();

  while (!l.done || !r.done) {
    if (r.done || (!l.done && l.value.key < r.value.key)) {
      diff.missingInTarget++;
      note("missing", l.value!.key);
      l = await left.next();
    } else if (l.done || r.value.key < l.value.key) {
      diff.extraInTarget++;
      note("extra", r.value.key);
      r = await right.next();
    } else {
      diff.compared++;
      if (l.value.value !== r.value.value) {
        diff.mismatched++;
        note("mismatch", l.value.key);
      }
      l = await left.next();
      r = await right.next();
    }
  }
  return diff;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Diffs every chain-derived projection of `live` and `target` inside
 * `horizon`. Off-chain columns and bookkeeping timestamps (created/updated/
 * received/ingested) are deliberately excluded: they are not functions of
 * the event log.
 */
export async function diffChainState(live: Db, target: Db, horizon: ReplayHorizon): Promise<TableDiff[]> {
  const inHorizon = (eventId: string | null) =>
    eventId !== null && eventId >= horizon.fromEventId && eventId <= horizon.toEventId;
  const fromLedger = ledgerOfEventId(horizon.fromEventId) ?? 0;
  const toLedger = ledgerOfEventId(horizon.toEventId) ?? Number.MAX_SAFE_INTEGER;
  const eventRange = { gte: horizon.fromEventId, lte: horizon.toEventId };

  const actions: ProjectionFetch = async (db, after, take) => {
    const rows = await db.actionLedger.findMany({
      where: after ? { id: { gt: after } } : {},
      orderBy: { id: "asc" },
      take,
      select: { id: true, status: true, sorobanEventId: true, verifiedPayload: true, confirmedAt: true, errorCode: true }
    });
    return rows.map((row) => ({
      key: row.id,
      // Only on-chain outcomes inside the horizon are functions of the log;
      // everything else (pending/submitted/orphaned/failed) projects to "-".
      value:
        (row.status === "confirmed" || row.status === "reverted") && inHorizon(row.sorobanEventId)
          ? stableStringify({
              status: row.status,
              sorobanEventId: row.sorobanEventId,
              verifiedPayload: row.verifiedPayload,
              confirmedAt: iso(row.confirmedAt),
              errorCode: row.errorCode
            })
          : "-"
    }));
  };

  const parked: ProjectionFetch = async (db, after, take) => {
    // Consumed rows are excluded: whether an event was parked before its
    // intent arrived depends on off-chain timing, not on the log.
    const rows = await db.pendingEvent.findMany({
      where: { consumedAt: null, sorobanEventId: eventRange, ...(after ? { txHash: { gt: after } } : {}) },
      orderBy: { txHash: "asc" },
      take
    });
    return rows.map((row) => ({
      key: row.txHash,
      value: stableStringify({
        sorobanEventId: row.sorobanEventId,
        eventPayload: row.eventPayload,
        statusHint: row.statusHint,
        ledgerClosedAt: iso(row.ledgerClosedAt)
      })
    }));
  };

  const registry: ProjectionFetch = async (db, after, take) => {
    // Registry rows carry a ledger, not an event id: boundary ledgers can be
    // partially covered, so only ledgers strictly inside the horizon compare.
    const rows = await db.poolRegistry.findMany({
      where: { deployedLedger: { gt: fromLedger, lt: toLedger }, ...(after ? { poolAddress: { gt: after } } : {}) },
      orderBy: { poolAddress: "asc" },
      take
    });
    return rows.map((row) => ({
      key: row.poolAddress,
      value: stableStringify({
        salt: row.salt,
        factoryAddress: row.factoryAddress,
        admin: row.admin,
        asset: row.asset,
        wasmHash: row.wasmHash,
        deployedLedger: row.deployedLedger
      })
    }));
  };

  const quarantine: ProjectionFetch = async (db, after, take) => {
    const rows = await db.poisonEvent.findMany({
      where: { resolvedAt: null, sorobanEventId: after ? { ...eventRange, gt: after } : eventRange },
      orderBy: { sorobanEventId: "asc" },
      take
    });
    return rows.map((row) => ({ key: row.sorobanEventId, value: stableStringify({ txHash: row.txHash, reason: row.reason }) }));
  };

  // Sequential: a snapshot transaction client runs one query at a time.
  return [
    await diffProjection("action_ledger", live, target, actions),
    await diffProjection("pending_events", live, target, parked),
    await diffProjection("pool_registry", live, target, registry),
    await diffProjection("poison_events", live, target, quarantine)
  ];
}

/**
 * The horizon the live snapshot supports: from the first logged event to
 * the persisted checkpoint cursor. The checkpoint is written only after a
 * tick commits (and lags further behind when mirrored from the cache), so
 * every event up to it has certainly been applied by the live indexer.
 */
export async function liveHorizon(snapshot: Db): Promise<ReplayHorizon | null> {
  const [first, checkpoint] = await Promise.all([
    snapshot.chainEvent.findFirst({ orderBy: { id: "asc" }, select: { id: true } }),
    snapshot.indexerCheckpoint.findUnique({ where: { id: "singleton" }, select: { lastProcessedEventId: true } })
  ]);
  if (!first || !checkpoint?.lastProcessedEventId || checkpoint.lastProcessedEventId < first.id) return null;
  return { fromEventId: first.id, toEventId: checkpoint.lastProcessedEventId };
}

/** Operator-resolved poison events: the live cursor was moved past them, so replay skips them too. */
export async function resolvedPoisonEventIds(db: Db): Promise<string[]> {
  const rows = await db.poisonEvent.findMany({ where: { resolvedAt: { not: null } }, select: { sorobanEventId: true } });
  return rows.map((r) => r.sorobanEventId);
}

export function countDivergences(tables: TableDiff[]): number {
  return tables.reduce((n, t) => n + t.mismatched + t.missingInTarget + t.extraInTarget, 0);
}

/**
 * Full replay-equivalence run. All live reads happen inside one
 * REPEATABLE READ transaction, so intents, log, checkpoint, and the state
 * being diffed are a single consistent snapshot even while the live
 * indexer keeps writing.
 */
export async function runReplayEquivalence(
  live: PrismaClient,
  target: PrismaClient,
  opts: ReplayEquivalenceOptions
): Promise<ReplayEquivalenceReport> {
  const startedAt = Date.now();
  return live.$transaction(
    async (snapshot) => {
      const horizon = await liveHorizon(snapshot);

      await target.$executeRawUnsafe(
        `TRUNCATE TABLE ${quoteTables([...tablesOfKind("chain-derived"), ...tablesOfKind("mixed"), ...tablesOfKind("ephemeral")])}`
      );
      const intentsSeeded = await copyIntents(snapshot, target);
      await resetChainDerivedState(target);

      if (!horizon) {
        return { horizon, intentsSeeded, eventsReplayed: 0, haltedOnQuarantine: false, tables: [], divergences: 0, durationMs: Date.now() - startedAt };
      }

      const source = new ChainEventLogSource(snapshot, {
        toEventId: horizon.toEventId,
        skipEventIds: await resolvedPoisonEventIds(snapshot)
      });
      const replay = await replayEventLog(target, source, opts);
      const tables = await diffChainState(snapshot, target, horizon);

      return {
        horizon,
        intentsSeeded,
        eventsReplayed: replay.events,
        haltedOnQuarantine: replay.haltedOnQuarantine,
        tables,
        divergences: countDivergences(tables),
        durationMs: Date.now() - startedAt
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: opts.snapshotTimeoutMs ?? 30 * 60 * 1000,
      maxWait: 10_000
    }
  );
}
