/**
 * Safe ownership transfer with pending acceptance and expiry (#999).
 *
 * Single source of truth for handing ownership of a resource (a saved pool, an
 * export bundle, a maintainer-owned record) from one party to another without
 * ever leaving the resource ownerless or double-owned. Ownership only moves
 * when the named recipient *accepts* an outstanding offer, and an offer that is
 * not accepted in time *expires* instead of transferring. This is the classic
 * two-phase handover: the sender proposes, the recipient confirms.
 *
 * Design notes / tradeoffs:
 *
 *  - This module is deliberately dependency-free (no relative imports), the same
 *    rule `lib/pool-lifecycle.ts` and `lib/rbac.ts` follow, so the backend can
 *    import it across the workspace under Node ESM/NodeNext and the Next bundler
 *    can bundle it unchanged.
 *
 *  - The state machine is pure: the transition helpers never mutate their input
 *    and perform no I/O. Side effects (persisting, auditing, notifying) are
 *    handed to an optional `onEvent` sink, mirroring `transitionPool`'s
 *    `onTransition`. See docs/OWNERSHIP_TRANSFER.md.
 *
 *  - Expiry is evaluated against an injectable clock (`ctx.now`), never a hidden
 *    `Date.now()`, so tests are deterministic and a batch sweep can be pinned to
 *    a single instant. A `pending` offer whose `expiresAt` has elapsed is
 *    *read* as expired by {@link effectiveTransferState} before it is ever
 *    formally swept, so a late `accept` can never win a race against the clock.
 *
 *  - {@link OwnershipTransferRegistry} layers the authorization and
 *    single-pending-offer invariants on top of the pure machine. It is an
 *    in-memory reference implementation; a persistent store wires the same
 *    guards to a table (see the migration plan in docs/OWNERSHIP_TRANSFER.md).
 */

/** Lifecycle states for a transfer offer. Only `pending` is non-terminal. */
export const TRANSFER_STATES = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  DECLINED: "declined",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
} as const;

export type TransferState = (typeof TRANSFER_STATES)[keyof typeof TRANSFER_STATES];

/** States a transfer can never leave. */
export const TERMINAL_TRANSFER_STATES = [
  TRANSFER_STATES.ACCEPTED,
  TRANSFER_STATES.DECLINED,
  TRANSFER_STATES.CANCELLED,
  TRANSFER_STATES.EXPIRED,
] as const;

/**
 * Bounds on how long an offer may stay open. A zero/negative window is a
 * programming error; the 30-day ceiling matches `lib/access-grants.ts` so a
 * stale handover cannot linger indefinitely.
 */
export const MIN_TRANSFER_DURATION_MS = 1;
export const MAX_TRANSFER_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Stable reason codes carried by {@link OwnershipTransferError}. These are part
 * of the contract (API responses, logs, tests) and must not change without a
 * migration plan, the same rule as `lib/rejectionReasons.ts`.
 */
export const OWNERSHIP_TRANSFER_REASONS = {
  INVALID_PARTICIPANT: "OWNERSHIP_INVALID_PARTICIPANT",
  INVALID_DURATION: "OWNERSHIP_INVALID_DURATION",
  SELF_TRANSFER: "OWNERSHIP_SELF_TRANSFER",
  NOT_OWNER: "OWNERSHIP_NOT_OWNER",
  DUPLICATE_PENDING: "OWNERSHIP_DUPLICATE_PENDING",
  NOT_FOUND: "OWNERSHIP_NOT_FOUND",
  NOT_PENDING: "OWNERSHIP_NOT_PENDING",
  EXPIRED: "OWNERSHIP_EXPIRED",
  FORBIDDEN_ACCEPTOR: "OWNERSHIP_FORBIDDEN_ACCEPTOR",
  FORBIDDEN_INITIATOR: "OWNERSHIP_FORBIDDEN_INITIATOR",
} as const;

export type OwnershipTransferReason =
  (typeof OWNERSHIP_TRANSFER_REASONS)[keyof typeof OWNERSHIP_TRANSFER_REASONS];

