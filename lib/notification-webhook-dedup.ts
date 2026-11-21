/**
 * Unified Notification & Webhook Deduplication Coordinator.
 *
 * Provides deterministic, tenant-scoped deduplication across:
 *  - `notification` (in-app / push / email notifications)
 *  - `webhook_inbound` (external provider callbacks)
 *  - `webhook_outbound` (subscriber webhook deliveries)
 *
 * Covers normal delivery, transient & terminal failures, bounded retries,
 * stale-lease crash recovery, payload-conflict detection, and role/tenant
 * authorization boundaries without breaking existing notification or webhook
 * service contracts.
 */

import { createHash, randomUUID } from "node:crypto";

export type DedupChannel = "notification" | "webhook_inbound" | "webhook_outbound";

export type DedupRole = "system" | "admin" | "service" | "user";

export type DedupStatus =
  | "in_flight"
  | "completed"
  | "failed_retryable"
  | "failed_terminal";

export interface DedupPrincipal {
  actorId: string;
  role: DedupRole;
  tenantId: string;
  allowedChannels?: DedupChannel[];
}

export interface DedupKeyInput {
  channel: DedupChannel;
  tenantId: string;
  eventType: string;
  eventId: string;
  /** Target endpoint, wallet address, or subscription identifier. */
  target: string;
}

export interface DedupRecord<TResult = unknown> {
  id: string;
  dedupKey: string;
  channel: DedupChannel;
  tenantId: string;
  eventType: string;
  eventId: string;
  target: string;
  payloadHash: string;
  status: DedupStatus;
  attempts: number;
  maxAttempts: number;
  result?: TResult;
  lastError?: string | null;
  leaseExpiresAt: number | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface DedupStore {
  get(dedupKey: string): Promise<DedupRecord | null>;
  set(record: DedupRecord): Promise<void>;
  delete(dedupKey: string): Promise<boolean>;
  pruneExpired(nowMs: number): Promise<number>;
}

export interface DedupDispatchOptions<TResult = unknown> {
  principal: DedupPrincipal;
  key: DedupKeyInput;
  payload: unknown;
  /** Override max attempts for this dispatch (defaults to coordinator config). */
  maxAttempts?: number;
  /** Override TTL in milliseconds (defaults to channel-specific TTL). */
  ttlMs?: number;
  /** Override in-flight lease duration in milliseconds. */
  leaseMs?: number;
  /**
   * Executes the actual notification or webhook delivery.
   * Throwing a `DedupDeliveryError` allows marking the failure as retryable or terminal.
   */
  execute: () => Promise<TResult>;
}

export interface DedupDispatchOutcome<TResult = unknown> {
  dedupKey: string;
  status: "executed" | "duplicate" | "in_flight" | "failed_retryable" | "failed_terminal";
  deduplicated: boolean;
  attempts: number;
  result?: TResult;
  error?: string;
}

export type DedupErrorCode =
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "INVALID_KEY"
  | "PAYLOAD_CONFLICT"
  | "NOT_FOUND";

export class DedupError extends Error {
  readonly code: DedupErrorCode;
  readonly httpStatus: number;

  constructor(code: DedupErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = "DedupError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class DedupDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean = true) {
    super(message);
    this.name = "DedupDeliveryError";
    this.retryable = retryable;
  }
}

export const DEFAULT_NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_WEBHOOK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_LEASE_MS = 30 * 1000; // 30 seconds
export const DEFAULT_MAX_ATTEMPTS = 3;

function normalizeSegment(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DedupError("INVALID_KEY", 400, `Missing required dedup key field: ${fieldName}`);
  }
  return trimmed.toLowerCase();
}

/**
 * Builds a deterministic, tenant-namespaced deduplication key.
 */
export function buildDedupKey(input: DedupKeyInput): string {
  const channel = normalizeSegment(input.channel, "channel");
  const tenantId = normalizeSegment(input.tenantId, "tenantId");
  const eventType = normalizeSegment(input.eventType, "eventType");
  const eventId = normalizeSegment(input.eventId, "eventId");
  const target = normalizeSegment(input.target, "target");
  return `${channel}:${tenantId}:${eventType}:${eventId}:${target}`;
}

/**
 * Canonicalizes a JSON-compatible value (sorting object keys recursively)
 * and computes its SHA-256 hex digest for payload conflict detection.
 */
