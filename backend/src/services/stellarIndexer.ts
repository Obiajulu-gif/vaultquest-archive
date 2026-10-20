/**
 * Polls and decodes Soroban on-chain events, persisting them via LedgerService.
 *
 * `fetchEvents` is wrapped with `withRetry` (issue #274) so transient RPC
 * failures (network timeouts, 429 rate-limits, 503/504 gateway errors) are
 * automatically retried with full-jitter exponential backoff before the tick
 * is declared a failure.
 */

import type { LedgerService, ReconcileEventInput } from "./ledger.js";
import { withRetry, type RetryOptions } from "../utils/retry.js";
import type { Logger } from "pino";
import { rpc as StellarRpc, xdr as StellarXdr, scValToNative } from "@stellar/stellar-sdk";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Shape of a raw event returned by the Horizon / Soroban RPC source.
 * Topics and value are base-64 encoded XDR blobs.
 */
export interface RawHorizonEvent {
  id: string;
  ledger: number;
  txHash: string;
  contractId: string;
  topicXdr: string[];   // array of base-64 encoded XDR symbol/value pairs
  valueXdr: string;     // base-64 encoded XDR value
  successful: boolean;
  /**
   * ISO-8601 close time of the emitting ledger (RPC `ledgerClosedAt`).
   * Always set by SorobanRpcEventSource; it is the only clock event
   * processing may use, so replaying the log stays deterministic (#751).
   */
  ledgerClosedAt?: string;
}

export interface DecodedEvent {
  txHash: string;
  sorobanEventId: string;
  eventPayload: Record<string, unknown>;
  statusHint: "confirmed" | "reverted";
}

export interface IndexResult {
  /** Total raw events fetched from the source. */
  processed: number;
  /** Events that were written to pending_events or confirmed an action. */
  imported: number;
  /** Events skipped because their tx hash was already recorded. */
  duplicates: number;
  /** Events that failed to decode or had an unrecognized type; quarantined without advancing the cursor past them. */
  quarantined: number;
  /** Cursor after this tick (last successfully processed event id), or null if no events arrived. */
  cursor: string | null;
  /** Highest ledger sequence observed in this batch (successfully processed events only). */
  latestLedger: number | null;
  /** Chain tip reported by the source on this fetch, or null when the source doesn't report one (#752). */
  chainLatestLedger: number | null;
  /**
   * Ledger the indexer has provably scanned through (#752). Equals the chain
   * tip only when the page came back short AND the scan started within the
   * RPC's per-request scan window; otherwise the last processed event's
   * ledger, so a cursor stuck behind an empty stretch shows up as lag.
   */
  ingestedLedger: number | null;
}

export interface HorizonEventSource {
  fetchEvents(opts: { cursor?: string | null; startLedger?: number; endLedger?: number; limit?: number }): Promise<RawHorizonEvent[]>;
  /** Chain tip (`latestLedger`) seen by the most recent fetch, if the source reports it (#752). */
  latestObservedLedger?(): number | null;
}

/**
 * Stellar RPC scans at most 10,000 ledgers per getEvents request (stellar-rpc
 * v21.5.0), so a short page only proves the tip was reached when the scan
 * started less than this many ledgers behind it.
 */
export const RPC_MAX_SCAN_LEDGERS = 10_000;

/**
 * Extracts the ledger sequence from a Soroban RPC event id. The id is a
 * 19-digit TOID ("-" 10-digit event index) whose top 32 bits are the ledger
 * sequence. Returns null for ids that aren't TOID-shaped (test doubles).
 */
export function ledgerOfEventId(eventId: string): number | null {
  const [toid = ""] = eventId.split("-");
  if (!/^\d{19}$/.test(toid)) return null;
  return Number(BigInt(toid) >> 32n);
}

/** Smallest possible event id in `ledger` — the TOID-ordered lower bound for that ledger. */
export function firstEventIdOfLedger(ledger: number): string {
  return `${(BigInt(ledger) << 32n).toString().padStart(19, "0")}-${"0".repeat(10)}`;
}

export interface XdrDecoder {
  /** Throw to signal a malformed or unrecognized event; the indexer will quarantine it. */
  decode(event: RawHorizonEvent): Record<string, unknown>;
}