/**
 * Typed error for every rejected ownership-transfer action. Carries the stable
 * `reasonCode` and a `retryable` hint so a caller can map it onto the existing
 * rejection-explanation catalog or decide whether to surface a retry.
 */
export class OwnershipTransferError extends Error {
  readonly reasonCode: OwnershipTransferReason;
  readonly retryable: boolean;

  constructor(reasonCode: OwnershipTransferReason, message: string, retryable = false) {
    super(message);
    this.name = "OwnershipTransferError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

/** An ownership-transfer offer. Immutable: transitions return a new object. */
export interface OwnershipTransfer {
  readonly id: string;
  /** Resource class, e.g. "saved_pool"; scopes `resourceId`. */
  readonly resourceType: string;
  readonly resourceId: string;
  /** Current owner that initiated the offer. */
  readonly from: string;
  /** The only party permitted to accept/decline. */
  readonly to: string;
  readonly state: TransferState;
  /** Epoch ms the offer was created. */
  readonly createdAt: number;
  /** Epoch ms after which the offer can no longer be accepted. */
  readonly expiresAt: number;
  /** Epoch ms the offer reached a terminal state; `null` while pending. */
  readonly resolvedAt: number | null;
  /** Actor that resolved the offer (`"system"` for an expiry sweep). */
  readonly resolvedBy: string | null;
  /** Optional free-text note recorded at initiation. */
  readonly note?: string;
}

/** Audit event emitted for every accepted action. See docs/NOTIFICATIONS.md. */
export interface OwnershipTransferEvent {
  readonly type:
    | "ownership.transfer_initiated"
    | "ownership.transfer_accepted"
    | "ownership.transfer_declined"
    | "ownership.transfer_cancelled"
    | "ownership.transfer_expired";
  readonly transferId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly from: string;
  readonly to: string;
  /** New owner once the action settles ownership; `null` otherwise. */
  readonly owner: string | null;
  /** Actor that triggered the event (`"system"` for an expiry sweep). */
  readonly actor: string;
  readonly at: number;
}

export interface TransferContext {
  now?: number | Date;
  /** Called exactly once, only after an action is accepted. No I/O here. */
  onEvent?: (event: OwnershipTransferEvent) => void;
}

export interface TransferActionResult {
  /** A new object; the input is never mutated. */
  readonly transfer: OwnershipTransfer;
  readonly event: OwnershipTransferEvent;
}

export interface CreateTransferParams {
  id: string;
  resourceType: string;
  resourceId: string;
  from: string;
  to: string;
  durationMs: number;
  note?: string;
}

function resolveNow(now?: number | Date): number {
  if (now == null) return Date.now();
  return typeof now === "number" ? now : now.getTime();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** True when `state` is one of the terminal states. */
export function isTerminalTransferState(state: TransferState): boolean {
  return (TERMINAL_TRANSFER_STATES as readonly TransferState[]).includes(state);
}

/**
 * The state a transfer *actually* has at `now`: a `pending` offer past its
 * `expiresAt` reads as `expired` even before it is formally swept. Every guard
 * below uses this, so a late accept/decline can never beat the clock.
 */
export function effectiveTransferState(
  transfer: OwnershipTransfer,
  now?: number | Date,
): TransferState {
  if (transfer.state !== TRANSFER_STATES.PENDING) return transfer.state;
  return resolveNow(now) >= transfer.expiresAt ? TRANSFER_STATES.EXPIRED : TRANSFER_STATES.PENDING;
}

/**
 * Builds a fresh `pending` offer. Pure: validates inputs and returns
 * `{ transfer, event }`, forwarding the event to `ctx.onEvent`. Throws
 * {@link OwnershipTransferError} for an empty participant, a self-transfer, or a
 * duration outside the allowed window — so an unsafe offer is never created.
 */
export function createOwnershipTransfer(
  params: CreateTransferParams,
  ctx: TransferContext = {},
): TransferActionResult {
  if (!nonEmpty(params.id) || !nonEmpty(params.resourceType) || !nonEmpty(params.resourceId)) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.INVALID_PARTICIPANT,
      "Transfer id, resourceType, and resourceId are required.",
    );
  }
  if (!nonEmpty(params.from) || !nonEmpty(params.to)) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.INVALID_PARTICIPANT,
      "Both from and to parties are required.",
    );
  }
  if (params.from === params.to) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.SELF_TRANSFER,
      "Cannot transfer ownership to the current owner.",
    );
  }
  if (
    !Number.isFinite(params.durationMs) ||
    params.durationMs < MIN_TRANSFER_DURATION_MS ||
    params.durationMs > MAX_TRANSFER_DURATION_MS
  ) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.INVALID_DURATION,
      `Duration must be between ${MIN_TRANSFER_DURATION_MS}ms and ${MAX_TRANSFER_DURATION_MS}ms.`,
    );
  }

  const at = resolveNow(ctx.now);
  const transfer: OwnershipTransfer = {
    id: params.id,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    from: params.from,
    to: params.to,
    state: TRANSFER_STATES.PENDING,
    createdAt: at,
    expiresAt: at + params.durationMs,
    resolvedAt: null,
    resolvedBy: null,
    ...(params.note === undefined ? {} : { note: params.note }),
  };

  const event: OwnershipTransferEvent = {
    type: "ownership.transfer_initiated",
    transferId: transfer.id,
    resourceType: transfer.resourceType,
    resourceId: transfer.resourceId,
    from: transfer.from,
    to: transfer.to,
    owner: null,
    actor: transfer.from,
    at,
  };

  ctx.onEvent?.(event);
  return { transfer, event };
}

