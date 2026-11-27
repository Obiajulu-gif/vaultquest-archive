"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvalidPoolTransitionError = exports.POOL_TRANSITION_REASON_CODE = exports.POOL_TRANSITIONS = exports.POOL_STATE_ALIASES = exports.POOL_STATE_INPUTS = exports.CONTRACT_POOL_STATUSES = exports.TERMINAL_POOL_STATES = exports.CANONICAL_POOL_STATES = exports.POOL_STATES = void 0;
exports.normalizePoolState = normalizePoolState;
exports.isTerminalPoolState = isTerminalPoolState;
exports.allowedPoolTransitions = allowedPoolTransitions;
exports.canTransitionPool = canTransitionPool;
exports.assertPoolTransition = assertPoolTransition;
exports.transitionPool = transitionPool;
/** Canonical lifecycle states. `completed` and `cancelled` are terminal. */
exports.POOL_STATES = {
    DRAFT: "draft",
    UPCOMING: "upcoming",
    ACTIVE: "active",
    PAUSED: "paused",
    MATURED: "matured",
    SETTLING: "settling",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
};
/** Canonical states in lifecycle order. */
exports.CANONICAL_POOL_STATES = [
    exports.POOL_STATES.DRAFT,
    exports.POOL_STATES.UPCOMING,
    exports.POOL_STATES.ACTIVE,
    exports.POOL_STATES.PAUSED,
    exports.POOL_STATES.MATURED,
    exports.POOL_STATES.SETTLING,
    exports.POOL_STATES.COMPLETED,
    exports.POOL_STATES.CANCELLED,
];
/** States that can never transition again. */
exports.TERMINAL_POOL_STATES = [
    exports.POOL_STATES.COMPLETED,
    exports.POOL_STATES.CANCELLED,
];
/**
 * On-chain vocabulary mirrored from
 * `stellar-wallet-connect/src/vault/contract/types.ts` `PoolStatus`. Used by
 * the API layer (saved pools, imports) so it validates the same tokens the
 * contract/UI emit instead of a hand-copied subset.
 */
exports.CONTRACT_POOL_STATUSES = [
    "open",
    "locked",
    "drawing",
    "settled",
    "closed",
    "cancelled",
];
/**
 * Every accepted input token for a pool status: the canonical states plus the
 * on-chain/legacy aliases. The API validates against this list; the domain
 * model normalizes each token to a canonical state.
 */
exports.POOL_STATE_INPUTS = [
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
];
/**
 * Alias table: every accepted input token maps to exactly one canonical state.
 *
 * `open/locked/drawing/settled/pending/canceled` are the legacy/on-chain tokens
 * from the pre-#763 status module; `closed` is the contract's terminal token
 * (docs/API_REFERENCE.md: "Round completed"). Unknown tokens are NOT aliased —
 * `normalizePoolState` returns `null` for them so a caller can reject rather
 * than silently coerce to `draft`.
 */
