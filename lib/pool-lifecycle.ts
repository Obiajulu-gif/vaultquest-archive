/**
 * VaultQuest pool lifecycle state machine (#763).
 *
 * Single source of truth for the pool/vault lifecycle: the canonical states,
 * their legal transitions, on-chain/legacy aliases, and the audit event emitted
 * for every accepted change. UI presentation (`lib/pool-status.ts`), API
 * validation (`backend/src/schemas/savedPools.ts`), and any future writer must
 * all derive from this module so they cannot drift.
 *
 * Design notes / tradeoffs:
 *
 *  - This module is deliberately dependency-free (no relative imports). The
 *    backend imports it directly across the workspace (`../../../lib/pool-lifecycle.js`),
 *    so it must be safe to load under Node ESM/NodeNext as well as the Next
 *    bundler. Keeping it import-free is how the repo already shares
 *    `lib/rbac.ts` / `lib/safe-content.ts` with the backend.
 *
 *  - The state machine is pure: `transitionPool` never mutates its input and
 *    performs no I/O. Side effects (persisting/auditing/notifying) are handed
 *    to an optional `onTransition` sink. See docs/POOL_LIFECYCLE.md.
 *
 *  - The authoritative on-chain ordering lives in
 *    `contracts/drip-pool/src/lib.rs` (`RoundStatus::Open -> Locked -> Settled`)
 *    and `stellar-wallet-connect/src/vault/contract/types.ts`
 *    (`open | locked | drawing | settled | closed | cancelled`). The canonical
 *    model expresses that as `active -> matured -> settling -> completed`, with
 *    `paused` reserved for an operational hold (the contract's `is_emergency`
 *    circuit breaker). See "Contract reconciliation" in docs/POOL_LIFECYCLE.md.
 */

/** Canonical lifecycle states. `completed` and `cancelled` are terminal. */
export const POOL_STATES = {
  DRAFT: "draft",
  UPCOMING: "upcoming",
  ACTIVE: "active",
  PAUSED: "paused",
  MATURED: "matured",
  SETTLING: "settling",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
} as const;

export type PoolState = (typeof POOL_STATES)[keyof typeof POOL_STATES];

/** Canonical states in lifecycle order. */
export const CANONICAL_POOL_STATES = [
  POOL_STATES.DRAFT,
  POOL_STATES.UPCOMING,
  POOL_STATES.ACTIVE,
  POOL_STATES.PAUSED,
  POOL_STATES.MATURED,
  POOL_STATES.SETTLING,
  POOL_STATES.COMPLETED,
  POOL_STATES.CANCELLED,
] as const;

/** States that can never transition again. */
export const TERMINAL_POOL_STATES = [
  POOL_STATES.COMPLETED,
  POOL_STATES.CANCELLED,
] as const;

/**
 * On-chain vocabulary mirrored from
 * `stellar-wallet-connect/src/vault/contract/types.ts` `PoolStatus`. Used by
 * the API layer (saved pools, imports) so it validates the same tokens the
 * contract/UI emit instead of a hand-copied subset.
 */
export const CONTRACT_POOL_STATUSES = [
  "open",
  "locked",
  "drawing",
  "settled",
  "closed",
  "cancelled",
] as const;

export type ContractPoolStatus = (typeof CONTRACT_POOL_STATUSES)[number];

/**
 * Every accepted input token for a pool status: the canonical states plus the
 * on-chain/legacy aliases. The API validates against this list; the domain
 * model normalizes each token to a canonical state.
 */
export const POOL_STATE_INPUTS = [
  "draft",
  "upcoming",
  "active",
  "paused",
  "matured",
  "settling",
  "completed",
  "cancelled",
  "open",
  "locked",
  "drawing",
  "settled",
  "closed",
  "pending",
  "canceled",
] as const;

export type PoolStateInput = (typeof POOL_STATE_INPUTS)[number];

/**
 * Alias table: every accepted input token maps to exactly one canonical state.
 *
 * `open/locked/drawing/settled/pending/canceled` are the legacy/on-chain tokens
 * from the pre-#763 status module; `closed` is the contract's terminal token
 * (docs/API_REFERENCE.md: "Round completed"). Unknown tokens are NOT aliased —
 * `normalizePoolState` returns `null` for them so a caller can reject rather
 * than silently coerce to `draft`.
 */