function settle(
  transfer: OwnershipTransfer,
  state: TransferState,
  type: OwnershipTransferEvent["type"],
  actor: string,
  owner: string | null,
  at: number,
  ctx: TransferContext,
): TransferActionResult {
  const next: OwnershipTransfer = { ...transfer, state, resolvedAt: at, resolvedBy: actor };
  const event: OwnershipTransferEvent = {
    type,
    transferId: transfer.id,
    resourceType: transfer.resourceType,
    resourceId: transfer.resourceId,
    from: transfer.from,
    to: transfer.to,
    owner,
    actor,
    at,
  };
  ctx.onEvent?.(event);
  return { transfer: next, event };
}

/**
 * Guards a pending offer, throwing if it cannot be acted on at `now`. Returns
 * the resolved timestamp on success. Expiry is checked first so an elapsed
 * offer always reports `EXPIRED`, never `NOT_PENDING`.
 */
function requirePending(transfer: OwnershipTransfer, now: number): void {
  if (transfer.state !== TRANSFER_STATES.PENDING) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.NOT_PENDING,
      `Transfer ${transfer.id} is ${transfer.state}, not pending.`,
    );
  }
  if (now >= transfer.expiresAt) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.EXPIRED,
      `Transfer ${transfer.id} expired at ${transfer.expiresAt}.`,
      true,
    );
  }
}

/**
 * Recipient accepts the offer: ownership moves to `transfer.to`. Only the named
 * recipient may accept, and only while the offer is still pending and unexpired.
 */
export function acceptOwnershipTransfer(
  transfer: OwnershipTransfer,
  actor: string,
  ctx: TransferContext = {},
): TransferActionResult {
  const at = resolveNow(ctx.now);
  requirePending(transfer, at);
  if (actor !== transfer.to) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_ACCEPTOR,
      "Only the named recipient may accept this transfer.",
    );
  }
  return settle(transfer, TRANSFER_STATES.ACCEPTED, "ownership.transfer_accepted", actor, transfer.to, at, ctx);
}

/** Recipient declines the offer. Ownership stays with `transfer.from`. */
export function declineOwnershipTransfer(
  transfer: OwnershipTransfer,
  actor: string,
  ctx: TransferContext = {},
): TransferActionResult {
  const at = resolveNow(ctx.now);
  requirePending(transfer, at);
  if (actor !== transfer.to) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_ACCEPTOR,
      "Only the named recipient may decline this transfer.",
    );
  }
  return settle(transfer, TRANSFER_STATES.DECLINED, "ownership.transfer_declined", actor, transfer.from, at, ctx);
}

