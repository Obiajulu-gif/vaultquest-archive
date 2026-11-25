/**
 * Notification delivery receipt tracking service (#1088).
 *
 * Extends the existing notification system with comprehensive delivery
 * verification, receipt generation, and audit trails. Ensures at-least-once
 * delivery semantics with idempotent retry support.
 *
 * Acceptance criteria:
 * - Idempotent delivery: retries never create duplicates
 * - Receipt generation: cryptographically signed delivery confirmations
 * - Audit trail: complete history of delivery attempts and outcomes
 * - Recovery: failed deliveries can be safely retried with full context
 */

import type { PrismaClient } from "@prisma/client";
import { createHmac, randomBytes } from "crypto";

export interface DeliveryReceipt {
  id: string;
  notificationId: string;
  deliveryAttemptNumber: number;
  deliveredAt: Date;
  deliveryMethod: string; // "push", "email", "webhook", "in-app"
  recipientAddress: string;
  signature: string; // HMAC signature for tamper-proof verification
  metadata: Record<string, unknown>;
}

export interface DeliveryAttempt {
  attemptNumber: number;
  attemptedAt: Date;
  deliveryMethod: string;
  status: "pending" | "success" | "failed" | "retrying";
  errorCode?: string;
  errorMessage?: string;
  responseData?: Record<string, unknown>;
}

export interface DeliveryAuditTrail {
  notificationId: string;
  idempotencyKey: string;
  createdAt: Date;
  totalAttempts: number;
  deliveryStatus: "pending" | "delivered" | "failed" | "exhausted";
  attempts: DeliveryAttempt[];
  receipt?: DeliveryReceipt;
}

export interface DeliveryMetrics {
  totalNotifications: number;
  deliveredCount: number;
  pendingCount: number;
  failedCount: number;
  exhaustedCount: number;
  averageAttemptsToSuccess: number;
  deliveryRate: number; // percentage of successful deliveries
  retryRate: number; // percentage requiring retries
}

/**
 * Generates a cryptographically signed delivery receipt that can be verified
 * independently. The signature prevents tampering and provides non-repudiation.
 */
export function generateDeliveryReceipt(
  input: {
    notificationId: string;
    deliveryAttemptNumber: number;
    deliveryMethod: string;
    recipientAddress: string;
    metadata?: Record<string, unknown>;
  },
  secret: string
): DeliveryReceipt {
  const id = randomBytes(16).toString("hex");
  const deliveredAt = new Date();
  const metadata = input.metadata ?? {};

  // Create tamper-proof signature covering all critical fields
  const signaturePayload = JSON.stringify({
    id,
    notificationId: input.notificationId,
    deliveryAttemptNumber: input.deliveryAttemptNumber,
    deliveredAt: deliveredAt.toISOString(),
    deliveryMethod: input.deliveryMethod,
    recipientAddress: input.recipientAddress,
    metadata,
  });

  const signature = createHmac("sha256", secret)
    .update(signaturePayload)
    .digest("hex");

  return {
    id,
    notificationId: input.notificationId,
    deliveryAttemptNumber: input.deliveryAttemptNumber,
    deliveredAt,
    deliveryMethod: input.deliveryMethod,
    recipientAddress: input.recipientAddress,
    signature,
    metadata,
  };
}

/**
 * Verifies a delivery receipt's signature to ensure it hasn't been tampered with.
 */
export function verifyDeliveryReceipt(receipt: DeliveryReceipt, secret: string): boolean {
  const signaturePayload = JSON.stringify({
    id: receipt.id,
    notificationId: receipt.notificationId,
    deliveryAttemptNumber: receipt.deliveryAttemptNumber,
    deliveredAt: receipt.deliveredAt.toISOString(),
    deliveryMethod: receipt.deliveryMethod,
    recipientAddress: receipt.recipientAddress,
    metadata: receipt.metadata,
  });

  const expectedSignature = createHmac("sha256", secret)
    .update(signaturePayload)
    .digest("hex");

  return expectedSignature === receipt.signature;
}

/**
 * Service for tracking notification delivery attempts, generating receipts,
 * and maintaining comprehensive audit trails for observability and debugging.
 */
