/**
 * Policy-based limits for expensive operations (#815).
 *
 * Which operations are "expensive" (what they consume):
 *
 *   action.create          storage + indexing  — every intent is a ledger row the indexer reconciles
 *   data.export            compute + storage   — builds a full wallet bundle in memory
 *   data.import            storage             — bulk-writes saved pools
 *   receipt.verify         compute             — ed25519 verification + a lookup
 *   wallet_auth.challenge  storage             — a challenge row per request
 *   recovery.retry         external            — each retry re-queries chain state
 *   audit.export           compute             — up to 5,000 hash-chained rows
 *
 * How limits work:
 *  - Each operation has one policy: `limit` requests per `windowMs`, counted per
 *    scope key (the wallet, the client IP, or the authenticated subject).
 *    Defaults live in {@link DEFAULT_OPERATION_POLICIES}; a deployment can change
 *    limits and windows with the OPERATION_LIMITS env var (validated at boot,
 *    unknown operations rejected).
 *  - Counting is a fixed window keyed by `operation:scopeKey:windowStart`. The
 *    counter store is pluggable: Redis (shared by every API replica, so limits
 *    are consistent server-side) when REDIS_URL is set, otherwise in-process.
 *  - **Overrides** raise (or lower) the limit for one operation and one scope
 *    key only, always expire (max 30 days), carry a reason, and are written to
 *    the audit trail on grant and revoke. At most one active override per
 *    (operation, scope key), so which limit applies is never ambiguous.
 *  - **Reset** clears the current window for one operation + scope key
 *    (maintainer only, audited). Windows also reset naturally at `resetAt`.
 *  - Over-limit requests get HTTP 429 `OPERATION_LIMIT_EXCEEDED` with a
 *    `Retry-After` header and `details` holding the operation, limit, window,
 *    reset time and a remediation step. No internal state is exposed.
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import type { AuditActor, AuditRecorder } from "./auditTrail.js";

export const LIMIT_RESOURCES = ["storage", "indexing", "compute", "external"] as const;
export type LimitResource = (typeof LIMIT_RESOURCES)[number];

export const LIMIT_SCOPES = ["wallet", "ip", "subject"] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

export interface OperationPolicy {
  operation: string;
  description: string;
  resources: readonly LimitResource[];
  limit: number;
  windowMs: number;
  scope: LimitScope;
  /** Shown to the user when the limit is hit. */
  remediation: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_OPERATION_POLICIES = {
  "action.create": {
    operation: "action.create",
    description: "Create a deposit/withdraw/claim/vault intent",
    resources: ["storage", "indexing"],
    limit: 30,
    windowMs: MINUTE,
    scope: "wallet",
    remediation: "Wait for your pending actions to finish before starting new ones, then try again after the limit resets.",
  },
  "data.export": {
    operation: "data.export",
    description: "Export wallet data",
    resources: ["compute", "storage"],
    limit: 10,
    windowMs: HOUR,
    scope: "wallet",
    remediation: "Reuse an export you already downloaded, or try again after the limit resets.",
  },
  "data.import": {
    operation: "data.import",
    description: "Import saved pools",
    resources: ["storage"],
    limit: 10,
    windowMs: HOUR,
    scope: "wallet",
    remediation: "Combine your saved pools into a single import file and try again after the limit resets.",
  },
  "receipt.verify": {
    operation: "receipt.verify",
    description: "Verify a signed receipt",
    resources: ["compute"],
    limit: 120,
    windowMs: MINUTE,
    scope: "ip",
    remediation: "Verify receipts offline with the published key from GET /receipts/public-key, or try again shortly.",
  },
  "wallet_auth.challenge": {
    operation: "wallet_auth.challenge",
    description: "Request a wallet sign-in challenge",
    resources: ["storage"],
    limit: 20,
    windowMs: 10 * MINUTE,
    scope: "ip",
    remediation: "Finish the sign-in request already open in your wallet instead of requesting a new one.",
  },
  "recovery.retry": {
    operation: "recovery.retry",
    description: "Retry a stuck pending action",
    resources: ["external"],
    limit: 10,
    windowMs: HOUR,
    scope: "wallet",
    remediation: "Stuck actions are re-checked automatically; wait for the limit to reset before retrying manually.",
  },
  "audit.export": {
    operation: "audit.export",
    description: "Export the audit trail",
    resources: ["compute"],
    limit: 20,
    windowMs: HOUR,
    scope: "subject",
    remediation: "Narrow the export with filters (category, actor, target, date range) instead of exporting everything.",
  },
} as const satisfies Record<string, OperationPolicy>;

