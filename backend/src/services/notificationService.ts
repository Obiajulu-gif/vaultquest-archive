/**
 * Generates and manages in-app maturity / claim-window reminder notifications
 * (issue #446).
 *
 * Reminders are derived from indexed position dates on `SavedPool`:
 *  - `locksAt`  → the position "matures" / locks for further deposits.
 *  - `drawsAt`  → the claim window opens (winner draw / payout time).
 *
 * A reminder is generated once the relevant date falls within
 * `leadHours` of "now" and has not already passed. Generation is idempotent:
 * a `(walletAddress, positionId, type)` unique constraint on `Notification`
 * means re-running `generateReminders` never creates duplicates.
 *
 * Event-driven delivery (issue #446 follow-up): notifications are now
 * persisted with a deterministic idempotency key and a delivery status track	ng
 * so that retried source events and repeated workers cannot create duplicate
 * messages. Failed deliveries can be retried safely and exhausted retries
 * are surfaced as diagnostics.
 */

import type { PrismaClient } from "@prisma/client";
import { IdempotencyService } from "./idempotencyService.js";

export type ReminderType = "maturity" | "claim_window";

export type NotificationDeliveryStatus = "pending" | "delivered" | "failed";

export interface NotificationRecord {
  id: string;
  walletAddress: string;
  type: string;
  positionId: string;
  title: string;
  message: string;
  idempotencyKey: string;
  deliveryStatus: NotificationDeliveryStatus;
  deliveryAttempts: number;
  maxDeliveryAttempts: number;
  lastDeliveryError: string | null;
  deliveredAt: Date | null;
  dismissedAt: Date | null;
  createdAt: Date;
}

export interface NotificationDeliveryResult {
  id: string;
  deliveryStatus: NotificationDeliveryStatus;
  deliveryAttempts: number;
  maxDeliveryAttempts: number;
  lastDeliveryError: string | null;
  deliveredAt: Date | null;
}

export interface NotificationDeliveryDiagnostics {
  total: number;
  pending: number;
  delivered: number;
  failed: number;
  exhausted: number;
  failures: Array<{
    id: string;
    walletAddress: string;
    type: string;
    deliveryAttempts: number;
    maxDeliveryAttempts: number;
    lastDeliveryError: string | null;
  }>;
}

export interface NotificationDeliveryAdapter {
  /**
   * Delivers a notification to its destination. Throwing marks the delivery
   * attempt as failed and schedules a retry until `maxDeliveryAttempts` is
   * reached.
   */
  deliver(notification: NotificationRecord): Promise<void>;
}

export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Builds the deterministic idempotency key for a notification. The key is
 * derived from the source event identity (wallet + position + type), so a
 * retried event or a repeated worker produces the same key and cannot
 * create a duplicate row.
 */
export function notificationIdempotencyKey(input: {
  walletAddress: string;
  positionId: string;
  type: ReminderType | string;
}): string {
  return `notification:${input.walletAddress.toLowerCase()}:${input.positionId}:${input.type}`;
}

/**
 * Redacts wallet addresses and transaction hashes from delivery error
 * messages before they are persisted, and caps the length so diagnostics
 * cannot leak sensitive payload data.
 */
export function sanitizeDeliveryError(message: string): string {
  const redacted = message
    .replace(/0x[a-fA-F0-9]{40}/g, "0x[redacted]")
    .replace(/\b[a-fA-F0-9]{64}\b/g, "0(redacted)")
    .replace(/\b[a-zA-Z0-9]{40}\b/g, "(redacted)");
  return redacted.slice(0, 500);
}

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
private readonly leadHours = 24,
    private readonly idempotencyService?: IdempotencyService,
    private readonly delivery: NotificationDeliveryAdapter | null = null,
    private readonly maxDeliveryAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS
  ) {}

  /**
   * Scans saved pools for upcoming lock (maturity) and draw (claim-window)
   * dates within the configured lead time, and creates any missing reminder
   * notifications. Already-created reminders are skipped (idempotent) and
   * wallets that disabled a reminder type are respected.
   *
   * @param now - Reference time, defaults to `new Date()` (injectable for tests)
   * @returns number of new notifications created
   */
  async generateReminders(now: Date = new Date()): Promise<number> {
    const windowEnd = new Date(now.getTime() + this.leadHours * 60 * 60 * 1000);

    const candidates = await this.prisma.savedPool.findMany({
      where: {
        OR: [
          { locksAt: { gte: now, lte: windowEnd } },
          { drawsAt: { gte: now, lte: windowEnd } }
        ]
      }
    });

    let created = 0;
    for (const pool of candidates) {
      const disabled = await this.getDisabledTypes(pool.walletAddress);

      if (pool.locksAt && pool.locksAt >= now && pool.locksAt <= windowEnd && !disabled.has("maturity")) {
        created += await this.createIfMissing(
          {
            walletAddress: pool.walletAddress,
            positionId: pool.poolId,
            type: "maturity",
            title: "Position maturing soon",
            message: `${pool.poolName} locks at ${pool.locksAt.toISOString()}.`
          },
          now
        );
      }

      if (pool.drawsAt && pool.drawsAt >= now && pool.drawsAt <= windowEnd && !disabled.has("claim_window")) {
        created += await this.createIfMissing(
          {
            walletAddress: pool.walletAddress,
            positionId: pool.poolId,
            type: "claim_window",
            title: "Claim window approaching",
            message: `${pool.poolName} draw/claim window opens at ${pool.drawsAt.toISOString()}.`
          },
          now
        );
      }
    }

    return created;
  }

