import { AppError } from "../errors.js";
import { ERROR_CODES, type ActionStatus } from "../constants.js";
import { ledgerOfEventId } from "./stellarIndexer.js";

/**
 * Status priority rank for breaking ties when records share identical effective timestamps.
 * Lower rank means higher priority in descending sort order (e.g. pending items requiring attention first).
 */
export const STATUS_PRIORITY_RANK: Record<string, number> = {
  pending: 0,
  submitted: 1,
  confirmed: 2,
  reverted: 3,
  orphaned: 4,
  failed: 5,
};

export interface MixedRecordOrEvent {
  id: string;
  status?: string | ActionStatus;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  submittedAt?: Date | string | null;
  confirmedAt?: Date | string | null;
  ledgerClosedAt?: Date | string | null;
  ledgerSequence?: number | null;
  finalizedLedger?: number | null;
  observedLedger?: number | null;
  txIndex?: number | null;
  opIndex?: number | null;
  eventIndex?: number | null;
  walletAddress?: string | null;
  [key: string]: unknown;
}

export interface SortCursorPayload {
  v: number;
  t: number; // effective timestamp in ms
  s: number; // status rank
  l: number; // ledger sequence or 0
  id: string; // unique identifier
  w?: string; // wallet address scope (optional)
  k?: string; // sort key identifier (optional)
}

export type SortDirection = "asc" | "desc";

export interface PaginationOptions {
  limit: number;
  cursor?: string | null;
  direction?: SortDirection;
  scope?: {
    walletAddress?: string;
    sortKey?: string;
  };
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
  hasMore: boolean;
}

/**
 * Extracts the effective timestamp for a record based on its lifecycle status.
 *
 * Precedence:
 * 1. For confirmed records: confirmedAt ?? ledgerClosedAt ?? updatedAt ?? createdAt
 * 2. For submitted records: submittedAt ?? updatedAt ?? createdAt
 * 3. For terminal non-confirmed (reverted, orphaned, failed): updatedAt ?? createdAt
 * 4. For pending: createdAt ?? updatedAt
 * 5. General fallback: newest available timestamp or unix epoch 0
 */
export function getEffectiveTimestampMs(record: MixedRecordOrEvent): number {
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";

  let candidate: Date | string | null | undefined = null;

  if (status === "confirmed") {
    candidate = record.confirmedAt ?? record.ledgerClosedAt ?? record.updatedAt ?? record.createdAt;
  } else if (status === "submitted") {
    candidate = record.submittedAt ?? record.updatedAt ?? record.createdAt;
  } else if (status === "reverted" || status === "orphaned" || status === "failed") {
    candidate = record.updatedAt ?? record.createdAt;
  } else if (status === "pending") {
    candidate = record.createdAt ?? record.updatedAt;
  } else {
    candidate =
      record.confirmedAt ??
      record.ledgerClosedAt ??
      record.submittedAt ??
      record.updatedAt ??
      record.createdAt;
  }

  if (!candidate) return 0;
  if (candidate instanceof Date) return candidate.getTime();
  const parsed = new Date(candidate).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Computes numeric status rank for tie-breaking.
 */
export function getStatusRank(status?: string | ActionStatus | null): number {
  if (!status) return 99;
  const key = String(status).toLowerCase();
  return STATUS_PRIORITY_RANK[key] ?? 99;
}

/**
 * Computes on-chain ledger sequence coordinate for tie-breaking.
 */
export function getLedgerSequence(record: MixedRecordOrEvent): number {
  if (record.ledgerSequence != null) return record.ledgerSequence;
  if (record.finalizedLedger != null) return record.finalizedLedger;
  if (record.observedLedger != null) return record.observedLedger;
  if (typeof record.sorobanEventId === "string") {
    const fromId = ledgerOfEventId(record.sorobanEventId);
    if (fromId !== null) return fromId;
  }
  return 0;
}

/**
 * Deterministically compares two mixed-status records or events.
 *
 * Guarantees a total ordering relation:
 * 1. Effective timestamp (descending or ascending)
 * 2. Status priority rank (ascending: pending first)
 * 3. On-chain ledger coordinate (descending: higher ledger first)
 * 4. Soroban event ID / Event/Tx index (descending)
 * 5. Record ID (strict lexicographical tie-breaker)
 */
export function compareMixedStatus<T extends MixedRecordOrEvent>(
  a: T,
  b: T,
  direction: SortDirection = "desc"
): number {
  if (a === b) return 0;
  if (!a.id || !b.id) {
    throw AppError.validation("record missing required unique id for deterministic sorting");
  }

  // 1. Primary: Effective Timestamp
  const timeA = getEffectiveTimestampMs(a);
  const timeB = getEffectiveTimestampMs(b);

  if (timeA !== timeB) {
    return direction === "desc" ? timeB - timeA : timeA - timeB;
  }

  // 2. Secondary: Status Rank Tie-Breaker
  const rankA = getStatusRank(a.status);
  const rankB = getStatusRank(b.status);
  if (rankA !== rankB) {
    // In desc order, lower rank (e.g. 0: pending) comes before higher rank (5: failed)
    return direction === "desc" ? rankA - rankB : rankB - rankA;
  }

  // 3. Tertiary: Ledger Sequence Tie-Breaker
  const seqA = getLedgerSequence(a);
  const seqB = getLedgerSequence(b);
  if (seqA !== seqB) {
    return direction === "desc" ? seqB - seqA : seqA - seqB;
  }

  // 4. Quaternary: Soroban event ID (TOID-ordered) or Event/Tx index
  if (a.sorobanEventId && b.sorobanEventId && a.sorobanEventId !== b.sorobanEventId) {
    const cmpEvent = String(a.sorobanEventId).localeCompare(String(b.sorobanEventId));
    return direction === "desc" ? -cmpEvent : cmpEvent;
  }
  const idxA = a.eventIndex ?? a.txIndex ?? 0;
  const idxB = b.eventIndex ?? b.txIndex ?? 0;
  if (idxA !== idxB) {
    return direction === "desc" ? idxB - idxA : idxA - idxB;
  }

  // 5. Final: Strict Lexicographical ID Tie-Breaker
  const cmp = a.id.localeCompare(b.id);
  return direction === "desc" ? -cmp : cmp;
}

/**
 * Encodes a composite cursor representing the exact sort position.
 */
export function encodeSortCursor(
  record: MixedRecordOrEvent,
  scope?: { walletAddress?: string; sortKey?: string }
): string {
  if (!record.id) {
    throw AppError.validation("cannot encode cursor for record without id");
  }

  const payload: SortCursorPayload = {
    v: 1,
    t: getEffectiveTimestampMs(record),
    s: getStatusRank(record.status),
    l: getLedgerSequence(record),
    id: record.id,
    ...(scope?.walletAddress ? { w: scope.walletAddress } : {}),
    ...(scope?.sortKey ? { k: scope.sortKey } : {}),
  };

  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

/**
 * Decodes and validates a sort cursor.
 */
export function decodeSortCursor(
  cursorStr: string,
  expectedScope?: { walletAddress?: string; sortKey?: string }
): SortCursorPayload {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursorStr, "base64url").toString("utf-8");
    parsed = JSON.parse(json);
  } catch {
    throw AppError.badRequest(ERROR_CODES.INVALID_CURSOR, "cursor is malformed or invalid base64url");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw AppError.badRequest(ERROR_CODES.INVALID_CURSOR, "cursor payload must be an object");
  }

  const payload = parsed as Record<string, unknown>;
  if (payload.v !== 1 || typeof payload.t !== "number" || typeof payload.id !== "string") {
    throw AppError.badRequest(ERROR_CODES.INVALID_CURSOR, "cursor payload missing required fields");
  }

  // Validate sort key scope if requested
  if (expectedScope?.sortKey && payload.k && payload.k !== expectedScope.sortKey) {
    throw AppError.badRequest(
      ERROR_CODES.CURSOR_ORDER_MISMATCH,
      `cursor sort key mismatch: expected '${expectedScope.sortKey}', got '${payload.k}'`
    );
  }

  // Validate wallet scope for multi-tenant isolation
  if (expectedScope?.walletAddress && payload.w && payload.w !== expectedScope.walletAddress) {
    throw AppError.forbidden("cursor belongs to a different wallet scope");
  }

  return {
    v: payload.v,
    t: payload.t,
    s: typeof payload.s === "number" ? payload.s : 99,
    l: typeof payload.l === "number" ? payload.l : 0,
    id: payload.id,
    w: typeof payload.w === "string" ? payload.w : undefined,
    k: typeof payload.k === "string" ? payload.k : undefined,
  };
}