export const POOL_STATE_ALIASES: Record<string, PoolState> = {
  draft: POOL_STATES.DRAFT,
  upcoming: POOL_STATES.UPCOMING,
  active: POOL_STATES.ACTIVE,
  paused: POOL_STATES.PAUSED,
  matured: POOL_STATES.MATURED,
  settling: POOL_STATES.SETTLING,
  completed: POOL_STATES.COMPLETED,
  cancelled: POOL_STATES.CANCELLED,
  open: POOL_STATES.ACTIVE,
  locked: POOL_STATES.PAUSED,
  drawing: POOL_STATES.SETTLING,
  settled: POOL_STATES.COMPLETED,
  closed: POOL_STATES.COMPLETED,
  pending: POOL_STATES.UPCOMING,
  canceled: POOL_STATES.CANCELLED,
};

/**
 * Legal transition edges. Every edge is deliberate; `completed` and
 * `cancelled` are sinks.
 *
 *  draft     -> upcoming | cancelled
 *  upcoming  -> active   | cancelled
 *  active    -> paused   | matured | cancelled
 *  paused    -> active   | cancelled
 *  matured   -> settling | cancelled
 *  settling  -> completed | active      (settlement failure reopens the pool)
 *  completed -> (terminal)
 *  cancelled -> (terminal)
 */
export const POOL_TRANSITIONS: Record<PoolState, readonly PoolState[]> = {
  [POOL_STATES.DRAFT]: [POOL_STATES.UPCOMING, POOL_STATES.CANCELLED],
  [POOL_STATES.UPCOMING]: [POOL_STATES.ACTIVE, POOL_STATES.CANCELLED],
  [POOL_STATES.ACTIVE]: [
    POOL_STATES.PAUSED,
    POOL_STATES.MATURED,
    POOL_STATES.CANCELLED,
  ],
  [POOL_STATES.PAUSED]: [POOL_STATES.ACTIVE, POOL_STATES.CANCELLED],
  [POOL_STATES.MATURED]: [POOL_STATES.SETTLING, POOL_STATES.CANCELLED],
  [POOL_STATES.SETTLING]: [POOL_STATES.COMPLETED, POOL_STATES.ACTIVE],
  [POOL_STATES.COMPLETED]: [],
  [POOL_STATES.CANCELLED]: [],
};

/**
 * Stable reason code returned on every rejected transition. Must stay in sync
 * with `VAULT_REJECTION_REASONS.INVALID_STATE_TRANSITION` in
 * `lib/rejectionReasons.ts` (asserted by `lib/pool-lifecycle.test.ts`).
 */
export const POOL_TRANSITION_REASON_CODE = "VAULT_INVALID_STATE_TRANSITION" as const;

/**
 * Resolves any accepted pool-status token to its canonical {@link PoolState}.
 * Returns `null` for unknown/empty input (do not confuse with `draft`).
 */
export function normalizePoolState(input?: string | null): PoolState | null {
  if (input == null) return null;
  const key = String(input).trim().toLowerCase();
  if (!key) return null;
  return POOL_STATE_ALIASES[key] ?? null;
}

/** True when `state` is one of the terminal canonical states. */
export function isTerminalPoolState(input?: string | null): boolean {
  const state = normalizePoolState(input);
  return state !== null && (TERMINAL_POOL_STATES as readonly PoolState[]).includes(state);
}

/** Legal next states from `input`, or an empty list for unknown/terminal input. */
export function allowedPoolTransitions(input?: string | null): readonly PoolState[] {
  const state = normalizePoolState(input);
  return state === null ? [] : POOL_TRANSITIONS[state];
}

/**
 * Whether `from -> to` is a legal transition. Both inputs are normalized first,
 * so `canTransitionPool("open", "settled")` is the same as
 * `canTransitionPool("active", "completed")`.
 *
 * Same-state "transitions" are rejected: a no-op is not a transition and must
 * not emit a spurious audit event.
 */
