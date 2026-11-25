/**
 * Deterministic ordering for status and event lists (#1169).
 *
 * `Array.prototype.sort` is stable in every engine this project targets, but
 * stability only preserves whatever order the input array already had for two
 * entries whose primary sort key is equal (two events in the same millisecond,
 * two quests reaching the same status at the same timestamp — common with
 * batched writes or a coarse clock). That input order usually comes from
 * network fetch order or object insertion order, neither of which is
 * guaranteed to be the same from one call to the next. The result is a list
 * that re-renders in a different order on a refresh even though nothing in
 * the underlying data changed, which reads as a bug to a user and makes
 * snapshot/golden-fixture tests flaky.
 *
 * This module makes that deterministic: given the same set of entries, the
 * output order is always identical, independent of the order they arrived in.
 * It does so by adding an explicit, total tie-breaker on top of whatever
 * primary ordering the caller wants (by timestamp, by priority, ...), rather
 * than relying on array-stability-plus-incidental-input-order.
 *
 * Design notes:
 *  - Pure and dependency-free, the same rule `lib/rbac.ts` and
 *    `lib/ownership-transfer.ts` follow: no I/O, no mutation of the input
 *    array, safe to call on every render.
 *  - A primary key that is missing, `NaN`, or not comparable is treated as
 *    "unknown" and sorted after every entry with a real value, rather than
 *    silently coercing to `0`/`-Infinity` and landing at one end by accident
 *    (failure path: malformed input never throws, it just degrades to the
 *    tie-breaker).
 *  - The tie-breaker must itself be a stable, total order (an id string is
 *    the normal choice); two entries with the same tie-breaker value as well
 *    collapse to their original relative order, which is the best a sort can
 *    do when the caller has supplied no way to distinguish them.
 */

/** A comparator key: a finite number, or a string compared lexicographically. */
export type SortKey = number | string;

export interface DeterministicSortOptions<T> {
  /** The field to sort by first. Returning `undefined`/`NaN` means "unknown". */
  primary: (item: T) => SortKey | undefined;
  /** `"asc"` (default) or `"desc"` for the primary key. */
  primaryOrder?: "asc" | "desc";
  /** Total, stable tie-breaker used whenever the primary key is equal (or both unknown). */
  tieBreaker: (item: T) => SortKey;
}

function isUnknown(key: SortKey | undefined): boolean {
  return key === undefined || (typeof key === "number" && Number.isNaN(key));
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Sorts a copy of `items` deterministically: by `primary` (unknown values
 * last, regardless of `primaryOrder`), then by `tieBreaker` ascending whenever
 * two items compare equal on the primary key. Never mutates `items`.
 *
 * Calling this twice on the same (possibly differently-ordered) input
 * produces byte-identical output order — that is the whole point (retry
 * path: idempotent and order-independent).
 */
export function deterministicSort<T>(items: readonly T[], options: DeterministicSortOptions<T>): T[] {
  const { primary, tieBreaker, primaryOrder = "asc" } = options;
  const direction = primaryOrder === "desc" ? -1 : 1;

  return [...items].sort((a, b) => {
    const primaryA = primary(a);
    const primaryB = primary(b);
    const unknownA = isUnknown(primaryA);
    const unknownB = isUnknown(primaryB);

    if (unknownA && unknownB) {
      // Neither entry has an orderable primary key; fall straight to the tie-breaker.
    } else if (unknownA) {
      return 1; // unknown sorts after every known value
    } else if (unknownB) {
      return -1;
    } else {
      const primaryComparison = compareKeys(primaryA as SortKey, primaryB as SortKey) * direction;
      if (primaryComparison !== 0) return primaryComparison;
    }

    return compareKeys(tieBreaker(a), tieBreaker(b));
  });
}

/** A minimal shape for a status-history entry: when it happened, and its own stable id. */
export interface StatusEntryLike {
  id: string;
  statusChangedAt: number;
}

/**
 * Sorts status entries newest-first, with `id` as the deterministic
 * tie-breaker for entries that changed status at the same instant.
 */
export function sortStatusEntries<T extends StatusEntryLike>(entries: readonly T[]): T[] {
  return deterministicSort(entries, {
    primary: (entry) => entry.statusChangedAt,
    primaryOrder: "desc",
    tieBreaker: (entry) => entry.id,
  });
}

/** A minimal shape for an audit/notification event: when it occurred, and its own stable id. */
export interface EventEntryLike {
  id: string;
  occurredAt: number;
}

/**
 * Sorts events oldest-first (the natural reading order for a history/audit
 * log), with `id` as the deterministic tie-breaker for events recorded in the
 * same instant.
 */
export function sortEventEntries<T extends EventEntryLike>(entries: readonly T[]): T[] {
  return deterministicSort(entries, {
    primary: (entry) => entry.occurredAt,
    primaryOrder: "asc",
    tieBreaker: (entry) => entry.id,
  });
}