exports.POOL_STATE_ALIASES = {
    draft: exports.POOL_STATES.DRAFT,
    upcoming: exports.POOL_STATES.UPCOMING,
    active: exports.POOL_STATES.ACTIVE,
    paused: exports.POOL_STATES.PAUSED,
    matured: exports.POOL_STATES.MATURED,
    settling: exports.POOL_STATES.SETTLING,
    completed: exports.POOL_STATES.COMPLETED,
    cancelled: exports.POOL_STATES.CANCELLED,
    open: exports.POOL_STATES.ACTIVE,
    locked: exports.POOL_STATES.PAUSED,
    drawing: exports.POOL_STATES.SETTLING,
    settled: exports.POOL_STATES.COMPLETED,
    closed: exports.POOL_STATES.COMPLETED,
    pending: exports.POOL_STATES.UPCOMING,
    canceled: exports.POOL_STATES.CANCELLED,
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
exports.POOL_TRANSITIONS = {
    [exports.POOL_STATES.DRAFT]: [exports.POOL_STATES.UPCOMING, exports.POOL_STATES.CANCELLED],
    [exports.POOL_STATES.UPCOMING]: [exports.POOL_STATES.ACTIVE, exports.POOL_STATES.CANCELLED],
    [exports.POOL_STATES.ACTIVE]: [
        exports.POOL_STATES.PAUSED,
        exports.POOL_STATES.MATURED,
        exports.POOL_STATES.CANCELLED,
    ],
    [exports.POOL_STATES.PAUSED]: [exports.POOL_STATES.ACTIVE, exports.POOL_STATES.CANCELLED],
    [exports.POOL_STATES.MATURED]: [exports.POOL_STATES.SETTLING, exports.POOL_STATES.CANCELLED],
    [exports.POOL_STATES.SETTLING]: [exports.POOL_STATES.COMPLETED, exports.POOL_STATES.ACTIVE],
    [exports.POOL_STATES.COMPLETED]: [],
    [exports.POOL_STATES.CANCELLED]: [],
};
/**
 * Stable reason code returned on every rejected transition. Must stay in sync
 * with `VAULT_REJECTION_REASONS.INVALID_STATE_TRANSITION` in
 * `lib/rejectionReasons.ts` (asserted by `lib/pool-lifecycle.test.ts`).
 */
exports.POOL_TRANSITION_REASON_CODE = "VAULT_INVALID_STATE_TRANSITION";
/**
 * Resolves any accepted pool-status token to its canonical {@link PoolState}.
 * Returns `null` for unknown/empty input (do not confuse with `draft`).
 */
function normalizePoolState(input) {
    if (input == null)
        return null;
    const key = String(input).trim().toLowerCase();
    if (!key)
        return null;
    return exports.POOL_STATE_ALIASES[key] ?? null;
}
/** True when `state` is one of the terminal canonical states. */
function isTerminalPoolState(input) {
    const state = normalizePoolState(input);
    return state !== null && exports.TERMINAL_POOL_STATES.includes(state);
}
/** Legal next states from `input`, or an empty list for unknown/terminal input. */
function allowedPoolTransitions(input) {
    const state = normalizePoolState(input);
    return state === null ? [] : exports.POOL_TRANSITIONS[state];
}
/**
 * Whether `from -> to` is a legal transition. Both inputs are normalized first,
 * so `canTransitionPool("open", "settled")` is the same as
 * `canTransitionPool("active", "completed")`.
 *
 * Same-state "transitions" are rejected: a no-op is not a transition and must
 * not emit a spurious audit event.
 */
function canTransitionPool(from, to) {
    const source = normalizePoolState(from);
    const target = normalizePoolState(to);
    if (source === null || target === null || source === target)
        return false;
    return exports.POOL_TRANSITIONS[source].includes(target);
}
/**
 * Typed error thrown by {@link assertPoolTransition} for any rejected edge.
 * Carries the stable `reasonCode` plus the raw `from`/`to` inputs so callers
 * can map it onto the existing rejection-explanation catalog.
 */
class InvalidPoolTransitionError extends Error {
    reasonCode;
    from;
    to;
    constructor(from, to, reasonCode = exports.POOL_TRANSITION_REASON_CODE) {
        super(`Invalid pool transition from "${from}" to "${to}"`);
        this.name = "InvalidPoolTransitionError";
        this.reasonCode = reasonCode;
        this.from = from;
        this.to = to;
    }
}
exports.InvalidPoolTransitionError = InvalidPoolTransitionError;
/**
 * Asserts that `from -> to` is legal, returning the normalized pair on success
 * and throwing {@link InvalidPoolTransitionError} otherwise.
 */
function assertPoolTransition(from, to) {
    const source = normalizePoolState(from);
    const target = normalizePoolState(to);
    if (source === null ||
        target === null ||
        source === target ||
        !exports.POOL_TRANSITIONS[source].includes(target)) {
        throw new InvalidPoolTransitionError(from == null ? "unknown" : String(from), to == null ? "unknown" : String(to));
    }
    return { from: source, to: target };
}
function resolveNow(now) {
    if (now == null)
        return Date.now();
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
function transitionPool(record, to, ctx = {}) {
    const { from, to: target } = assertPoolTransition(record.status, to);
    const event = {
        type: "pool.status_changed",
        from,
        to: target,
        actor: ctx.actor ?? null,
        at: resolveNow(ctx.now),
        ...(ctx.reason === undefined ? {} : { reason: ctx.reason }),
    };
    const next = { ...record, status: target };
    ctx.onTransition?.(event);
    return { record: next, event };
}
//# sourceMappingURL=pool-lifecycle.js.map