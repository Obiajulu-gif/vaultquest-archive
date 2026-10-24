/**
 * Deterministic conflict resolver for multi-client edits (#983).
 *
 * Several tabs or devices may edit the same record from the same (or an
 * older) version. Instead of letting whichever request lands last silently
 * overwrite the others, every field remembers which edit wrote it:
 *
 *   clock[field] = { version that wrote it, stamp of the edit that wrote it }
 *
 * An incoming edit names the record version it was composed against
 * (`baseVersion`) and carries a stamp `{ at, clientId }`. Per changed field:
 *
 *   - same value as stored               → unchanged (retries are no-ops)
 *   - field not written after baseVersion → applied (the editor saw the value it replaces)
 *   - field written after baseVersion     → concurrent: the higher stamp wins,
 *                                           ties broken by clientId
 *
 * The outcome is a pure function of the stored record and the edit — no
 * wall clock, no randomness — and, for concurrent edits, independent of the
 * order they arrive in: the same set of edits converges to the same values
 * on every replica. Edits to different fields never conflict.
 *
 * Lives in `lib/` (like `lib/rbac.ts`) so a client can compute the same
 * outcome the server enforces.
 *
 * Complexity: O(k log k) time for k changed fields (fields are visited in
 * sorted order so result lists are deterministic), O(n) space for a record
 * of n fields.
 */

export interface EditStamp {
  /** Milliseconds since epoch when the client made the edit. */
  at: number;
  /** Stable id of the editing client (tab or device); breaks ties deterministically. */
  clientId: string;
}

export interface FieldClock {
  /** Record version whose write set this field. */
  version: number;
  /** Stamp of the edit that set it. */
  stamp: EditStamp;
}

export type FieldClocks<T> = Partial<Record<keyof T & string, FieldClock>>;

export interface VersionedRecord<T> {
  values: T;
  /** Increments once per write that changes at least one field. */
  version: number;
  clocks: FieldClocks<T>;
}

export interface FieldEdit<T> {
  /** Version the client composed the edit against. */
  baseVersion: number;
  stamp: EditStamp;
  /** Only the fields the client changed; `undefined` entries are ignored. */
  changes: Partial<T>;
}

export interface RejectedField<T> {
  field: keyof T & string;
  /** Stamp of the concurrent edit that keeps the field. */
  winner: EditStamp;
}

export interface EditResolution<T> {
  values: T;
  version: number;
  clocks: FieldClocks<T>;
  applied: Array<keyof T & string>;
  rejected: Array<RejectedField<T>>;
  unchanged: Array<keyof T & string>;
}

export class EditResolutionError extends Error {
  constructor(readonly code: "BASE_VERSION_AHEAD", message: string) {
    super(message);
    this.name = "EditResolutionError";
  }
}

/** Total order on stamps: time first, then clientId (code-unit order). */
export function compareStamps(a: EditStamp, b: EditStamp): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.clientId === b.clientId) return 0;
  return a.clientId < b.clientId ? -1 : 1;
}

/** Value equality for record fields: Dates by instant, everything else by SameValue. */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return Object.is(a, b);
}

/**
 * Resolves `edit` against `current`. Throws `EditResolutionError` when the
 * edit claims a base version the record never had.
 */
export function resolveEdit<T extends Record<string, unknown>>(
  current: VersionedRecord<T>,
  edit: FieldEdit<T>,
  equals: (a: unknown, b: unknown) => boolean = sameFieldValue,
): EditResolution<T> {
  if (edit.baseVersion > current.version) {
    throw new EditResolutionError(
      "BASE_VERSION_AHEAD",
      `edit is based on version ${edit.baseVersion}, but the record is only at version ${current.version}`,
    );
  }

  const nextVersion = current.version + 1;
  const values: T = { ...current.values };
  const clocks: FieldClocks<T> = { ...current.clocks };
  const applied: Array<keyof T & string> = [];
  const rejected: Array<RejectedField<T>> = [];
  const unchanged: Array<keyof T & string> = [];

  for (const field of (Object.keys(edit.changes) as Array<keyof T & string>).sort()) {
    const incoming = edit.changes[field];
    if (incoming === undefined) continue;
    if (equals(incoming, current.values[field])) {
      unchanged.push(field);
      continue;
    }
    const clock = current.clocks[field];
    const concurrent = clock !== undefined && clock.version > edit.baseVersion;
    if (concurrent && compareStamps(edit.stamp, clock.stamp) <= 0) {
      rejected.push({ field, winner: clock.stamp });
      continue;
    }
    values[field] = incoming as T[typeof field];
    clocks[field] = { version: nextVersion, stamp: edit.stamp };
    applied.push(field);
  }

  return {
    values,
    version: applied.length > 0 ? nextVersion : current.version,
    clocks,
    applied,
    rejected,
    unchanged,
  };
}