export class DeterministicSortService {
  /**
   * Sorts an array of mixed-status records or events deterministically in-place or copied.
   * Time complexity: O(N log N). Space complexity: O(1) auxiliary.
   */
  sort<T extends MixedRecordOrEvent>(
    records: readonly T[],
    direction: SortDirection = "desc"
  ): T[] {
    const copy = [...records];
    return copy.sort((a, b) => compareMixedStatus(a, b, direction));
  }

  /**
   * Paginates through an array of mixed-status records deterministically.
   */
  paginate<T extends MixedRecordOrEvent>(
    records: readonly T[],
    options: PaginationOptions
  ): PaginatedResult<T> {
    const { limit, cursor, direction = "desc", scope } = options;

    if (limit <= 0) {
      throw AppError.validation("limit must be greater than 0");
    }

    // 1. Sort all records deterministically
    const sorted = this.sort(records, direction);

    let startIndex = 0;

    // 2. If cursor is provided, seek to the element right after the cursor
    if (cursor) {
      const decoded = decodeSortCursor(cursor, scope);
      const cursorSynthetic: MixedRecordOrEvent = {
        id: decoded.id,
        createdAt: new Date(decoded.t),
        status: Object.keys(STATUS_PRIORITY_RANK).find(
          (k) => STATUS_PRIORITY_RANK[k] === decoded.s
        ),
        ledgerSequence: decoded.l,
      };

      // Seek position in sorted list
      const idx = sorted.findIndex((item) => {
        // Exact id match
        if (item.id === decoded.id) return true;
        // Or if item already passes the cursor in sort order
        return compareMixedStatus(item, cursorSynthetic, direction) > 0;
      });

      if (idx !== -1) {
        // If matched by exact ID, the next page starts at idx + 1
        startIndex = sorted[idx]!.id === decoded.id ? idx + 1 : idx;
      } else {
        // Cursor points past all items
        startIndex = sorted.length;
      }
    }

    const pagedItems = sorted.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < sorted.length;
    const nextCursor =
      hasMore && pagedItems.length > 0
        ? encodeSortCursor(pagedItems[pagedItems.length - 1]!, scope)
        : null;

    return {
      items: pagedItems,
      nextCursor,
      total: sorted.length,
      hasMore,
    };
  }
}

export const deterministicSortService = new DeterministicSortService();