export interface StellarIndexerOptions {
  ledger: LedgerService;
  source: HorizonEventSource;
  decoder: XdrDecoder;
  batchSize?: number;
  /** Retry config forwarded to `withRetry` for each `fetchEvents` call. */
  retryOptions?: RetryOptions;
  logger?: Logger;
  /**
   * Optional (#507): resolves the full contract-id list to index, called at
   * the start of every tick before `fetchEvents`. Lets the indexer pick up
   * newly-deployed pools (via `PoolRegistry`) without a restart, layered on
   * top of the static `INDEXER_CONTRACT_IDS` env list rather than replacing
   * it — see the #507 design proposal. Only applied when `source` exposes
   * a `setContractIds` method (currently `SorobanRpcEventSource`); ignored
   * for test doubles that don't.
   */
  resolveContractIds?: () => Promise<string[]>;
  /**
   * #507 — the one trusted vault-factory contract address. A `fpooldep`
   * (pool-deployed) event is only routed to the pool registry when it was
   * emitted BY this exact contract address (`raw.contractId`) — the event
   * payload's own fields (pool_address/admin/asset/etc.) are otherwise
   * fully attacker-controlled data, so trusting "any watched contract that
   * emits a topic matching fpooldep" would let an unrelated/malicious
   * contract spoof a pool into the registry (the acceptance criteria's
   * "spoofed pools" scenario). When unset, fpooldep events are never
   * auto-trusted and are logged instead — fail closed, not open.
   */
  factoryAddress?: string;
}

export interface SorobanRpcEventSourceOptions {
  /** Primary RPC endpoint, or a list of endpoints tried in order for failover. */
  rpcUrl: string | string[];
  contractIds?: string[];
  /** Soroban topic filters (each inner array is an OR'd topic pattern), forwarded as-is to getEvents. */
  topics?: string[][];
  /** Max raw events fetched across pages within a single tick (default 1000). */
  maxPageFetch?: number;
}

// ─── Default XDR decoder ──────────────────────────────────────────────────────

/**
 * Decodes a base-64 encoded string into a UTF-8 string.
 */
function b64Decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Attempts to JSON-parse a base-64 value; falls back to `{ raw }`.
 */
function decodeValue(b64: string): Record<string, unknown> {
  try {
    const raw = b64Decode(b64);
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { raw: parsed };
  } catch {
    return {};
  }
}

/**
 * Hex-encodes a BytesN<32> value as decoded by `scValToNative` (a Buffer or
 * Uint8Array); falls back to `String()` if it already arrived as a string.
 */
function bytesToHex(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  return String(value);
}

/**
 * Decodes the first topic XDR blob as a plain string action type.
 */
function decodeTopic(b64: string): string {
  try {
    return b64Decode(b64).replace(/[^\w_]/g, "").toLowerCase();
  } catch {
    return "unknown";
  }
}

/**
 * Default decoder: extracts action `type` from the first topic and merges the
 * value payload. Compatible with the `makeEvent` test helper.
 */
export const defaultXdrDecoder: XdrDecoder = {
  decode(event: RawHorizonEvent): Record<string, unknown> {
    const type = event.topicXdr[0] ? decodeTopic(event.topicXdr[0]) : "unknown";
    const value = decodeValue(event.valueXdr);
    return { type, ...value };
  }
};

/** Domain event types the reconciler/quest layers understand. Anything else is quarantined. */
const KNOWN_EVENT_TYPES = new Set([
  "deposit",
  "withdraw",
  "claim",
  "draw",
  "settlement",
  "create_vault",
  "select_winner",
  // vault-factory's own registry event (#507): the on-chain topic symbol
  // is `symbol_short!("fpooldep")` (9-char Soroban Symbol limit), decoded
  // here as the literal string "fpooldep" — distinct from drip-pool's
  // unrelated, pre-existing `pool_created` action-event vocabulary (#413,
  // see tests/fixtures/indexer-events/pool_created.json). Routed to
  // LedgerService.upsertPoolRegistryEntry, not reconcileEvent — see
  // StellarIndexer.tick's branch below.
  "fpooldep"
]);

/** Matches vault-factory's `FACTORY_POOL_DEPLOYED_TOPIC` (#507). */
const FACTORY_POOL_DEPLOYED_EVENT_TYPE = "fpooldep";

/**
 * Production decoder: decodes real Soroban `ScVal` XDR (via the Stellar SDK)
 * into validated domain records. Throws on missing/malformed XDR or an
 * unrecognized event type so the indexer can quarantine the event instead of
 * silently dropping or misprojecting it.
 */