/** Initiator revokes a still-pending offer. Ownership stays with `transfer.from`. */
export function cancelOwnershipTransfer(
  transfer: OwnershipTransfer,
  actor: string,
  ctx: TransferContext = {},
): TransferActionResult {
  const at = resolveNow(ctx.now);
  requirePending(transfer, at);
  if (actor !== transfer.from) {
    throw new OwnershipTransferError(
      OWNERSHIP_TRANSFER_REASONS.FORBIDDEN_INITIATOR,
      "Only the initiator may cancel this transfer.",
    );
  }
  return settle(transfer, TRANSFER_STATES.CANCELLED, "ownership.transfer_cancelled", actor, transfer.from, at, ctx);
}

/**
 * Formally expires a pending offer whose window has elapsed. Idempotent for an
 * already-terminal offer (returns `null`), so a sweep that races another writer
 * cannot double-emit. Ownership stays with `transfer.from`.
 */
export function expireOwnershipTransfer(
  transfer: OwnershipTransfer,
  ctx: TransferContext = {},
): TransferActionResult | null {
  if (transfer.state !== TRANSFER_STATES.PENDING) return null;
  const at = resolveNow(ctx.now);
  if (at < transfer.expiresAt) return null;
  // Attribute the expiry to the real deadline, not the (later) sweep time, so
  // the audit trail reflects when the offer actually lapsed.
  return settle(
    transfer,
    TRANSFER_STATES.EXPIRED,
    "ownership.transfer_expired",
    "system",
    transfer.from,
    transfer.expiresAt,
    ctx,
  );
}

/**
 * In-memory registry enforcing the authorization and single-pending-offer
 * invariants on top of the pure state machine. Reference implementation for the
 * backend service described in docs/OWNERSHIP_TRANSFER.md; a persistent store
 * swaps the two `Map`s for tables and wires the same guards.
 */
export class OwnershipTransferRegistry {
  private readonly owners = new Map<string, string>();
  private readonly transfers = new Map<string, OwnershipTransfer>();
  /**
   * resourceKey -> id of the one pending offer for that resource. Kept in sync
   * on every create/settle so the single-pending-offer invariant is enforced in
   * O(1) instead of scanning every transfer. At most one entry per resource.
   */
  private readonly pendingByResource = new Map<string, string>();

  private key(resourceType: string, resourceId: string): string {
    return `${resourceType}:${resourceId}`;
  }

  /** Seed the current owner of a resource (e.g. on resource creation). */
  setInitialOwner(resourceType: string, resourceId: string, owner: string): void {
    if (!nonEmpty(owner)) {
      throw new OwnershipTransferError(OWNERSHIP_TRANSFER_REASONS.INVALID_PARTICIPANT, "Owner is required.");
    }
    this.owners.set(this.key(resourceType, resourceId), owner);
  }

  /** Current owner of a resource, or `null` if none is recorded. */
  ownerOf(resourceType: string, resourceId: string): string | null {
    return this.owners.get(this.key(resourceType, resourceId)) ?? null;
  }

  getTransfer(id: string): OwnershipTransfer | null {
    const transfer = this.transfers.get(id);
    return transfer ? { ...transfer } : null;
  }

  /**
   * All offers currently pending (and not yet past their expiry at `now`).
   * O(p) in the number of resources with a pending offer, via the index.
   */
  listPending(now?: number | Date): OwnershipTransfer[] {
    const out: OwnershipTransfer[] = [];
    for (const id of this.pendingByResource.values()) {
      const t = this.transfers.get(id);
      if (t && effectiveTransferState(t, now) === TRANSFER_STATES.PENDING) out.push({ ...t });
    }
    return out;
  }

  /** Drop the pending-index entry for a transfer once it is no longer pending. */
  private clearPending(transfer: OwnershipTransfer): void {
    const key = this.key(transfer.resourceType, transfer.resourceId);
    if (this.pendingByResource.get(key) === transfer.id) this.pendingByResource.delete(key);
  }