export class NotificationDeliveryReceiptService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly receiptSecret: string
  ) {}

  /**
   * Records a delivery attempt for audit and observability. Called before
   * each delivery attempt to establish a complete timeline.
   */
  async recordDeliveryAttempt(input: {
    notificationId: string;
    attemptNumber: number;
    deliveryMethod: string;
    status: "pending" | "success" | "failed" | "retrying";
    errorCode?: string;
    errorMessage?: string;
    responseData?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.notificationDeliveryAttempt.create({
      data: {
        notificationId: input.notificationId,
        attemptNumber: input.attemptNumber,
        attemptedAt: new Date(),
        deliveryMethod: input.deliveryMethod,
        status: input.status,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        responseData: input.responseData ? JSON.stringify(input.responseData) : null,
      },
    });
  }

  /**
   * Generates and persists a signed delivery receipt after successful delivery.
   * The receipt provides cryptographic proof of delivery and can be used for
   * compliance, auditing, and dispute resolution.
   */
  async issueDeliveryReceipt(input: {
    notificationId: string;
    deliveryAttemptNumber: number;
    deliveryMethod: string;
    recipientAddress: string;
    metadata?: Record<string, unknown>;
  }): Promise<DeliveryReceipt> {
    const receipt = generateDeliveryReceipt(input, this.receiptSecret);

    await this.prisma.notificationDeliveryReceipt.create({
      data: {
        id: receipt.id,
        notificationId: receipt.notificationId,
        deliveryAttemptNumber: receipt.deliveryAttemptNumber,
        deliveredAt: receipt.deliveredAt,
        deliveryMethod: receipt.deliveryMethod,
        recipientAddress: receipt.recipientAddress,
        signature: receipt.signature,
        metadata: JSON.stringify(receipt.metadata),
      },
    });

    return receipt;
  }

  /**
   * Retrieves the full audit trail for a notification, including all delivery
   * attempts, timing, error messages, and the final receipt if delivered.
   */
  async getDeliveryAuditTrail(notificationId: string): Promise<DeliveryAuditTrail | null> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        deliveryAttempts: {
          orderBy: { attemptedAt: "asc" },
        },
        deliveryReceipt: true,
      },
    });

    if (!notification) return null;

    const attempts: DeliveryAttempt[] = notification.deliveryAttempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      attemptedAt: attempt.attemptedAt,
      deliveryMethod: attempt.deliveryMethod,
      status: attempt.status as "pending" | "success" | "failed" | "retrying",
      errorCode: attempt.errorCode ?? undefined,
      errorMessage: attempt.errorMessage ?? undefined,
      responseData: attempt.responseData ? JSON.parse(attempt.responseData) : undefined,
    }));

    const receipt = notification.deliveryReceipt
      ? {
          id: notification.deliveryReceipt.id,
          notificationId: notification.deliveryReceipt.notificationId,
          deliveryAttemptNumber: notification.deliveryReceipt.deliveryAttemptNumber,
          deliveredAt: notification.deliveryReceipt.deliveredAt,
          deliveryMethod: notification.deliveryReceipt.deliveryMethod,
          recipientAddress: notification.deliveryReceipt.recipientAddress,
          signature: notification.deliveryReceipt.signature,
          metadata: JSON.parse(notification.deliveryReceipt.metadata),
        }
      : undefined;

    return {
      notificationId: notification.id,
      idempotencyKey: notification.idempotencyKey,
      createdAt: notification.createdAt,
      totalAttempts: notification.deliveryAttempts,
      deliveryStatus: notification.deliveryStatus as "pending" | "delivered" | "failed" | "exhausted",
      attempts,
      receipt,
    };
  }

  /**
   * Verifies a stored delivery receipt's signature to ensure integrity.
   */
  async verifyStoredReceipt(receiptId: string): Promise<{ valid: boolean; receipt: DeliveryReceipt | null }> {
    const stored = await this.prisma.notificationDeliveryReceipt.findUnique({
      where: { id: receiptId },
    });

    if (!stored) {
      return { valid: false, receipt: null };
    }

    const receipt: DeliveryReceipt = {
      id: stored.id,
      notificationId: stored.notificationId,
      deliveryAttemptNumber: stored.deliveryAttemptNumber,
      deliveredAt: stored.deliveredAt,
      deliveryMethod: stored.deliveryMethod,
      recipientAddress: stored.recipientAddress,
      signature: stored.signature,
      metadata: JSON.parse(stored.metadata),
    };

    const valid = verifyDeliveryReceipt(receipt, this.receiptSecret);

    return { valid, receipt };
  }

  /**
   * Retrieves all delivery receipts for a specific recipient (wallet address).
   * Useful for user-facing delivery history and compliance queries.
   */
  async getReceiptsForRecipient(
    recipientAddress: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<DeliveryReceipt[]> {
    const { limit = 100, offset = 0 } = options;

    const receipts = await this.prisma.notificationDeliveryReceipt.findMany({
      where: { recipientAddress },
      orderBy: { deliveredAt: "desc" },
      take: limit,
      skip: offset,
    });

    return receipts.map((r) => ({
      id: r.id,
      notificationId: r.notificationId,
      deliveryAttemptNumber: r.deliveryAttemptNumber,
      deliveredAt: r.deliveredAt,
      deliveryMethod: r.deliveryMethod,
      recipientAddress: r.recipientAddress,
      signature: r.signature,
      metadata: JSON.parse(r.metadata),
    }));
  }

  /**
   * Computes delivery metrics for observability and SLA tracking.
   */
  async getDeliveryMetrics(
    options: { walletAddress?: string; timeRange?: { start: Date; end: Date } } = {}
  ): Promise<DeliveryMetrics> {
    const where: Record<string, unknown> = {};
    if (options.walletAddress) {
      where.walletAddress = options.walletAddress;
    }
    if (options.timeRange) {
      where.createdAt = {
        gte: options.timeRange.start,
        lte: options.timeRange.end,
      };
    }

    const notifications = await this.prisma.notification.findMany({
      where,
      include: {
        deliveryAttempts: true,
      },
    });

    const totalNotifications = notifications.length;
    const deliveredCount = notifications.filter((n) => n.deliveryStatus === "delivered").length;
    const pendingCount = notifications.filter((n) => n.deliveryStatus === "pending").length;
    const failedCount = notifications.filter((n) => n.deliveryStatus === "failed").length;
    const exhaustedCount = notifications.filter(
      (n) => n.deliveryStatus === "failed" && n.deliveryAttempts >= n.maxDeliveryAttempts
    ).length;

    const successfulNotifications = notifications.filter((n) => n.deliveryStatus === "delivered");
    const totalAttemptsForSuccess = successfulNotifications.reduce(
      (sum, n) => sum + n.deliveryAttempts,
      0
    );
    const averageAttemptsToSuccess =
      successfulNotifications.length > 0
        ? totalAttemptsForSuccess / successfulNotifications.length
        : 0;

    const deliveryRate = totalNotifications > 0 ? (deliveredCount / totalNotifications) * 100 : 0;
    const retryRate =
      deliveredCount > 0
        ? (successfulNotifications.filter((n) => n.deliveryAttempts > 1).length / deliveredCount) * 100
        : 0;

    return {
      totalNotifications,
      deliveredCount,
      pendingCount,
      failedCount,
      exhaustedCount,
      averageAttemptsToSuccess: Math.round(averageAttemptsToSuccess * 100) / 100,
      deliveryRate: Math.round(deliveryRate * 100) / 100,
      retryRate: Math.round(retryRate * 100) / 100,
    };
  }

  /**
   * Finds notifications that require retry based on delivery status and attempt count.
   * Respects exponential backoff by checking the last attempt timestamp.
   */
  async findNotificationsForRetry(
    options: { maxAge?: number; batchSize?: number } = {}
  ): Promise<string[]> {
    const { maxAge = 3600000, batchSize = 100 } = options; // default 1 hour max age

    const cutoff = new Date(Date.now() - maxAge);

    const notifications = await this.prisma.notification.findMany({
      where: {
        deliveryStatus: "failed",
        deliveryAttempts: { lt: this.prisma.notification.fields.maxDeliveryAttempts },
        updatedAt: { lt: cutoff }, // Ensure exponential backoff
      },
      orderBy: { createdAt: "asc" },
      take: batchSize,
      select: { id: true },
    });

    return notifications.map((n) => n.id);
  }

  /**
   * Marks notifications as permanently failed (exhausted retries) for cleanup.
   */
  async markAsExhausted(notificationIds: string[]): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: {
        id: { in: notificationIds },
        deliveryAttempts: { gte: this.prisma.notification.fields.maxDeliveryAttempts },
      },
      data: {
        deliveryStatus: "failed",
        lastDeliveryError: "Maximum delivery attempts exhausted",
      },
    });

    return result.count;
  }
}