/**
   * Creates a notification if no row with the same idempotency key exists.
   * The key is derived from the source event, so duplicate events and
   * repeated workers are naturally deduplicated. When a delivery adapter is
   * configured, the new notification is delivered immediately and its status
   * tracked.
   */
  private async createIfMissing(
    input: {
      walletAddress: string;
      positionId: string;
      type: ReminderType;
      title: string;
      message: string;
    },
    idempotencyKey?: string
  ): Promise<number> {
    // Use idempotency if key is provided
    if (idempotencyKey && this.idempotencyService) {
      const result = await this.idempotencyService.executeWithIdempotency(
        {
          key: idempotencyKey,
          operationType: "notification",
          walletAddress: input.walletAddress,
        },
        async () => this.createIfMissingImpl(input)
      );
      return result as unknown as number;
    }

    return this.createIfMissingImpl(input);
  }

  private async createIfMissingImpl(
    input: {
      walletAddress: string;
      positionId: string;
      type: ReminderType;
      title: string;
      message: string;
    },
    now: Date
  ): Promise<number> {
    const idempotencyKey = notificationIdempotencyKey(input);
    const existing = await this.prisma.notification.findUnique({
      where: { idempotencyKey }
    });
    if (existing) return 0;

    const created = await this.prisma.notification.create({
      data: {
        walletAddress: input.walletAddress,
        positionId: input.positionId,
        type: input.type,
        title: input.title,
        message: input.message,
        idempotencyKey,
        deliveryStatus: "pending",
        deliveryAttempts: 0,
        maxDeliveryAttempts: this.maxDeliveryAttempts,
        createdAt: now
      }
    });

    if (this.delivery) {
      await this.deliver(created as unknown as NotificationRecord);
    }

    return 1;
  }

  /**
   * Attempts to deliver a notification. Each attempt is recorded and cannot
   * exceed `maxDeliveryAttempts`. A failed attempt leaves the notification
   * `failed` so it can be retried safely; exhausted notifications are
   * surfaced through `getDeliveryDiagnostics`.
   */
  async deliver(notification: NotificationRecord): Promise<NotificationDeliveryResult> {
    if (!this.delivery) {
      throw new Error("notification delivery adapter is not configured");
    }

    const current = await this.prisma.notification.findUnique({
      where: { id: notification.id }
    });
    if (!current) {
      throw new Error(`notification ${notification.id} not found`);
    }

    const maxAttempts = current.maxDeliveryAttempts ?? this.maxDeliveryAttempts;
    if (current.deliveryStatus === "delivered") {
      return this.toDeliveryResult(current);
    }
    if (current.deliveryAttempts >= maxAttempts) {
      return this.toDeliveryResult(current);
    }

    const attempt = current.deliveryAttempts + 1;
    try {
      await this.delivery.deliver(current as unknown as NotificationRecord);
      const updated = await this.prisma.notification.update({
        where: { id: current.id },
        data: {
          deliveryStatus: "delivered",
          deliveryAttempts: attempt,
          lastDeliveryError: null,
          deliveredAt: new Date()
        }
      });
      return this.toDeliveryResult(updated);
    } catch (err) {
      const message = sanitizeDeliveryError(err instanceof Error ? err.message : String(err));
      const updated = await this.prisma.notification.update({
        where: { id: current.id },
        data: {
          deliveryStatus: "failed",
          deliveryAttempts: attempt,
          lastDeliveryError: message
        }
      });
      return this.toDeliveryResult(updated);
    }
  }

  /**
   * Retries all notifications that are `failed` and have not exhausted their
   * attempt budget. Returns the result of each attempt.
   */
  async retryFailedDeliveries(limit = 100): Promise<NotificationDeliveryResult[]> {
    const failed = await this.prisma.notification.findMany({
      where: { deliveryStatus: "failed" },
      orderBy: { createdAt: "asc" },
      take: limit
    });

    const results: NotificationDeliveryResult[] = [];
    for (const row of failed) {
      if (row.deliveryAttempts >= row.maxDeliveryAttempts) continue;
      results.push(await this.deliver(row as unknown as NotificationRecord));
    }
    return results;
  }

  /**
   * Returns delivery diagnostics for a wallet (or globally when omitted),
   * including failures that exhausted their retry budget.
   */
  async getDeliveryDiagnostics(walletAddress?: string): Promise<NotificationDeliveryDiagnostics> {
    const where = walletAddress ? { walletAddress } : {};
    const rows = await this.prisma.notification.findMany({ where });

    const diagnostics: NotificationDeliveryDiagnostics = {
      total: rows.length,
      pending: 0,
      delivered: 0,
      failed: 0,
      exhausted: 0,
      failures: []
    };

    for (const row of rows) {
      if (row.deliveryStatus === "pending") diagnostics.pending += 1;
      if (row.deliveryStatus === "delivered") diagnostics.delivered += 1;
      if (row.deliveryStatus === "failed") {
        diagnostics.failed += 1;
        if (row.deliveryAttempts >= row.maxDeliveryAttempts) {
          diagnostics.exhausted += 1;
        }
        diagnostics.failures.push({
          id: row.id,
          walletAddress: row.walletAddress,
          type: row.type,
          deliveryAttempts: row.deliveryAttempts,
          maxDeliveryAttempts: row.maxDeliveryAttempts,
          lastDeliveryError: row.lastDeliveryError
        });
      }
    }

    return diagnostics;
  }

  /**
   * Lists notifications for a wallet (most recent first).
   *
   * @param walletAddress - Wallet to list notifications for
   * @param includeDismissed - Include already-dismissed notifications
   */
  async listNotifications(
    walletAddress: string,
    includeDismissed = false
  ): Promise<NotificationRecord[]> {
    return this.prisma.notification.findMany({
      where: {
        walletAddress,
        ...(includeDismissed ? {} : { dismissedAt: null })
      },
      orderBy: { createdAt: "desc" }
    }) as unknown as Promise<NotificationRecord[]>;
  }

  /**
   * Marks a notification as dismissed. No-op (returns null) if it doesn't
   * belong to the given wallet or doesn't exist.
   */
  async dismiss(walletAddress: string, notificationId: string): Promise<NotificationRecord | null> {
    const existing = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!existing || existing.walletAddress !== walletAddress) return null;

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { dismissedAt: new Date() }
    }) as unknown as Promise<NotificationRecord>;
  }

  /**
   * Reads a wallet's disabled reminder types (issue #446 acceptance
   * criterion: "allow users to dismiss/disable reminder types").
   */
  async getDisabledTypes(walletAddress: string): Promise<Set<string>> {
    const pref = await this.prisma.notificationPreference.findUnique({ where: { walletAddress } });
    return new Set(pref?.disabledTypes ?? []);
  }

  /**
   * Enables or disables a reminder type for a wallet.
   */
  async setReminderTypeEnabled(
    walletAddress: string,
    type: ReminderType,
    enabled: boolean
  ): Promise<void> {
    const disabled = await this.getDisabledTypes(walletAddress);
    if (enabled) {
      disabled.delete(type);
    } else {
      disabled.add(type);
    }

    await this.prisma.notificationPreference.upsert({
      where: { walletAddress },
      create: { walletAddress, disabledTypes: Array.from(disabled) },
      update: { disabledTypes: Array.from(disabled) }
    });
  }

  private toDeliveryResult(row: {
    id: string;
    deliveryStatus: string;
    deliveryAttempts: number;
    maxDeliveryAttempts: number;
    lastDeliveryError: string | null;
    deliveredAt: Date | null;
  }): NotificationDeliveryResult {
    return {
      id: row.id,
      deliveryStatus: row.deliveryStatus as NotificationDeliveryStatus,
      deliveryAttempts: row.deliveryAttempts,
      maxDeliveryAttempts: row.maxDeliveryAttempts,
      lastDeliveryError: row.lastDeliveryError,
      deliveredAt: row.deliveredAt
    };
  }
}