export type OperationName = keyof typeof DEFAULT_OPERATION_POLICIES;
export const OPERATION_NAMES = Object.keys(DEFAULT_OPERATION_POLICIES) as OperationName[];

export function isOperationName(value: string): value is OperationName {
  return Object.prototype.hasOwnProperty.call(DEFAULT_OPERATION_POLICIES, value);
}

/**
 * Applies an OPERATION_LIMITS override, e.g.
 * `{"action.create":{"limit":50,"windowSeconds":60}}`. Throws on unknown
 * operations or invalid numbers so a typo fails at boot, not silently.
 */
export function resolveOperationPolicies(overrideJson?: string): Record<OperationName, OperationPolicy> {
  const policies: Record<OperationName, OperationPolicy> = structuredClone(
    DEFAULT_OPERATION_POLICIES,
  ) as unknown as Record<OperationName, OperationPolicy>;
  if (!overrideJson?.trim()) return policies;

  let parsed: unknown;
  try {
    parsed = JSON.parse(overrideJson);
  } catch {
    throw new Error("OPERATION_LIMITS must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPERATION_LIMITS must be a JSON object keyed by operation");
  }
  for (const [operation, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isOperationName(operation)) throw new Error(`OPERATION_LIMITS: unknown operation "${operation}"`);
    const v = value as { limit?: unknown; windowSeconds?: unknown };
    if (v.limit !== undefined) {
      if (!Number.isInteger(v.limit) || (v.limit as number) < 1) {
        throw new Error(`OPERATION_LIMITS.${operation}.limit must be a positive integer`);
      }
      policies[operation].limit = v.limit as number;
    }
    if (v.windowSeconds !== undefined) {
      if (!Number.isInteger(v.windowSeconds) || (v.windowSeconds as number) < 1) {
        throw new Error(`OPERATION_LIMITS.${operation}.windowSeconds must be a positive integer`);
      }
      policies[operation].windowMs = (v.windowSeconds as number) * 1000;
    }
  }
  return policies;
}

// ─── Counters ────────────────────────────────────────────────────────────────

export interface LimitCounterStore {
  /** Atomically increments and returns the new count; the key expires after `ttlMs`. */
  increment(key: string, ttlMs: number): Promise<number>;
  peek(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

export class InMemoryLimitCounterStore implements LimitCounterStore {
  private readonly counts = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string) {
    const entry = this.counts.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.counts.delete(key);
      return undefined;
    }
    return entry;
  }

  async increment(key: string, ttlMs: number): Promise<number> {
    const entry = this.live(key) ?? { count: 0, expiresAt: this.now() + ttlMs };
    entry.count += 1;
    this.counts.set(key, entry);
    // Opportunistic cleanup keeps memory bounded without a timer.
    if (this.counts.size > 10_000) {
      for (const k of this.counts.keys()) this.live(k);
    }
    return entry.count;
  }

  async peek(key: string): Promise<number> {
    return this.live(key)?.count ?? 0;
  }

  async reset(key: string): Promise<void> {
    this.counts.delete(key);
  }
}

/** The subset of ioredis used here, so tests can pass a stub. */
export interface RedisLikeClient {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

/** Shared counters for multi-replica deployments. */
export class RedisLimitCounterStore implements LimitCounterStore {
  constructor(private readonly redis: RedisLikeClient) {}