export const sorobanNativeXdrDecoder: XdrDecoder = {
  decode(event: RawHorizonEvent): Record<string, unknown> {
    const topicB64 = event.topicXdr[0];
    if (!topicB64) {
      throw new Error(`event ${event.id} has no topics`);
    }

    let type: string;
    try {
      const topicVal = StellarXdr.ScVal.fromXDR(topicB64, "base64");
      type = String(scValToNative(topicVal)).toLowerCase();
    } catch (err) {
      throw new Error(`event ${event.id} failed to decode topic: ${(err as Error).message}`);
    }

    if (!KNOWN_EVENT_TYPES.has(type)) {
      throw new Error(`event ${event.id} has unrecognized event type "${type}"`);
    }

    let value: unknown;
    try {
      const scVal = StellarXdr.ScVal.fromXDR(event.valueXdr, "base64");
      value = scValToNative(scVal);
    } catch (err) {
      throw new Error(`event ${event.id} failed to decode value: ${(err as Error).message}`);
    }

    if (typeof value !== "object" || value === null) {
      throw new Error(`event ${event.id} value did not decode to a record`);
    }

    return { type, ...(value as Record<string, unknown>) };
  }
};

/** Maps a decoded event onto the ledger's reconcile input; event-derived fields only (#751). */
function toReconcileInput(e: {
  raw: RawHorizonEvent;
  payload: Record<string, unknown>;
  statusHint: "confirmed" | "reverted";
}): ReconcileEventInput {
  return {
    txHash: e.raw.txHash,
    sorobanEventId: e.raw.id,
    eventPayload: e.payload,
    statusHint: e.statusHint,
    ledger: e.raw.ledger,
    ledgerClosedAt: e.raw.ledgerClosedAt ? new Date(e.raw.ledgerClosedAt) : undefined
  };
}

// ─── StellarIndexer ───────────────────────────────────────────────────────────

/**
 * Drives a single polling tick: fetches raw events from the configured source
 * (with retry), decodes them, and reconciles each against the action ledger.
 */
export class StellarIndexer {
  private cursor: string | null = null;
  private isReplaying = false;
  private readonly opts: Required<
    Pick<StellarIndexerOptions, "batchSize" | "retryOptions">
  > & StellarIndexerOptions;

  constructor(private options: StellarIndexerOptions) {
    this.opts = {
      batchSize: options.batchSize ?? 50,
      retryOptions: options.retryOptions ?? {},
      ...options
    };
  }

  setCursor(cursor: string | null): void {
    if (this.isReplaying) {
      throw new Error("Cannot set cursor while an indexer replay is currently in progress");
    }
    this.cursor = cursor;
  }

  getCursor(): string | null {
    return this.cursor;
  }

  isReplayActive(): boolean {
    return this.isReplaying;
  }

  /**
   * Bounded replay over a specific ledger range with concurrency protection (#573).
   */
  async replayRange(startLedger: number, endLedger: number): Promise<IndexResult> {
    if (this.isReplaying) {
      throw new Error("Indexer replay is already in progress. Concurrent replays are blocked.");
    }
    this.isReplaying = true;
    try {
      const savedCursor = this.cursor;
      this.cursor = null;
      const rawEvents = await this.opts.source.fetchEvents({
        startLedger,
        endLedger,
        limit: this.opts.batchSize,
      });

      const result = await this.processRawEvents(rawEvents);
      this.cursor = savedCursor;
      return result;
    } finally {
      this.isReplaying = false;
    }
  }


