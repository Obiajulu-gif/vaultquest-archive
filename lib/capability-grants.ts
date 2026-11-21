/**
 * Expiring capability grants for sensitive actions (#1108).
 *
 * Time-boxed, resource-scoped, use-bounded capability tokens that gate
 * high-blast-radius sensitive actions (emergency pause, parameter override,
 * forced settlement, archive purge). Unlike coarse role assignments, a
 * capability grant:
 *
 *  1. Requires dual-control approval (`grantee !== approver`).
 *  2. Binds to an explicit set of sensitive action identifiers and a target
 *     resource (`resourceType:resourceId` or wildcard `*:*`).
 *  3. Bounds both wall-clock lifetime (`expiresAt`) and invocation count
 *     (`maxUses`, defaulting to 1 for single-use elevation).
 *  4. Supports idempotent retry via `operationId` so network retries of the
 *     guarded action do not double-consume a single-use grant.
 *  5. Emits an immutable audit trail for issuance, consumption, exhaustion,
 *     revocation, and expiry sweeps.
 */

export const CAPABILITY_GRANT_STATES = {
  ACTIVE: "active",
  EXHAUSTED: "exhausted",
  REVOKED: "revoked",
  EXPIRED: "expired",
} as const;

export type CapabilityGrantState =
  (typeof CAPABILITY_GRANT_STATES)[keyof typeof CAPABILITY_GRANT_STATES];

export const MIN_CAPABILITY_DURATION_MS = 1;
/** Sensitive capability grants are capped at 24 hours. */
export const MAX_CAPABILITY_DURATION_MS = 24 * 60 * 60 * 1000;
export const MAX_CAPABILITY_USES = 100;

export const CAPABILITY_GRANT_REASONS = {
  INVALID_INPUT: "CAPABILITY_INVALID_INPUT",
  INVALID_DURATION: "CAPABILITY_INVALID_DURATION",
  INVALID_MAX_USES: "CAPABILITY_INVALID_MAX_USES",
  SELF_APPROVAL: "CAPABILITY_SELF_APPROVAL",
  DUPLICATE_GRANT: "CAPABILITY_DUPLICATE_GRANT",
  NOT_FOUND: "CAPABILITY_NOT_FOUND",
  EXPIRED: "CAPABILITY_EXPIRED",
  REVOKED: "CAPABILITY_REVOKED",
  EXHAUSTED: "CAPABILITY_EXHAUSTED",
  FORBIDDEN_ACTOR: "CAPABILITY_FORBIDDEN_ACTOR",
  FORBIDDEN_ACTION: "CAPABILITY_FORBIDDEN_ACTION",
  FORBIDDEN_RESOURCE: "CAPABILITY_FORBIDDEN_RESOURCE",
  FORBIDDEN_REVOKE: "CAPABILITY_FORBIDDEN_REVOKE",
  FORBIDDEN_AUDIT: "CAPABILITY_FORBIDDEN_AUDIT",
} as const;

export type CapabilityGrantReason =
  (typeof CAPABILITY_GRANT_REASONS)[keyof typeof CAPABILITY_GRANT_REASONS];

export class CapabilityGrantError extends Error {
  readonly reasonCode: CapabilityGrantReason;
  readonly retryable: boolean;

  constructor(reasonCode: CapabilityGrantReason, message: string, retryable = false) {
    super(message);
    this.name = "CapabilityGrantError";
    this.reasonCode = reasonCode;
    this.retryable = retryable;
  }
}

export interface CapabilityGrant {
  readonly id: string;
  readonly grantee: string;
  readonly approver: string;
  readonly actions: readonly string[];
  readonly resourceType: string;
  readonly resourceId: string;
  readonly reason: string;
  readonly state: CapabilityGrantState;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly maxUses: number;
  readonly usesConsumed: number;
  readonly usesRemaining: number;
  readonly consumedOperationIds: readonly string[];
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
}

export interface CapabilityGrantEvent {
  readonly type:
    | "capability.issued"
    | "capability.consumed"
    | "capability.exhausted"
    | "capability.revoked"
    | "capability.expired";
  readonly grantId: string;
  readonly grantee: string;
  readonly approver: string;
  readonly actor: string;
  readonly action?: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly operationId?: string;
  readonly usesRemaining: number;
  readonly at: number;
}

export interface CapabilityContext {
  now?: number | Date;
  onEvent?: (event: CapabilityGrantEvent) => void;
}

export interface IssueCapabilityGrantParams {
  id: string;
  grantee: string;
  approver: string;
  actions: readonly string[];
  resourceType: string;
  resourceId: string;
  reason: string;
  durationMs: number;
  /** Defaults to 1 (single-use capability grant). */
  maxUses?: number;
}

