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
  /** Cursor after this tick (last event id), or null if no events arrived. */
  cursor: string | null;
}

export interface HorizonEventSource {
  fetchEvents(opts: { cursor: string | null; limit: number }): Promise<RawHorizonEvent[]>;
}

export interface XdrDecoder {
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
  rpcUrl: string;
  contractIds?: string[];
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

    // Track txHashes seen within this batch to detect intra-batch duplicates
    // before they reach the DB (reconcileEvent uses upsert with update:{} so
    // it would silently accept a second write of the same hash).
    const seenInBatch = new Set<string>();

    // ── Process each event ────────────────────────────────────────────────
    for (const raw of rawEvents) {
      // Intra-batch duplicate: same txHash appeared earlier in this tick.
      if (seenInBatch.has(raw.txHash)) {
        duplicates += 1;
        continue;
      }
      seenInBatch.add(raw.txHash);

      const payload = decoder.decode(raw);
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
        }
      }
    }

    // Advance cursor to the last event id in this batch.
    if (rawEvents.length > 0) {
      this.cursor = rawEvents[rawEvents.length - 1]!.id;
    }

    return {
      processed: rawEvents.length,
      imported,
      duplicates,
      cursor: this.cursor
    };
  }
}

// ─── SorobanRpcEventSource ────────────────────────────────────────────────────

/**
 * Production event source that calls the Soroban RPC `getEvents` endpoint.
 * Actual HTTP call is a placeholder — replace with the real SDK call when
 * the Stellar JS SDK is wired in.
 */
export class SorobanRpcEventSource implements HorizonEventSource {
  constructor(private options: SorobanRpcEventSourceOptions) {}

  async fetchEvents(_opts: { cursor: string | null; limit: number }): Promise<RawHorizonEvent[]> {
    // TODO: replace with real Soroban RPC call via @stellar/stellar-sdk
    // e.g. await server.getEvents({ startLedger, filters, limit })
    return [];
  }
}
