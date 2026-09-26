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
 */

import type { PrismaClient } from "@prisma/client";

export type ReminderType = "maturity" | "claim_window";

export interface NotificationRecord {
  id: string;
  walletAddress: string;
  type: string;
  positionId: string;
  title: string;
  message: string;
  dismissedAt: Date | null;
  createdAt: Date;
}

export class NotificationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leadHours = 24
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
        created += await this.createIfMissing({
          walletAddress: pool.walletAddress,
          positionId: pool.poolId,
          type: "maturity",
          title: "Position maturing soon",
          message: `${pool.poolName} locks at ${pool.locksAt.toISOString()}.`
        });
      }

      if (pool.drawsAt && pool.drawsAt >= now && pool.drawsAt <= windowEnd && !disabled.has("claim_window")) {
        created += await this.createIfMissing({
          walletAddress: pool.walletAddress,
          positionId: pool.poolId,
          type: "claim_window",
          title: "Claim window approaching",
          message: `${pool.poolName} draw/claim window opens at ${pool.drawsAt.toISOString()}.`
        });
      }
    }

    return created;
  }

  private async createIfMissing(input: {
    walletAddress: string;
    positionId: string;
    type: ReminderType;
    title: string;
    message: string;
  }): Promise<number> {
    const existing = await this.prisma.notification.findUnique({
      where: {
        walletAddress_positionId_type: {
          walletAddress: input.walletAddress,
          positionId: input.positionId,
          type: input.type
        }
      }
    });
    if (existing) return 0;

    await this.prisma.notification.create({
      data: {
        walletAddress: input.walletAddress,
        positionId: input.positionId,
        type: input.type,
        title: input.title,
        message: input.message
      }
    });
    return 1;
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
    });
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
    });
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
}