export interface ConsumeCapabilityParams {
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  /** Optional idempotency token so retries of the same operation do not burn extra uses. */
  operationId?: string;
}

export interface CapabilityTransitionResult {
  readonly grant: CapabilityGrant;
  readonly event: CapabilityGrantEvent;
  /** True when `operationId` matched an already-consumed operation on this grant. */
  readonly deduplicatedRetry?: boolean;
}

function resolveNow(now?: number | Date): number {
  if (now == null) return Date.now();
  return typeof now === "number" ? now : now.getTime();
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function effectiveCapabilityState(
  grant: CapabilityGrant,
  now?: number | Date,
): CapabilityGrantState {
  if (grant.state === CAPABILITY_GRANT_STATES.REVOKED) {
    return CAPABILITY_GRANT_STATES.REVOKED;
  }
  if (resolveNow(now) >= grant.expiresAt) {
    return CAPABILITY_GRANT_STATES.EXPIRED;
  }
  if (grant.usesRemaining <= 0 || grant.state === CAPABILITY_GRANT_STATES.EXHAUSTED) {
    return CAPABILITY_GRANT_STATES.EXHAUSTED;
  }
  return CAPABILITY_GRANT_STATES.ACTIVE;
}

export function issueCapabilityGrant(
  params: IssueCapabilityGrantParams,
  ctx: CapabilityContext = {},
): CapabilityTransitionResult {
  if (
    !nonEmpty(params.id) ||
    !nonEmpty(params.grantee) ||
    !nonEmpty(params.approver) ||
    !nonEmpty(params.resourceType) ||
    !nonEmpty(params.resourceId) ||
    !nonEmpty(params.reason)
  ) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.INVALID_INPUT,
      "id, grantee, approver, resourceType, resourceId, and reason are required.",
    );
  }

  const actions = (params.actions ?? []).map((a) => a.trim()).filter(Boolean);
  if (actions.length === 0) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.INVALID_INPUT,
      "At least one sensitive action identifier must be specified.",
    );
  }

  if (params.grantee === params.approver) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.SELF_APPROVAL,
      "Separation of duties violation: grantee and approver must be distinct actors.",
    );
  }

  if (
    !Number.isFinite(params.durationMs) ||
    params.durationMs < MIN_CAPABILITY_DURATION_MS ||
    params.durationMs > MAX_CAPABILITY_DURATION_MS
  ) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.INVALID_DURATION,
      `Duration must be between ${MIN_CAPABILITY_DURATION_MS}ms and ${MAX_CAPABILITY_DURATION_MS}ms.`,
    );
  }

  const maxUses = params.maxUses ?? 1;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_CAPABILITY_USES) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.INVALID_MAX_USES,
      `maxUses must be an integer between 1 and ${MAX_CAPABILITY_USES}.`,
    );
  }

  const at = resolveNow(ctx.now);
  const grant: CapabilityGrant = {
    id: params.id,
    grantee: params.grantee,
    approver: params.approver,
    actions: Object.freeze([...new Set(actions)]),
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    reason: params.reason,
    state: CAPABILITY_GRANT_STATES.ACTIVE,
    createdAt: at,
    expiresAt: at + params.durationMs,
    maxUses,
    usesConsumed: 0,
    usesRemaining: maxUses,
    consumedOperationIds: Object.freeze([]),
    lastUsedAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
  };

  const event: CapabilityGrantEvent = {
    type: "capability.issued",
    grantId: grant.id,
    grantee: grant.grantee,
    approver: grant.approver,
    actor: grant.approver,
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
    usesRemaining: grant.usesRemaining,
    at,
  };

  ctx.onEvent?.(event);
  return { grant, event };
}

function matchesAction(grantedActions: readonly string[], requested: string): boolean {
  return grantedActions.includes("*") || grantedActions.includes(requested);
}

function matchesResource(
  grant: Pick<CapabilityGrant, "resourceType" | "resourceId">,
  resourceType: string,
  resourceId: string,
): boolean {
  const typeOk = grant.resourceType === "*" || grant.resourceType === resourceType;
  const idOk = grant.resourceId === "*" || grant.resourceId === resourceId;
  return typeOk && idOk;
}

/**
 * Authorize and consume one use of a capability grant for a sensitive action.
 *
 * If `params.operationId` was already consumed on this grant while the grant
 * remains unexpired and unrevoked, the call succeeds idempotently without
 * decrementing `usesRemaining` a second time.
 */
