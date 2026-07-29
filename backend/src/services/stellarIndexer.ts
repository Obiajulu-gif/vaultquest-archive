/**
 * Polls and decodes Soroban on-chain events, persisting them via LedgerService.
 *
 * `fetchEvents` is wrapped with `withRetry` (issue #274) so transient RPC
 * failures (network timeouts, 429 rate-limits, 503/504 gateway errors) are
 * automatically retried with full-jitter exponential backoff before the tick
 * is declared a failure.
 */

import type { LedgerService } from "./ledger.js";
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
}

export interface HorizonEventSource {
  fetchEvents(opts: { cursor?: string | null; startLedger?: number; endLedger?: number; limit?: number }): Promise<RawHorizonEvent[]>;
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
  "select_winner"
]);

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

// ─── StellarIndexer ───────────────────────────────────────────────────────────

/**
 * Drives a single polling tick: fetches raw events from the configured source
 * (with retry), decodes them, and reconciles each against the action ledger.
 */
export class StellarIndexer {
  private cursor: string | null = null;
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
    this.cursor = cursor;
  }

  getCursor(): string | null {
    return this.cursor;
  }

  /**
   * Fetches one batch of events (with retry), decodes and reconciles each,
   * advances the cursor.
   */
  async tick(): Promise<IndexResult> {
    const { ledger, source, decoder } = this.opts;
    const batchSize = this.opts.batchSize;

    // ── Fetch with retry ──────────────────────────────────────────────────
    const rawEvents = await withRetry(
      () => source.fetchEvents({ cursor: this.cursor, limit: batchSize }),
      this.opts.retryOptions
    );

    let imported = 0;
    let duplicates = 0;
    let quarantined = 0;
    let latestLedger: number | null = null;

    // Track txHashes seen within this batch to detect intra-batch duplicates
    // before they reach the DB (reconcileEvent uses upsert with update:{} so
    // it would silently accept a second write of the same hash).
    const seenInBatch = new Set<string>();

    // ── Process each event ────────────────────────────────────────────────
    for (const raw of rawEvents) {
      // Intra-batch duplicate: same txHash appeared earlier in this tick.
      if (seenInBatch.has(raw.txHash)) {
        duplicates += 1;
        this.cursor = raw.id;
        latestLedger = raw.ledger;
        continue;
      }
      seenInBatch.add(raw.txHash);

      let payload: Record<string, unknown>;
      try {
        payload = decoder.decode(raw);
      } catch (err) {
        // Malformed or unrecognized event: quarantine it and halt this batch
        // *without* advancing the cursor past it, so a gap can't silently
        // slip by. The next tick will re-fetch and retry the same event
        // until it's resolved (fixed decoder/backfill) or manually cleared.
        await ledger.quarantineEvent({
          sorobanEventId: raw.id,
          ledger: raw.ledger,
          contractId: raw.contractId,
          txHash: raw.txHash,
          rawEvent: raw as unknown as Record<string, unknown>,
          reason: err instanceof Error ? err.message : String(err)
        });
        quarantined += 1;
        this.opts.logger?.warn(
          { eventId: raw.id, txHash: raw.txHash, err },
          "indexer: quarantined event, halting batch at gap"
        );
        break;
      }

      const statusHint: "confirmed" | "reverted" = raw.successful ? "confirmed" : "reverted";

      try {
        await ledger.reconcileEvent({
          txHash: raw.txHash,
          sorobanEventId: raw.id,
          eventPayload: payload,
          statusHint
        });
        imported += 1;
      } catch (err: unknown) {
        // Unique constraint violation on pending_events.tx_hash means we already
        // have this event from a previous tick — safe to skip (idempotency).
        const isDuplicate =
          err instanceof Error &&
          (err.message.includes("Unique constraint") ||
            err.message.includes("P2002") ||
            (err as any).code === "P2002");

        if (isDuplicate) {
          duplicates += 1;
        } else {
          this.opts.logger?.warn({ err, txHash: raw.txHash }, "indexer: skipping event due to error");
          this.cursor = raw.id;
          latestLedger = raw.ledger;
          continue;
        }
      }

      this.cursor = raw.id;
      latestLedger = raw.ledger;
    }

    return {
      processed: rawEvents.length,
      imported,
      duplicates,
      quarantined,
      cursor: this.cursor,
      latestLedger
    };
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

  constructor(private options: SorobanRpcEventSourceOptions) {
    const urls = Array.isArray(options.rpcUrl) ? options.rpcUrl : [options.rpcUrl];
    this.servers = urls.map((url) => new StellarRpc.Server(url, { allowHttp: url.startsWith("http://") }));
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
      const events = response.events ?? [];

      for (const evt of events) {
        if (opts.endLedger !== undefined && evt.ledger > opts.endLedger) {
          return collected;
        }
        collected.push({
          id: evt.id,
          ledger: evt.ledger,
          txHash: evt.txHash,
          contractId: evt.contractId,
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