export function canTransitionPool(
  from?: string | null,
  to?: string | null,
): boolean {
  const source = normalizePoolState(from);
  const target = normalizePoolState(to);
  if (source === null || target === null || source === target) return false;
  return POOL_TRANSITIONS[source].includes(target);
}

/**
 * Typed error thrown by {@link assertPoolTransition} for any rejected edge.
 * Carries the stable `reasonCode` plus the raw `from`/`to` inputs so callers
 * can map it onto the existing rejection-explanation catalog.
 */
export class InvalidPoolTransitionError extends Error {
  readonly reasonCode: string;
  readonly from: string;
  readonly to: string;

  constructor(
    from: string,
    to: string,
    reasonCode: string = POOL_TRANSITION_REASON_CODE,
  ) {
    super(`Invalid pool transition from "${from}" to "${to}"`);
    this.name = "InvalidPoolTransitionError";
    this.reasonCode = reasonCode;
    this.from = from;
    this.to = to;
  }
}

/**
 * Asserts that `from -> to` is legal, returning the normalized pair on success
 * and throwing {@link InvalidPoolTransitionError} otherwise.
 */
export function assertPoolTransition(
  from?: string | null,
  to?: string | null,
): { from: PoolState; to: PoolState } {
  const source = normalizePoolState(from);
  const target = normalizePoolState(to);

  if (
    source === null ||
    target === null ||
    source === target ||
    !POOL_TRANSITIONS[source].includes(target)
  ) {
    throw new InvalidPoolTransitionError(
      from == null ? "unknown" : String(from),
      to == null ? "unknown" : String(to),
    );
  }

  return { from: source, to: target };
}

/**
 * Audit event emitted for an accepted transition. Follows the lifecycle-event
 * conventions in docs/NOTIFICATIONS.md (stable `type`, actor, timestamp) so it
 * can be persisted by an audit store and/or projected into a notification.
 */
export interface PoolAuditEvent {
  readonly type: "pool.status_changed";
  readonly from: PoolState;
  readonly to: PoolState;
  /** Actor that triggered the change; `null` when system/indexer driven. */
  readonly actor: string | null;
  /** Epoch milliseconds the transition was recorded. */
  readonly at: number;
  /** Optional human-readable reason (e.g. "settlement retry"). */
  readonly reason?: string;
}

export interface PoolTransitionContext {
  actor?: string;
  now?: number | Date;
  reason?: string;
  /**
   * Documented sink for the audit event. Called exactly once, only after the
   * transition is accepted. This module performs no I/O itself — callers wire
   * persistence/notifications here (see docs/POOL_LIFECYCLE.md).
   */
  onTransition?: (event: PoolAuditEvent) => void;
}

export interface PoolTransitionResult<T> {
  /** A new object; the input is never mutated. */
  readonly record: T & { status: PoolState };
  readonly event: PoolAuditEvent;
}

function resolveNow(now?: number | Date): number {
  if (now == null) return Date.now();
  return typeof now === "number" ? now : now.getTime();
}

/**
 * Applies a guarded `to` transition to a pool-like record.
 *
 * Pure and non-mutating: returns `{ record, event }` and forwards the event to
 * `ctx.onTransition` if supplied. Throws {@link InvalidPoolTransitionError} for
 * an illegal or unknown transition, so an invalid change can never be applied
 * or audited inconsistently with the model.
 */
export function transitionPool<T extends { status?: string | null }>(
  record: T,
  to: PoolState | PoolStateInput | (string & {}),
  ctx: PoolTransitionContext = {},
): PoolTransitionResult<T> {
  const { from, to: target } = assertPoolTransition(record.status, to);

  const event: PoolAuditEvent = {
    type: "pool.status_changed",
    from,
    to: target,
    actor: ctx.actor ?? null,
    at: resolveNow(ctx.now),
    ...(ctx.reason === undefined ? {} : { reason: ctx.reason }),
  };

  const next = { ...record, status: target } as T & { status: PoolState };

  ctx.onTransition?.(event);

  return { record: next, event };
}