export function consumeCapabilityGrant(
  grant: CapabilityGrant,
  params: ConsumeCapabilityParams,
  ctx: CapabilityContext = {},
): CapabilityTransitionResult {
  const at = resolveNow(ctx.now);

  if (grant.state === CAPABILITY_GRANT_STATES.REVOKED) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.REVOKED,
      `Capability grant ${grant.id} has been revoked.`,
    );
  }

  if (at >= grant.expiresAt || grant.state === CAPABILITY_GRANT_STATES.EXPIRED) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.EXPIRED,
      `Capability grant ${grant.id} expired at ${grant.expiresAt}.`,
      true,
    );
  }

  if (params.actor !== grant.grantee) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.FORBIDDEN_ACTOR,
      `Actor ${params.actor} is not the grantee (${grant.grantee}) of capability ${grant.id}.`,
    );
  }

  if (!matchesAction(grant.actions, params.action)) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.FORBIDDEN_ACTION,
      `Action ${params.action} is not authorized by capability ${grant.id}.`,
    );
  }

  if (!matchesResource(grant, params.resourceType, params.resourceId)) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.FORBIDDEN_RESOURCE,
      `Resource ${params.resourceType}:${params.resourceId} does not match ${grant.resourceType}:${grant.resourceId}.`,
    );
  }

  // Idempotent retry check: if this exact operationId already succeeded under
  // this grant (and the grant is not revoked/expired), return without burning
  // an additional use.
  if (nonEmpty(params.operationId) && grant.consumedOperationIds.includes(params.operationId)) {
    const event: CapabilityGrantEvent = {
      type: "capability.consumed",
      grantId: grant.id,
      grantee: grant.grantee,
      approver: grant.approver,
      actor: params.actor,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      operationId: params.operationId,
      usesRemaining: grant.usesRemaining,
      at,
    };
    return { grant, event, deduplicatedRetry: true };
  }

  if (grant.usesRemaining <= 0 || grant.state === CAPABILITY_GRANT_STATES.EXHAUSTED) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.EXHAUSTED,
      `Capability grant ${grant.id} has exhausted all ${grant.maxUses} allowed uses.`,
      true,
    );
  }

  const usesConsumed = grant.usesConsumed + 1;
  const usesRemaining = grant.maxUses - usesConsumed;
  const nextState =
    usesRemaining === 0 ? CAPABILITY_GRANT_STATES.EXHAUSTED : CAPABILITY_GRANT_STATES.ACTIVE;
  const consumedOperationIds = nonEmpty(params.operationId)
    ? Object.freeze([...grant.consumedOperationIds, params.operationId])
    : grant.consumedOperationIds;

  const nextGrant: CapabilityGrant = {
    ...grant,
    state: nextState,
    usesConsumed,
    usesRemaining,
    consumedOperationIds,
    lastUsedAt: at,
  };

  const event: CapabilityGrantEvent = {
    type: nextState === CAPABILITY_GRANT_STATES.EXHAUSTED ? "capability.exhausted" : "capability.consumed",
    grantId: grant.id,
    grantee: grant.grantee,
    approver: grant.approver,
    actor: params.actor,
    action: params.action,
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    ...(nonEmpty(params.operationId) ? { operationId: params.operationId } : {}),
    usesRemaining,
    at,
  };

  ctx.onEvent?.(event);
  return { grant: nextGrant, event, deduplicatedRetry: false };
}

/**
 * Revoke a capability grant immediately. May be invoked by the original
 * approver, the grantee (self-relinquish), or a system/security-admin actor.
 */
export function revokeCapabilityGrant(
  grant: CapabilityGrant,
  actor: string,
  revokeReason = "manual_revocation",
  ctx: CapabilityContext = {},
): CapabilityTransitionResult {
  const at = resolveNow(ctx.now);
  const isAuthorized =
    actor === grant.approver ||
    actor === grant.grantee ||
    actor === "admin" ||
    actor === "system";

  if (!isAuthorized) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.FORBIDDEN_REVOKE,
      `Actor ${actor} is not authorized to revoke capability grant ${grant.id}.`,
    );
  }

  if (grant.state === CAPABILITY_GRANT_STATES.REVOKED) {
    throw new CapabilityGrantError(
      CAPABILITY_GRANT_REASONS.REVOKED,
      `Capability grant ${grant.id} is already revoked.`,
    );
  }

  const nextGrant: CapabilityGrant = {
    ...grant,
    state: CAPABILITY_GRANT_STATES.REVOKED,
    usesRemaining: 0,
    revokedAt: at,
    revokedBy: actor,
    revokeReason,
  };

  const event: CapabilityGrantEvent = {
    type: "capability.revoked",
    grantId: grant.id,
    grantee: grant.grantee,
    approver: grant.approver,
    actor,
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
    usesRemaining: 0,
    at,
  };

  ctx.onEvent?.(event);
  return { grant: nextGrant, event };
}

/**
 * Formally transition an active grant past its `expiresAt` into `expired`.
 * Idempotent: returns `null` if the grant is already terminal or not yet expired.
 */