export function computePayloadHash(payload: unknown): string {
  const canonical = canonicalize(payload);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

export class InMemoryDedupStore implements DedupStore {
  private readonly records = new Map<string, DedupRecord>();

  async get(dedupKey: string): Promise<DedupRecord | null> {
    const rec = this.records.get(dedupKey);
    return rec ? { ...rec } : null;
  }

  async set(record: DedupRecord): Promise<void> {
    this.records.set(record.dedupKey, { ...record });
  }

  async delete(dedupKey: string): Promise<boolean> {
    return this.records.delete(dedupKey);
  }

  async pruneExpired(nowMs: number): Promise<number> {
    let pruned = 0;
    for (const [key, rec] of this.records.entries()) {
      if (rec.expiresAt <= nowMs) {
        this.records.delete(key);
        pruned += 1;
      }
    }
    return pruned;
  }
}

export interface CoordinatorOptions {
  store?: DedupStore;
  now?: () => number;
  defaultMaxAttempts?: number;
  defaultLeaseMs?: number;
  notificationTtlMs?: number;
  webhookTtlMs?: number;
}

export class NotificationWebhookDedupCoordinator {
  private readonly store: DedupStore;
  private readonly now: () => number;
  private readonly defaultMaxAttempts: number;
  private readonly defaultLeaseMs: number;
  private readonly notificationTtlMs: number;
  private readonly webhookTtlMs: number;

  constructor(options: CoordinatorOptions = {}) {
    this.store = options.store ?? new InMemoryDedupStore();
    this.now = options.now ?? (() => Date.now());
    this.defaultMaxAttempts = options.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.defaultLeaseMs = options.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    this.notificationTtlMs = options.notificationTtlMs ?? DEFAULT_NOTIFICATION_TTL_MS;
    this.webhookTtlMs = options.webhookTtlMs ?? DEFAULT_WEBHOOK_TTL_MS;
  }

  private assertAuthenticated(principal: DedupPrincipal | null | undefined): asserts principal is DedupPrincipal {
    if (!principal || !principal.actorId?.trim() || !principal.tenantId?.trim()) {
      throw new DedupError("UNAUTHENTICATED", 401, "Authenticated principal with actorId and tenantId is required");
    }
  }

  private assertDispatchAuthorized(principal: DedupPrincipal, key: DedupKeyInput): void {
    this.assertAuthenticated(principal);

    const isPrivileged = principal.role === "admin" || principal.role === "system";
    if (!isPrivileged && principal.tenantId.toLowerCase() !== key.tenantId.trim().toLowerCase()) {
      throw new DedupError(
        "UNAUTHORIZED",
        403,
        `Principal tenant '${principal.tenantId}' cannot access tenant '${key.tenantId}'`
      );
    }

    if (principal.role === "user" && key.channel !== "notification") {
      throw new DedupError(
        "UNAUTHORIZED",
        403,
        `Role 'user' is not authorized to dispatch on channel '${key.channel}'`
      );
    }

    if (principal.allowedChannels && !principal.allowedChannels.includes(key.channel)) {
      throw new DedupError(
        "UNAUTHORIZED",
        403,
        `Principal '${principal.actorId}' is not authorized for channel '${key.channel}'`
      );
    }
  }

  private assertAdminAuthorized(principal: DedupPrincipal, action: string): void {
    this.assertAuthenticated(principal);
    if (principal.role !== "admin" && principal.role !== "system") {
      throw new DedupError(
        "UNAUTHORIZED",
        403,
        `Role '${principal.role}' is not authorized to perform '${action}'`
      );
    }
  }

  private ttlForChannel(channel: DedupChannel, override?: number): number {
    if (override !== undefined) return override;
    return channel === "notification" ? this.notificationTtlMs : this.webhookTtlMs;
  }

  /**
   * Executes a notification or webhook delivery with deduplication,
   * payload-conflict detection, bounded retries, and stale-lease recovery.
   */
  async dispatch<TResult = unknown>(
    options: DedupDispatchOptions<TResult>
  ): Promise<DedupDispatchOutcome<TResult>> {
    this.assertDispatchAuthorized(options.principal, options.key);

    const dedupKey = buildDedupKey(options.key);
    const payloadHash = computePayloadHash(options.payload);
    const nowMs = this.now();
    const maxAttempts = options.maxAttempts ?? this.defaultMaxAttempts;
    const leaseMs = options.leaseMs ?? this.defaultLeaseMs;
    const ttlMs = this.ttlForChannel(options.key.channel, options.ttlMs);

    const existing = await this.store.get(dedupKey);

    if (existing && existing.expiresAt > nowMs) {
      if (existing.payloadHash !== payloadHash) {
        throw new DedupError(
          "PAYLOAD_CONFLICT",
          409,
          `Dedup key '${dedupKey}' already exists with a different payload fingerprint`
        );
      }

      if (existing.status === "completed") {
        return {
          dedupKey,
          status: "duplicate",
          deduplicated: true,
          attempts: existing.attempts,
          result: existing.result as TResult
        };
      }

      if (existing.status === "failed_terminal") {
        return {
          dedupKey,
          status: "failed_terminal",
          deduplicated: true,
          attempts: existing.attempts,
          error: existing.lastError ?? "Terminal failure"
        };
      }

      if (
        existing.status === "in_flight" &&
        existing.leaseExpiresAt !== null &&
        existing.leaseExpiresAt > nowMs
      ) {
        return {
          dedupKey,
          status: "in_flight",
          deduplicated: true,
          attempts: existing.attempts
        };
      }
    }

    const previousAttempts = existing && existing.expiresAt > nowMs ? existing.attempts : 0;
    const nextAttempt = previousAttempts + 1;

    const record: DedupRecord<TResult> = {
      id: existing && existing.expiresAt > nowMs ? existing.id : randomUUID(),
      dedupKey,
      channel: options.key.channel,
      tenantId: options.key.tenantId.trim().toLowerCase(),
      eventType: options.key.eventType.trim().toLowerCase(),
      eventId: options.key.eventId.trim().toLowerCase(),
      target: options.key.target.trim().toLowerCase(),
      payloadHash,
      status: "in_flight",
      attempts: nextAttempt,
      maxAttempts,
      lastError: null,
      leaseExpiresAt: nowMs + leaseMs,
      expiresAt: nowMs + ttlMs,
      createdAt: existing && existing.expiresAt > nowMs ? existing.createdAt : nowMs,
      updatedAt: nowMs
    };

    await this.store.set(record);

    try {
      const result = await options.execute();
      const completedAt = this.now();
      await this.store.set({
        ...record,
        status: "completed",
        result,
        lastError: null,
        leaseExpiresAt: null,
        updatedAt: completedAt
      });

      return {
        dedupKey,
        status: "executed",
        deduplicated: false,
        attempts: nextAttempt,
        result
      };
    } catch (err) {
      const failedAt = this.now();
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable = err instanceof DedupDeliveryError ? err.retryable : true;
      const exhausted = nextAttempt >= maxAttempts;
      const nextStatus: DedupStatus =
        !isRetryable || exhausted ? "failed_terminal" : "failed_retryable";

      await this.store.set({
        ...record,
        status: nextStatus,
        lastError: message.slice(0, 500),
        leaseExpiresAt: null,
        updatedAt: failedAt
      });

      return {
        dedupKey,
        status: nextStatus,
        deduplicated: false,
        attempts: nextAttempt,
        error: message
      };
    }
  }

  /**
   * Inspects the current deduplication record for a key (enforces tenant authorization).
   */
  async inspect(principal: DedupPrincipal, key: DedupKeyInput): Promise<DedupRecord | null> {
    this.assertDispatchAuthorized(principal, key);
    const dedupKey = buildDedupKey(key);
    const rec = await this.store.get(dedupKey);
    if (!rec || rec.expiresAt <= this.now()) {
      return null;
    }
    return rec;
  }

  /**
   * Recovery operation: resets a `failed_terminal` record to `failed_retryable`
   * with attempts reset to 0 so an operator can safely replay after an outage.
   */
  async requeueForRecovery(principal: DedupPrincipal, key: DedupKeyInput): Promise<DedupRecord> {
    this.assertAdminAuthorized(principal, "requeueForRecovery");
    const dedupKey = buildDedupKey(key);
    const existing = await this.store.get(dedupKey);
    if (!existing) {
      throw new DedupError("NOT_FOUND", 404, `No dedup record found for '${dedupKey}'`);
    }

    const updated: DedupRecord = {
      ...existing,
      status: "failed_retryable",
      attempts: 0,
      lastError: null,
      leaseExpiresAt: null,
      updatedAt: this.now()
    };
    await this.store.set(updated);
    return updated;
  }

  /**
   * Rollback operation: deletes a dedup entry so the event can be re-evaluated
   * from scratch (e.g., rolling back a bad deployment or poisoned payload).
   */
  async rollbackEntry(principal: DedupPrincipal, key: DedupKeyInput): Promise<boolean> {
    this.assertAdminAuthorized(principal, "rollbackEntry");
    const dedupKey = buildDedupKey(key);
    return this.store.delete(dedupKey);
  }

  /**
   * Prunes expired deduplication entries (admin/system only).
   */
  async pruneExpired(principal: DedupPrincipal): Promise<number> {
    this.assertAdminAuthorized(principal, "pruneExpired");
    return this.store.pruneExpired(this.now());
  }
}
