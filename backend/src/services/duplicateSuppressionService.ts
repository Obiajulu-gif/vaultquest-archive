/**
 * Duplicate Suppression Service for Notifications and Webhooks (#993).
 *
 * Implements sliding-window duplicate suppression, content-hash deduplication,
 * and concurrency locks across inbound/outbound webhooks and user notifications.
 *
 * Design features:
 *  - Notification suppression: suppresses identical alerts within a configurable
 *    sliding window (default 300s), tracking recurrence count without creating
 *    duplicate inbox/push alerts.
 *  - Webhook suppression: dual-layer deduplication by provider+eventId and
 *    content hash (provider + eventType + payloadSha256) within sliding window.
 *  - Failure recovery: when previous attempt failed, subsequent retry is NOT
 *    suppressed, allowing recovery from transient errors.
 *  - Concurrency locking: prevents concurrent in-flight duplicate processing.
 *  - Authorization gating: emergency bypass requires maintainer authorization.
 *
 * Time Complexity: O(1) average lookup/insert via hashed maps; O(P) for payload hashing.
 * Space Complexity: O(M) bounded in-memory sliding window with automatic TTL pruning.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../utils/canonicalJson.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

export const DEFAULT_NOTIFICATION_SUPPRESSION_WINDOW_SECONDS = 300; // 5 minutes
export const DEFAULT_WEBHOOK_SUPPRESSION_WINDOW_SECONDS = 600; // 10 minutes

export interface NotificationSuppressionInput {
  recipient: string;
  type: string;
  scope?: "wallet" | "vault" | "global" | "admin";
  subject?: string | null;
  severity?: "critical" | "warning" | "info" | "success";
  payload?: Record<string, unknown>;
  windowSeconds?: number;
  forceDispatch?: boolean;
  actorRole?: "user" | "maintainer" | "service" | "system";
}

export interface NotificationSuppressionResult {
  suppressed: boolean;
  fingerprint: string;
  reason: "allowed" | "duplicate_in_window" | "critical_bypass" | "force_bypass";
  firstSeenAt: Date;
  lastSeenAt: Date;
  occurrenceCount: number;
}

export interface WebhookSuppressionInput {
  provider: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  windowSeconds?: number;
}

export type WebhookProcessingState = "processing" | "processed" | "failed";

export interface WebhookSuppressionRecord {
  key: string;
  provider: string;
  eventId: string;
  eventType: string;
  payloadHash: string;
  state: WebhookProcessingState;
  firstSeenAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  response?: Record<string, unknown> | null;
  error?: string | null;
  retryCount: number;
}

export interface WebhookClaimResult {
  allowed: boolean;
  suppressed: boolean;
  reason: "new" | "concurrent_in_flight" | "already_processed" | "retry_allowed_after_failure";
  record?: WebhookSuppressionRecord;
}

export interface DuplicateSuppressionStore {
  // Notification suppression
  checkNotification(
    fingerprint: string,
    now: Date
  ): Promise<{ seen: boolean; firstSeenAt: Date; lastSeenAt: Date; count: number } | null>;
  recordNotification(
    fingerprint: string,
    windowSeconds: number,
    now: Date
  ): Promise<{ firstSeenAt: Date; lastSeenAt: Date; count: number }>;

  // Webhook suppression
  findWebhook(provider: string, eventId: string, now: Date): Promise<WebhookSuppressionRecord | null>;
  findWebhookByContent(
    provider: string,
    eventType: string,
    payloadHash: string,
    now: Date
  ): Promise<WebhookSuppressionRecord | null>;
  claimWebhook(
    record: Omit<WebhookSuppressionRecord, "retryCount">
  ): Promise<{ claimed: boolean; existing?: WebhookSuppressionRecord }>;
  updateWebhookState(
    provider: string,
    eventId: string,
    state: WebhookProcessingState,
    data?: { response?: Record<string, unknown> | null; error?: string | null }
  ): Promise<void>;
  pruneExpired(now: Date): Promise<number>;
}

export class InMemoryDuplicateSuppressionStore implements DuplicateSuppressionStore {
  private notifications = new Map<
    string,
    { firstSeenAt: Date; lastSeenAt: Date; count: number; expiresAt: Date }
  >();
  private webhooksById = new Map<string, WebhookSuppressionRecord>();
  private webhooksByContent = new Map<string, string>(); // contentKey -> idKey

  async checkNotification(fingerprint: string, now: Date) {
    const entry = this.notifications.get(fingerprint);
    if (!entry) return null;
    if (entry.expiresAt < now) {
      this.notifications.delete(fingerprint);
      return null;
    }
    return {
      seen: true,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      count: entry.count,
    };
  }

  async recordNotification(fingerprint: string, windowSeconds: number, now: Date) {
    const expiresAt = new Date(now.getTime() + windowSeconds * 1000);
    const existing = this.notifications.get(fingerprint);
    if (existing && existing.expiresAt >= now) {
      existing.count += 1;
      existing.lastSeenAt = now;
      existing.expiresAt = expiresAt;
      return { firstSeenAt: existing.firstSeenAt, lastSeenAt: existing.lastSeenAt, count: existing.count };
    }

    const created = { firstSeenAt: now, lastSeenAt: now, count: 1, expiresAt };
    this.notifications.set(fingerprint, created);
    return { firstSeenAt: now, lastSeenAt: now, count: 1 };
  }

  async findWebhook(provider: string, eventId: string, now: Date): Promise<WebhookSuppressionRecord | null> {
    const k = `${provider}:${eventId}`;
    const rec = this.webhooksById.get(k);
    if (!rec) return null;
    if (rec.expiresAt < now) {
      this.webhooksById.delete(k);
      return null;
    }
    return structuredClone(rec);
  }

  async findWebhookByContent(
    provider: string,
    eventType: string,
    payloadHash: string,
    now: Date
  ): Promise<WebhookSuppressionRecord | null> {
    const ck = `${provider}:${eventType}:${payloadHash}`;
    const idKey = this.webhooksByContent.get(ck);
    if (!idKey) return null;
    const rec = this.webhooksById.get(idKey);
    if (!rec || rec.expiresAt < now) {
      this.webhooksByContent.delete(ck);
      if (rec) this.webhooksById.delete(idKey);
      return null;
    }
    return structuredClone(rec);
  }

  async claimWebhook(
    record: Omit<WebhookSuppressionRecord, "retryCount">
  ): Promise<{ claimed: boolean; existing?: WebhookSuppressionRecord }> {
    const idKey = `${record.provider}:${record.eventId}`;
    const contentKey = `${record.provider}:${record.eventType}:${record.payloadHash}`;

    const existingById = this.webhooksById.get(idKey);
    if (existingById && existingById.expiresAt >= record.firstSeenAt) {
      return { claimed: false, existing: existingById };
    }

    const existingByContentId = this.webhooksByContent.get(contentKey);
    if (existingByContentId) {
      const existingByContent = this.webhooksById.get(existingByContentId);
      if (existingByContent && existingByContent.expiresAt >= record.firstSeenAt) {
        return { claimed: false, existing: existingByContent };
      }
    }

    const fullRecord: WebhookSuppressionRecord = {
      ...record,
      retryCount: 0,
    };
    this.webhooksById.set(idKey, fullRecord);
    this.webhooksByContent.set(contentKey, idKey);
    return { claimed: true };
  }

  async updateWebhookState(
    provider: string,
    eventId: string,
    state: WebhookProcessingState,
    data?: { response?: Record<string, unknown> | null; error?: string | null }
  ): Promise<void> {
    const idKey = `${provider}:${eventId}`;
    const rec = this.webhooksById.get(idKey);
    if (rec) {
      rec.state = state;
      rec.lastSeenAt = new Date();
      if (data?.response !== undefined) rec.response = data.response;
      if (data?.error !== undefined) rec.error = data.error;
      if (state === "failed") {
        rec.retryCount += 1;
      }
    }
  }

  async pruneExpired(now: Date): Promise<number> {
    let count = 0;
    for (const [k, v] of this.notifications.entries()) {
      if (v.expiresAt < now) {
        this.notifications.delete(k);
        count++;
      }
    }
    for (const [k, v] of this.webhooksById.entries()) {
      if (v.expiresAt < now) {
        this.webhooksById.delete(k);
        count++;
      }
    }
    for (const [ck, idKey] of this.webhooksByContent.entries()) {
      if (!this.webhooksById.has(idKey)) {
        this.webhooksByContent.delete(ck);
      }
    }
    return count;
  }
}

export class DuplicateSuppressionService {
  constructor(
    private readonly store: DuplicateSuppressionStore = new InMemoryDuplicateSuppressionStore(),
    private readonly clock: () => Date = () => new Date()
  ) {}

  /**
   * Evaluates notification duplicate suppression.
   * Time Complexity: O(1) lookup + O(P) hashing. Space Complexity: O(1).
   */
  async evaluateNotification(input: NotificationSuppressionInput): Promise<NotificationSuppressionResult> {
    const now = this.clock();
    const windowSec = input.windowSeconds ?? DEFAULT_NOTIFICATION_SUPPRESSION_WINDOW_SECONDS;

    // Authorization check for emergency force bypass
    if (input.forceDispatch) {
      if (input.actorRole !== "maintainer" && input.actorRole !== "system") {
        throw AppError.forbidden(
          "Only maintainers or system services may bypass notification duplicate suppression"
        );
      }
      const fp = this.computeNotificationFingerprint(input);
      const res = await this.store.recordNotification(fp, windowSec, now);
      return {
        suppressed: false,
        fingerprint: fp,
        reason: "force_bypass",
        firstSeenAt: res.firstSeenAt,
        lastSeenAt: res.lastSeenAt,
        occurrenceCount: res.count,
      };
    }

    // Critical notifications always bypass suppression
    if (input.severity === "critical") {
      const fp = this.computeNotificationFingerprint(input);
      const res = await this.store.recordNotification(fp, windowSec, now);
      return {
        suppressed: false,
        fingerprint: fp,
        reason: "critical_bypass",
        firstSeenAt: res.firstSeenAt,
        lastSeenAt: res.lastSeenAt,
        occurrenceCount: res.count,
      };
    }

    const fingerprint = this.computeNotificationFingerprint(input);
    const existing = await this.store.checkNotification(fingerprint, now);

    if (existing) {
      const updated = await this.store.recordNotification(fingerprint, windowSec, now);
      return {
        suppressed: true,
        fingerprint,
        reason: "duplicate_in_window",
        firstSeenAt: updated.firstSeenAt,
        lastSeenAt: updated.lastSeenAt,
        occurrenceCount: updated.count,
      };
    }

    const recorded = await this.store.recordNotification(fingerprint, windowSec, now);
    return {
      suppressed: false,
      fingerprint,
      reason: "allowed",
      firstSeenAt: recorded.firstSeenAt,
      lastSeenAt: recorded.lastSeenAt,
      occurrenceCount: recorded.count,
    };
  }

  /**
   * Evaluates webhook duplicate suppression and concurrency claim.
   * Time Complexity: O(1) lookup + O(P) hashing. Space Complexity: O(1).
   */
  async evaluateWebhook(input: WebhookSuppressionInput): Promise<WebhookClaimResult> {
    const now = this.clock();
    const windowSec = input.windowSeconds ?? DEFAULT_WEBHOOK_SUPPRESSION_WINDOW_SECONDS;
    const expiresAt = new Date(now.getTime() + windowSec * 1000);

    const payloadHash = createHash("sha256")
      .update(canonicalJson(input.payload as unknown as Record<string, unknown>))
      .digest("hex");

    // 1. Check existing by eventId
    const existing = await this.store.findWebhook(input.provider, input.eventId, now);
    if (existing) {
      if (existing.state === "processing") {
        return {
          allowed: false,
          suppressed: true,
          reason: "concurrent_in_flight",
          record: existing,
        };
      }
      if (existing.state === "processed") {
        return {
          allowed: false,
          suppressed: true,
          reason: "already_processed",
          record: existing,
        };
      }
      // If previous attempt failed, ALLOW RETRY to recover!
      if (existing.state === "failed") {
        await this.store.updateWebhookState(input.provider, input.eventId, "processing");
        return {
          allowed: true,
          suppressed: false,
          reason: "retry_allowed_after_failure",
          record: existing,
        };
      }
    }

    // 2. Check content-hash deduplication across different eventIds
    const existingContent = await this.store.findWebhookByContent(
      input.provider,
      input.eventType,
      payloadHash,
      now
    );
    if (existingContent && existingContent.eventId !== input.eventId) {
      if (existingContent.state === "processed") {
        return {
          allowed: false,
          suppressed: true,
          reason: "already_processed",
          record: existingContent,
        };
      }
      if (existingContent.state === "processing") {
        return {
          allowed: false,
          suppressed: true,
          reason: "concurrent_in_flight",
          record: existingContent,
        };
      }
    }

    // 3. Claim new webhook
    const claim = await this.store.claimWebhook({
      key: `${input.provider}:${input.eventId}`,
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      payloadHash,
      state: "processing",
      firstSeenAt: now,
      lastSeenAt: now,
      expiresAt,
    });

    if (!claim.claimed && claim.existing) {
      return {
        allowed: false,
        suppressed: true,
        reason: claim.existing.state === "processing" ? "concurrent_in_flight" : "already_processed",
        record: claim.existing,
      };
    }

    return {
      allowed: true,
      suppressed: false,
      reason: "new",
    };
  }

  async markWebhookProcessed(
    provider: string,
    eventId: string,
    response?: Record<string, unknown> | null
  ): Promise<void> {
    await this.store.updateWebhookState(provider, eventId, "processed", { response });
  }

  async markWebhookFailed(provider: string, eventId: string, error: string): Promise<void> {
    await this.store.updateWebhookState(provider, eventId, "failed", { error });
  }

  async pruneExpired(): Promise<number> {
    return this.store.pruneExpired(this.clock());
  }

  private computeNotificationFingerprint(input: NotificationSuppressionInput): string {
    const raw = {
      recipient: input.recipient.toLowerCase().trim(),
      type: input.type,
      scope: input.scope ?? "wallet",
      subject: (input.subject ?? "").toLowerCase().trim(),
      payload: input.payload ?? {},
    };
    return createHash("sha256").update(canonicalJson(raw as unknown as Record<string, unknown>)).digest("hex");
  }
}