export function expireCapabilityGrant(
  grant: CapabilityGrant,
  ctx: CapabilityContext = {},
): CapabilityTransitionResult | null {
  if (grant.state !== CAPABILITY_GRANT_STATES.ACTIVE) return null;
  const at = resolveNow(ctx.now);
  if (at < grant.expiresAt) return null;

  const nextGrant: CapabilityGrant = {
    ...grant,
    state: CAPABILITY_GRANT_STATES.EXPIRED,
    usesRemaining: 0,
  };

  const event: CapabilityGrantEvent = {
    type: "capability.expired",
    grantId: grant.id,
    grantee: grant.grantee,
    approver: grant.approver,
    actor: "system",
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
    usesRemaining: 0,
    at: grant.expiresAt,
  };

  ctx.onEvent?.(event);
  return { grant: nextGrant, event };
}

export class CapabilityGrantRegistry {
  private readonly grants = new Map<string, CapabilityGrant>();
  private readonly auditLog: CapabilityGrantEvent[] = [];

  private recordEvent(event: CapabilityGrantEvent): void {
    this.auditLog.push({ ...event });
  }

  issue(params: IssueCapabilityGrantParams, ctx: CapabilityContext = {}): CapabilityTransitionResult {
    if (this.grants.has(params.id)) {
      throw new CapabilityGrantError(
        CAPABILITY_GRANT_REASONS.DUPLICATE_GRANT,
        `Capability grant ${params.id} already exists.`,
      );
    }
    const res = issueCapabilityGrant(params, ctx);
    this.grants.set(res.grant.id, res.grant);
    this.recordEvent(res.event);
    return res;
  }

  getGrant(id: string): CapabilityGrant | null {
    const g = this.grants.get(id);
    return g ? { ...g } : null;
  }

  authorizeAndConsume(
    grantId: string,
    params: ConsumeCapabilityParams,
    ctx: CapabilityContext = {},
  ): CapabilityTransitionResult {
    const current = this.grants.get(grantId);
    if (!current) {
      throw new CapabilityGrantError(
        CAPABILITY_GRANT_REASONS.NOT_FOUND,
        `Capability grant ${grantId} not found.`,
      );
    }

    // Lazily sweep expiry before evaluating consumption so audit events are ordered.
    const expired = expireCapabilityGrant(current, ctx);
    if (expired) {
      this.grants.set(grantId, expired.grant);
      this.recordEvent(expired.event);
    }

    const latest = this.grants.get(grantId)!;
    const res = consumeCapabilityGrant(latest, params, ctx);
    this.grants.set(grantId, res.grant);
    if (!res.deduplicatedRetry) {
      this.recordEvent(res.event);
    }
    return res;
  }

  revoke(
    grantId: string,
    actor: string,
    revokeReason = "manual_revocation",
    ctx: CapabilityContext = {},
  ): CapabilityTransitionResult {
    const current = this.grants.get(grantId);
    if (!current) {
      throw new CapabilityGrantError(
        CAPABILITY_GRANT_REASONS.NOT_FOUND,
        `Capability grant ${grantId} not found.`,
      );
    }
    const res = revokeCapabilityGrant(current, actor, revokeReason, ctx);
    this.grants.set(grantId, res.grant);
    this.recordEvent(res.event);
    return res;
  }

  sweepExpired(ctx: CapabilityContext = {}): CapabilityGrantEvent[] {
    const emitted: CapabilityGrantEvent[] = [];
    for (const [id, grant] of this.grants.entries()) {
      const expired = expireCapabilityGrant(grant, ctx);
      if (expired) {
        this.grants.set(id, expired.grant);
        this.recordEvent(expired.event);
        emitted.push(expired.event);
      }
    }
    return emitted;
  }

  listActive(now?: number | Date): CapabilityGrant[] {
    const out: CapabilityGrant[] = [];
    for (const g of this.grants.values()) {
      if (effectiveCapabilityState(g, now) === CAPABILITY_GRANT_STATES.ACTIVE) {
        out.push({ ...g });
      }
    }
    return out;
  }

  getAuditTrail(actor: string): CapabilityGrantEvent[] {
    const isAdminOrSystem = actor === "admin" || actor === "system";
    const isParticipant = this.auditLog.some(
      (e) => e.grantee === actor || e.approver === actor || e.actor === actor,
    );
    if (!isAdminOrSystem && !isParticipant) {
      throw new CapabilityGrantError(
        CAPABILITY_GRANT_REASONS.FORBIDDEN_AUDIT,
        `Actor ${actor} is not authorized to view capability grant audit history.`,
      );
    }
    return this.auditLog.map((e) => ({ ...e }));
  }
}