  async increment(key: string, ttlMs: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.pexpire(key, ttlMs);
    return count;
  }

  async peek(key: string): Promise<number> {
    return Number((await this.redis.get(key)) ?? 0);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

// ─── Overrides ───────────────────────────────────────────────────────────────

export interface LimitOverride {
  id: string;
  operation: OperationName;
  /** e.g. "wallet:GABC…", "ip:203.0.113.4", "subject:internal-service". */
  scopeKey: string;
  limit: number;
  reason: string;
  grantedBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface LimitOverrideStore {
  insert(o: LimitOverride): Promise<void>;
  get(id: string): Promise<LimitOverride | null>;
  /** The unrevoked, unexpired override for (operation, scopeKey) at `at`. */
  findActive(operation: OperationName, scopeKey: string, at: Date): Promise<LimitOverride | null>;
  list(filter: { operation?: OperationName; scopeKey?: string; activeAt?: Date }): Promise<LimitOverride[]>;
  /** Sets revokedAt/revokedBy if not already revoked; returns the row or null. */
  revoke(id: string, revokedBy: string, at: Date): Promise<LimitOverride | null>;
}

function isActive(o: LimitOverride, at: Date): boolean {
  return o.revokedAt === null && new Date(o.expiresAt).getTime() > at.getTime();
}

export class InMemoryLimitOverrideStore implements LimitOverrideStore {
  private readonly rows = new Map<string, LimitOverride>();

  async insert(o: LimitOverride) {
    this.rows.set(o.id, structuredClone(o));
  }

  async get(id: string) {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async findActive(operation: OperationName, scopeKey: string, at: Date) {
    const row = [...this.rows.values()].find(
      (o) => o.operation === operation && o.scopeKey === scopeKey && isActive(o, at),
    );
    return row ? structuredClone(row) : null;
  }

  async list(filter: { operation?: OperationName; scopeKey?: string; activeAt?: Date }) {
    return [...this.rows.values()]
      .filter(
        (o) =>
          (!filter.operation || o.operation === filter.operation) &&
          (!filter.scopeKey || o.scopeKey === filter.scopeKey) &&
          (!filter.activeAt || isActive(o, filter.activeAt)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((o) => structuredClone(o));
  }

  async revoke(id: string, revokedBy: string, at: Date) {
    const row = this.rows.get(id);
    if (!row || row.revokedAt !== null) return null;
    row.revokedAt = at.toISOString();
    row.revokedBy = revokedBy;
    return structuredClone(row);
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export interface LimitErrorDetails {
  operation: OperationName;
  limit: number;
  window_seconds: number;
  retry_after_seconds: number;
  reset_at: string;
  remediation: string;
}

/** 429 with user-safe, structured details and a Retry-After value. */
export class OperationLimitError extends AppError {
  readonly limitDetails: LimitErrorDetails;
  readonly retryAfterSeconds: number;

  constructor(details: LimitErrorDetails) {
    super(
      ERROR_CODES.OPERATION_LIMIT_EXCEEDED,
      429,
      `Limit reached for ${details.operation}: ${details.limit} per ${formatWindow(details.window_seconds)}. ${details.remediation}`,
    );
    this.name = "OperationLimitError";
    this.limitDetails = details;
    this.retryAfterSeconds = details.retry_after_seconds;
  }
}

function formatWindow(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

export type OverrideErrorCode = "INVALID_REQUEST" | "NOT_FOUND" | "OVERRIDE_EXISTS";

export class LimitOverrideError extends Error {
  constructor(
    readonly code: OverrideErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LimitOverrideError";
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export interface LimitDecision {
  allowed: boolean;
  operation: OperationName;
  scopeKey: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
  overrideId: string | null;
}

export const MAX_OVERRIDE_DURATION_MS = 30 * 24 * HOUR;
/** An override may not exceed this multiple of the base limit. */
export const MAX_OVERRIDE_MULTIPLIER = 100;

export interface OperationLimitServiceOptions {
  policies?: Record<OperationName, OperationPolicy>;
  counters: LimitCounterStore;
  overrides: LimitOverrideStore;
  audit: AuditRecorder;
  now?: () => Date;
}

export class OperationLimitService {
  private readonly policies: Record<OperationName, OperationPolicy>;

  constructor(private readonly options: OperationLimitServiceOptions) {
    this.policies = options.policies ?? resolveOperationPolicies();
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  listPolicies(): OperationPolicy[] {
    return OPERATION_NAMES.map((name) => this.policies[name]);
  }

  policy(operation: OperationName): OperationPolicy {
    return this.policies[operation];
  }

  private window(policy: OperationPolicy, at: Date) {
    const start = Math.floor(at.getTime() / policy.windowMs) * policy.windowMs;
    return { start, resetAt: start + policy.windowMs };
  }

  private counterKey(operation: OperationName, scopeKey: string, windowStart: number): string {
    return `oplimit:${operation}:${scopeKey}:${windowStart}`;
  }

  private async effectiveLimit(operation: OperationName, scopeKey: string, at: Date) {
    const override = await this.options.overrides.findActive(operation, scopeKey, at);
    return { limit: override?.limit ?? this.policies[operation].limit, overrideId: override?.id ?? null };
  }

  private decision(
    operation: OperationName,
    scopeKey: string,
    limit: number,
    used: number,
    resetAt: number,
    at: Date,
    overrideId: string | null,
  ): LimitDecision {
    return {
      allowed: used <= limit,
      operation,
      scopeKey,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetAt: new Date(resetAt).toISOString(),
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - at.getTime()) / 1000)),
      overrideId,
    };
  }

  /** Counts one request and reports whether it is within the limit. */
  async consume(operation: OperationName, scopeKey: string): Promise<LimitDecision> {
    const at = this.now();
    const policy = this.policies[operation];
    const { start, resetAt } = this.window(policy, at);
    const { limit, overrideId } = await this.effectiveLimit(operation, scopeKey, at);
    const used = await this.options.counters.increment(
      this.counterKey(operation, scopeKey, start),
      resetAt - at.getTime(),
    );
    return this.decision(operation, scopeKey, limit, used, resetAt, at, overrideId);
  }

  /** {@link consume}, throwing {@link OperationLimitError} when over the limit. */
  async enforce(operation: OperationName, scopeKey: string): Promise<LimitDecision> {
    const d = await this.consume(operation, scopeKey);
    if (!d.allowed) {
      const policy = this.policies[operation];
      throw new OperationLimitError({
        operation,
        limit: d.limit,
        window_seconds: Math.round(policy.windowMs / 1000),
        retry_after_seconds: d.retryAfterSeconds,
        reset_at: d.resetAt,
        remediation: policy.remediation,
      });
    }
    return d;
  }

  /** Current usage without counting a request. */
  async usage(operation: OperationName, scopeKey: string): Promise<LimitDecision> {
    const at = this.now();
    const { start, resetAt } = this.window(this.policies[operation], at);
    const { limit, overrideId } = await this.effectiveLimit(operation, scopeKey, at);
    const used = await this.options.counters.peek(this.counterKey(operation, scopeKey, start));
    return this.decision(operation, scopeKey, limit, used, resetAt, at, overrideId);
  }

  async grantOverride(
    input: { operation: OperationName; scopeKey: string; limit: number; durationMs: number; reason: string },
    actor: AuditActor,
  ): Promise<LimitOverride> {
    if (!isOperationName(input.operation)) throw new LimitOverrideError("INVALID_REQUEST", "unknown operation");
    if (!/^(wallet|ip|subject):.{1,200}$/.test(input.scopeKey ?? "")) {
      throw new LimitOverrideError("INVALID_REQUEST", "scopeKey must look like wallet:<address>, ip:<addr> or subject:<id>");
    }
    const base = this.policies[input.operation].limit;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > base * MAX_OVERRIDE_MULTIPLIER) {
      throw new LimitOverrideError(
        "INVALID_REQUEST",
        `limit must be an integer between 1 and ${base * MAX_OVERRIDE_MULTIPLIER}`,
      );
    }
    if (!Number.isInteger(input.durationMs) || input.durationMs < 1 || input.durationMs > MAX_OVERRIDE_DURATION_MS) {
      throw new LimitOverrideError("INVALID_REQUEST", "duration must be between 1 ms and 30 days");
    }
    if (!input.reason?.trim()) throw new LimitOverrideError("INVALID_REQUEST", "a reason is required");

    const at = this.now();
    const existing = await this.options.overrides.findActive(input.operation, input.scopeKey, at);
    if (existing) {
      throw new LimitOverrideError(
        "OVERRIDE_EXISTS",
        `override ${existing.id} is already active for this operation and scope; revoke it first`,
      );
    }

    const override: LimitOverride = {
      id: randomUUID(),
      operation: input.operation,
      scopeKey: input.scopeKey,
      limit: input.limit,
      reason: input.reason.trim(),
      grantedBy: actor.subject,
      createdAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + input.durationMs).toISOString(),
      revokedAt: null,
      revokedBy: null,
    };
    await this.options.overrides.insert(override);
    await this.options.audit.record({
      category: "limits",
      action: "limits.override.grant",
      actor,
      target: { type: "limit_override", id: override.id },
      reason: override.reason,
      before: { operation: override.operation, scopeKey: override.scopeKey, limit: base },
      after: { operation: override.operation, scopeKey: override.scopeKey, limit: override.limit, expiresAt: override.expiresAt },
    });
    return override;
  }

  async revokeOverride(id: string, actor: AuditActor, reason: string): Promise<LimitOverride> {
    if (!reason?.trim()) throw new LimitOverrideError("INVALID_REQUEST", "a reason is required");
    const existing = await this.options.overrides.get(id);
    if (!existing) throw new LimitOverrideError("NOT_FOUND", "override not found");
    const revoked = await this.options.overrides.revoke(id, actor.subject, this.now());
    if (!revoked) throw new LimitOverrideError("INVALID_REQUEST", "override is already revoked");
    await this.options.audit.record({
      category: "limits",
      action: "limits.override.revoke",
      actor,
      target: { type: "limit_override", id },
      reason: reason.trim(),
      before: { limit: existing.limit, expiresAt: existing.expiresAt, revokedAt: null },
      after: { limit: this.policies[existing.operation].limit, revokedAt: revoked.revokedAt },
      metadata: { operation: existing.operation, scopeKey: existing.scopeKey },
    });
    return revoked;
  }

  async listOverrides(filter: { operation?: OperationName; scopeKey?: string; activeOnly?: boolean }) {
    return this.options.overrides.list({
      operation: filter.operation,
      scopeKey: filter.scopeKey,
      activeAt: filter.activeOnly ? this.now() : undefined,
    });
  }

  /** Clears the current window's counter for one operation + scope key. */
  async reset(operation: OperationName, scopeKey: string, actor: AuditActor, reason: string): Promise<LimitDecision> {
    if (!reason?.trim()) throw new LimitOverrideError("INVALID_REQUEST", "a reason is required");
    const before = await this.usage(operation, scopeKey);
    const { start } = this.window(this.policies[operation], this.now());
    await this.options.counters.reset(this.counterKey(operation, scopeKey, start));
    const after = await this.usage(operation, scopeKey);
    await this.options.audit.record({
      category: "limits",
      action: "limits.reset",
      actor,
      target: { type: "limit_counter", id: `${operation}:${scopeKey}` },
      reason: reason.trim(),
      before: { used: before.used, limit: before.limit },
      after: { used: after.used, limit: after.limit },
    });
    return after;
  }
}