  /**
   * Initiate a transfer. Only the resource's current owner may initiate, and
   * only one offer may be pending per resource at a time. A prior *elapsed*
   * offer is swept first (O(1) via the index), which is also the retry path:
   * re-initiating after an expiry/decline/cancel is always allowed.
   */
  initiate(
    params: Omit<CreateTransferParams, "id"> & { id: string },
    ctx: TransferContext = {},
  ): TransferActionResult {
    const owner = this.ownerOf(params.resourceType, params.resourceId);
    if (owner === null || owner !== params.from) {
      throw new OwnershipTransferError(
        OWNERSHIP_TRANSFER_REASONS.NOT_OWNER,
        `${params.from} does not own ${params.resourceType}:${params.resourceId}.`,
      );
    }
    this.sweepResource(params.resourceType, params.resourceId, ctx);
    const key = this.key(params.resourceType, params.resourceId);
    if (this.pendingByResource.has(key)) {
      throw new OwnershipTransferError(
        OWNERSHIP_TRANSFER_REASONS.DUPLICATE_PENDING,
        `A transfer for ${params.resourceType}:${params.resourceId} is already pending.`,
      );
    }
    if (this.transfers.has(params.id)) {
      throw new OwnershipTransferError(
        OWNERSHIP_TRANSFER_REASONS.DUPLICATE_PENDING,
        `Transfer id ${params.id} already exists.`,
      );
    }
    const result = createOwnershipTransfer(params, ctx);
    this.transfers.set(result.transfer.id, result.transfer);
    this.pendingByResource.set(key, result.transfer.id);
    return result;
  }

  private require(id: string): OwnershipTransfer {
    const transfer = this.transfers.get(id);
    if (!transfer) {
      throw new OwnershipTransferError(OWNERSHIP_TRANSFER_REASONS.NOT_FOUND, `Transfer ${id} not found.`);
    }
    return transfer;
  }

  accept(id: string, actor: string, ctx: TransferContext = {}): TransferActionResult {
    const result = acceptOwnershipTransfer(this.require(id), actor, ctx);
    this.transfers.set(id, result.transfer);
    this.clearPending(result.transfer);
    // Settle ownership only after the pure machine accepts the action.
    this.owners.set(this.key(result.transfer.resourceType, result.transfer.resourceId), result.transfer.to);
    return result;
  }

  decline(id: string, actor: string, ctx: TransferContext = {}): TransferActionResult {
    const result = declineOwnershipTransfer(this.require(id), actor, ctx);
    this.transfers.set(id, result.transfer);
    this.clearPending(result.transfer);
    return result;
  }

  cancel(id: string, actor: string, ctx: TransferContext = {}): TransferActionResult {
    const result = cancelOwnershipTransfer(this.require(id), actor, ctx);
    this.transfers.set(id, result.transfer);
    this.clearPending(result.transfer);
    return result;
  }

  /** Expire the single pending offer for a resource if its window elapsed. O(1). */
  private sweepResource(resourceType: string, resourceId: string, ctx: TransferContext): void {
    const key = this.key(resourceType, resourceId);
    const id = this.pendingByResource.get(key);
    if (id === undefined) return;
    const t = this.transfers.get(id);
    if (!t) {
      this.pendingByResource.delete(key);
      return;
    }
    const expired = expireOwnershipTransfer(t, ctx);
    if (expired) {
      this.transfers.set(t.id, expired.transfer);
      this.pendingByResource.delete(key);
    }
  }

  /**
   * Expire every pending offer whose window has elapsed. Run from a cron sweep;
   * returns the events emitted so the caller can persist/notify them. O(p) in
   * the number of resources with a pending offer (via the index), not O(n) over
   * all historical transfers.
   */
  sweepExpired(ctx: TransferContext = {}): OwnershipTransferEvent[] {
    const events: OwnershipTransferEvent[] = [];
    for (const [key, id] of [...this.pendingByResource.entries()]) {
      const t = this.transfers.get(id);
      if (!t) {
        this.pendingByResource.delete(key);
        continue;
      }
      const expired = expireOwnershipTransfer(t, ctx);
      if (expired) {
        this.transfers.set(t.id, expired.transfer);
        this.pendingByResource.delete(key);
        events.push(expired.event);
      }
    }
    return events;
  }
}