  /**
   * Fetches one batch of events (with retry), decodes and reconciles each,
   * advances the cursor.
   */
  async tick(): Promise<IndexResult> {
    const { ledger, source, decoder } = this.opts;
    const batchSize = this.opts.batchSize;

    // ── Refresh contract-id filter (#507) ─────────────────────────────────
    if (this.opts.resolveContractIds && typeof (source as any).setContractIds === "function") {
      try {
        const contractIds = await this.opts.resolveContractIds();
        (source as unknown as { setContractIds(ids: string[]): void }).setContractIds(contractIds);
      } catch (err) {
        this.opts.logger?.warn({ err }, "indexer: failed to refresh contract id filter, keeping previous list");
      }
    }

    // ── Fetch with retry ──────────────────────────────────────────────────
    const scanFrom = this.cursor;
    const rawEvents = await withRetry(
      () => source.fetchEvents({ cursor: scanFrom, limit: batchSize }),
      this.opts.retryOptions
    );

    const result = await this.processRawEvents(rawEvents);

    // ── Ingestion progress (#752) ─────────────────────────────────────────
    const chainLatestLedger = source.latestObservedLedger?.() ?? null;
    const scanFromLedger = scanFrom ? ledgerOfEventId(scanFrom) : null;
    const reachedTip =
      rawEvents.length < batchSize &&
      result.quarantined === 0 &&
      chainLatestLedger !== null &&
      scanFromLedger !== null &&
      chainLatestLedger - scanFromLedger < RPC_MAX_SCAN_LEDGERS;

    return {
      ...result,
      chainLatestLedger,
      ingestedLedger: reachedTip ? chainLatestLedger : result.latestLedger ?? scanFromLedger
    };
  }

  /**
   * Processes a list of raw Horizon/Soroban events through decoding, quarantine,
   * batch reconciliation, and pool registry upsert.
   */
  async processRawEvents(rawEvents: RawHorizonEvent[]): Promise<IndexResult> {
    const { ledger, decoder } = this.opts;
    const ordered = [...rawEvents].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    // Persist the original bytes and their manifest before decoding or writing any projection.
    await ledger.appendChainEvents(ordered);
    let imported = 0;
    let duplicates = 0;
    let quarantined = 0;
    let latestLedger: number | null = null;
    const seen = new Set<string>();
    const seenTransactions = new Set<string>();
    let pending: ReconcileEventInput[] = [];
    let pendingTip: RawHorizonEvent | null = null;
    const flush = async () => {
      if (pending.length) {
        const outcomes = await ledger.reconcileEvents(pending);
        for (let i = 0; i < pending.length; i++) {
          const input = pending[i]!;
          this.opts.logger?.info({ txHash: input.txHash, eventId: input.sorobanEventId,
            ledger: input.ledger, matched: outcomes[i]!.matched }, "indexer: event reconciled");
        }
        imported += pending.length;
      }
      if (pendingTip) { this.cursor = pendingTip.id; latestLedger = pendingTip.ledger; }
      pending = [];
      pendingTip = null;
    };
    for (const raw of ordered) {
      if (seen.has(raw.id)) { duplicates++; pendingTip = raw; continue; }
      seen.add(raw.id);
      let payload: Record<string, unknown>;
      try {
        payload = decoder.decode(raw);
      } catch (error) {
        await flush();
        await ledger.quarantineEvent({ sorobanEventId: raw.id, ledger: raw.ledger,
          contractId: raw.contractId, txHash: raw.txHash, rawEvent: raw as unknown as Record<string, unknown>,
          reason: error instanceof Error ? error.message : String(error) });
        this.opts.logger?.warn({ eventId: raw.id, txHash: raw.txHash }, "indexer: quarantined event; halted at gap");
        quarantined++;
        break;
      }
      const statusHint = raw.successful ? "confirmed" as const : "reverted" as const;
      if (payload.type === FACTORY_POOL_DEPLOYED_EVENT_TYPE && statusHint === "confirmed") {
        // Flush before registry writes so mixed batches preserve chain order.
        await flush();
        if (this.opts.factoryAddress && raw.contractId === this.opts.factoryAddress) {
          await ledger.upsertPoolRegistryEntry({ salt: bytesToHex(payload.salt),
            poolAddress: String(payload.pool_address), factoryAddress: raw.contractId,
            admin: String(payload.admin), asset: String(payload.asset), wasmHash: bytesToHex(payload.wasm_hash),
            deployedLedger: raw.ledger });
          imported++;
        } else {
          this.opts.logger?.warn({ eventId: raw.id, contractId: raw.contractId }, "indexer: refusing registry event from an untrusted factory");
        }
        this.cursor = raw.id;
        latestLedger = raw.ledger;
      } else {
        if (seenTransactions.has(raw.txHash)) { duplicates++; pendingTip = raw; continue; }
        seenTransactions.add(raw.txHash);
        pending.push(toReconcileInput({ raw, payload, statusHint }));
        pendingTip = raw;
      }
    }
    // Failed batches propagate without advancing the cursor. A retry repeats
    // the already committed prefix, whose ledger writes are idempotent.
    await flush();
    return { processed: rawEvents.length, imported, duplicates, quarantined,
      cursor: this.cursor, latestLedger, chainLatestLedger: null, ingestedLedger: latestLedger };
  }

}

// ─── SorobanRpcEventSource ────────────────────────────────────────────────────

/** Soroban RPC caps each getEvents page at 200 events / 24h ledger window. */
const RPC_PAGE_LIMIT = 200;

/**
 * Production event source backed by the real Soroban RPC `getEvents` method.
 * Paginates via the RPC's opaque cursor (never combined with startLedger, per
 * the RPC contract), applies contract/topic filters, and supports RPC
 * failover across multiple configured endpoints.
 */
export class SorobanRpcEventSource implements HorizonEventSource {
  private servers: StellarRpc.Server[];
  private latestLedger: number | null = null;

  constructor(private options: SorobanRpcEventSourceOptions) {
    const urls = Array.isArray(options.rpcUrl) ? options.rpcUrl : [options.rpcUrl];
    this.servers = urls.map((url) => new StellarRpc.Server(url, { allowHttp: url.startsWith("http://") }));
  }

  /**
   * Replaces the contract-id filter list (#507). Read fresh by
   * `fetchEvents` on every call, so callers can widen the filter as new
   * pools are deployed without needing to reconstruct this source —
   * `StellarIndexer.tick` calls this each tick with the static
   * `INDEXER_CONTRACT_IDS` env list merged with `PoolRegistry`'s active
   * pool addresses.
   */
  setContractIds(contractIds: string[]): void {
    this.options = { ...this.options, contractIds };
  }

  latestObservedLedger(): number | null {
    return this.latestLedger;
  }

  private async callWithFailover(request: StellarRpc.Api.GetEventsRequest): Promise<StellarRpc.Api.GetEventsResponse> {
    let lastErr: unknown;
    for (const server of this.servers) {
      try {
        return await server.getEvents(request);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("all Soroban RPC endpoints failed");
  }

  async fetchEvents(opts: { cursor?: string | null; startLedger?: number; endLedger?: number; limit?: number }): Promise<RawHorizonEvent[]> {
    const targetLimit = Math.min(opts.limit ?? RPC_PAGE_LIMIT, this.options.maxPageFetch ?? 1000);
    const filters = this.options.contractIds?.length
      ? [
          {
            type: "contract" as const,
            contractIds: this.options.contractIds,
            ...(this.options.topics?.length ? { topics: this.options.topics } : {})
          }
        ]
      : [];

    const collected: RawHorizonEvent[] = [];
    // The RPC forbids combining cursor with startLedger: cursor resumes from
    // an exact position, startLedger seeds a fresh bounded range.
    let cursor = opts.cursor ?? undefined;
    let startLedger = cursor ? undefined : opts.startLedger;

    while (collected.length < targetLimit) {
      const pageSize = Math.min(RPC_PAGE_LIMIT, targetLimit - collected.length);
      const request: StellarRpc.Api.GetEventsRequest = cursor
        ? { filters, cursor, limit: pageSize }
        : { filters, startLedger, limit: pageSize };

      const response = await this.callWithFailover(request);
      this.latestLedger = response.latestLedger;
      const events = response.events ?? [];

      for (const evt of events) {
        if (opts.endLedger !== undefined && evt.ledger > opts.endLedger) {
          return collected;
        }
        collected.push({
          id: evt.id,
          ledger: evt.ledger,
          ledgerClosedAt: evt.ledgerClosedAt,
          txHash: evt.txHash,
          // The SDK parses contractId into a Contract; persist its strkey.
          contractId: typeof evt.contractId === "string" ? evt.contractId : evt.contractId?.contractId() ?? "",
          topicXdr: (evt.topic ?? []).map((t) => (typeof t === "string" ? t : (t as StellarXdr.ScVal).toXDR("base64"))),
          valueXdr: typeof evt.value === "string" ? evt.value : (evt.value as StellarXdr.ScVal).toXDR("base64"),
          successful: evt.inSuccessfulContractCall !== false
        });
      }

      if (events.length < pageSize) {
        break; // caught up to the RPC's current cursor position
      }

      const last = events[events.length - 1]!;
      cursor = (last as unknown as { pagingToken?: string }).pagingToken ?? last.id;
      startLedger = undefined;
    }

    return collected;
  }
}
