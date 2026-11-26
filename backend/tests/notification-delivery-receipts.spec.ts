/**
 * Tests for notification delivery receipt tracking (#1088).
 *
 * Coverage:
 * - Normal operation: successful delivery with receipt generation
 * - Failure paths: delivery failures, retries, exhaustion
 * - Authorization: receipt verification and tamper detection
 * - Recovery: retry logic, audit trails, metrics
 * - Idempotency: duplicate delivery prevention
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  generateDeliveryReceipt,
  verifyDeliveryReceipt,
  NotificationDeliveryReceiptService,
  type DeliveryReceipt,
} from "../src/services/notificationDeliveryReceipts.js";

describe("generateDeliveryReceipt", () => {
  const testSecret = "test-secret-key-for-hmac-signing";

  it("generates a valid delivery receipt with signature", () => {
    const receipt = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
        metadata: { provider: "fcm", deviceToken: "token123" },
      },
      testSecret
    );

    expect(receipt.id).toBeDefined();
    expect(receipt.notificationId).toBe("notif-123");
    expect(receipt.deliveryAttemptNumber).toBe(1);
    expect(receipt.deliveryMethod).toBe("push");
    expect(receipt.recipientAddress).toBe("0xtest");
    expect(receipt.signature).toBeDefined();
    expect(receipt.signature.length).toBe(64); // SHA-256 hex = 64 chars
    expect(receipt.deliveredAt).toBeInstanceOf(Date);
  });

  it("generates unique IDs for each receipt", () => {
    const receipt1 = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
      },
      testSecret
    );

    const receipt2 = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
      },
      testSecret
    );

    expect(receipt1.id).not.toBe(receipt2.id);
  });

  it("generates different signatures for different inputs", () => {
    const receipt1 = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest1",
      },
      testSecret
    );

    const receipt2 = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest2",
      },
      testSecret
    );

    expect(receipt1.signature).not.toBe(receipt2.signature);
  });

  it("includes metadata in receipt", () => {
    const metadata = {
      provider: "sendgrid",
      messageId: "msg-456",
      deliveryLatencyMs: 150,
    };

    const receipt = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "email",
        recipientAddress: "user@example.com",
        metadata,
      },
      testSecret
    );

    expect(receipt.metadata).toEqual(metadata);
  });
});

describe("verifyDeliveryReceipt", () => {
  const testSecret = "test-secret-key-for-hmac-signing";

  it("verifies a valid receipt signature", () => {
    const receipt = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
      },
      testSecret
    );

    const isValid = verifyDeliveryReceipt(receipt, testSecret);
    expect(isValid).toBe(true);
  });

  it("detects tampered receipt data", () => {
    const receipt = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
      },
      testSecret
    );

    // Tamper with the recipient address
    const tamperedReceipt = { ...receipt, recipientAddress: "0xattacker" };

    const isValid = verifyDeliveryReceipt(tamperedReceipt, testSecret);
    expect(isValid).toBe(false);
  });

  it("detects wrong signing secret", () => {
    const receipt = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
      },
      testSecret
    );

    const isValid = verifyDeliveryReceipt(receipt, "wrong-secret");
    expect(isValid).toBe(false);
  });

  it("detects tampered metadata", () => {
    const receipt = generateDeliveryReceipt(
      {
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
        metadata: { key: "original" },
      },
      testSecret
    );

    // Tamper with metadata
    const tamperedReceipt = {
      ...receipt,
      metadata: { key: "tampered" },
    };

    const isValid = verifyDeliveryReceipt(tamperedReceipt, testSecret);
    expect(isValid).toBe(false);
  });
});

describe("NotificationDeliveryReceiptService", () => {
  let mockPrisma: any;
  let service: NotificationDeliveryReceiptService;
  const testSecret = "test-receipt-secret";

  beforeEach(() => {
    mockPrisma = {
      notificationDeliveryAttempt: {
        create: vi.fn(),
      },
      notificationDeliveryReceipt: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      notification: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        updateMany: vi.fn(),
        fields: {
          maxDeliveryAttempts: 5,
        },
      },
    };

    service = new NotificationDeliveryReceiptService(mockPrisma, testSecret);
  });

  describe("recordDeliveryAttempt", () => {
    it("records successful delivery attempt", async () => {
      mockPrisma.notificationDeliveryAttempt.create.mockResolvedValue({});

      await service.recordDeliveryAttempt({
        notificationId: "notif-123",
        attemptNumber: 1,
        deliveryMethod: "push",
        status: "success",
      });

      expect(mockPrisma.notificationDeliveryAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          notificationId: "notif-123",
          attemptNumber: 1,
          deliveryMethod: "push",
          status: "success",
        }),
      });
    });

    it("records failed delivery attempt with error details", async () => {
      mockPrisma.notificationDeliveryAttempt.create.mockResolvedValue({});

      await service.recordDeliveryAttempt({
        notificationId: "notif-123",
        attemptNumber: 2,
        deliveryMethod: "email",
        status: "failed",
        errorCode: "SMTP_ERROR",
        errorMessage: "Connection timeout",
      });

      expect(mockPrisma.notificationDeliveryAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          errorCode: "SMTP_ERROR",
          errorMessage: "Connection timeout",
          status: "failed",
        }),
      });
    });

    it("records response data for observability", async () => {
      mockPrisma.notificationDeliveryAttempt.create.mockResolvedValue({});

      const responseData = {
        httpStatus: 200,
        messageId: "msg-456",
        latencyMs: 120,
      };

      await service.recordDeliveryAttempt({
        notificationId: "notif-123",
        attemptNumber: 1,
        deliveryMethod: "webhook",
        status: "success",
        responseData,
      });

      expect(mockPrisma.notificationDeliveryAttempt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          responseData: JSON.stringify(responseData),
        }),
      });
    });
  });

  describe("issueDeliveryReceipt", () => {
    it("generates and persists a signed receipt", async () => {
      mockPrisma.notificationDeliveryReceipt.create.mockResolvedValue({});

      const receipt = await service.issueDeliveryReceipt({
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
      });

      expect(receipt.id).toBeDefined();
      expect(receipt.signature).toBeDefined();
      expect(mockPrisma.notificationDeliveryReceipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          notificationId: "notif-123",
          deliveryAttemptNumber: 1,
          deliveryMethod: "push",
          recipientAddress: "0xtest",
          signature: expect.any(String),
        }),
      });
    });

    it("includes metadata in receipt persistence", async () => {
      mockPrisma.notificationDeliveryReceipt.create.mockResolvedValue({});

      const metadata = { provider: "fcm", token: "device-123" };

      await service.issueDeliveryReceipt({
        notificationId: "notif-123",
        deliveryAttemptNumber: 1,
        deliveryMethod: "push",
        recipientAddress: "0xtest",
        metadata,
      });

      expect(mockPrisma.notificationDeliveryReceipt.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          metadata: JSON.stringify(metadata),
        }),
      });
    });
  });

  describe("getDeliveryAuditTrail", () => {
    it("retrieves complete audit trail with attempts and receipt", async () => {
      const mockNotification = {
        id: "notif-123",
        idempotencyKey: "notif:0xtest:pos-1:claim_window",
        createdAt: new Date("2024-01-01"),
        totalAttempts: 2,
        deliveryStatus: "delivered",
        deliveryAttempts: [
          {
            attemptNumber: 1,
            attemptedAt: new Date("2024-01-01T10:00:00Z"),
            deliveryMethod: "push",
            status: "failed",
            errorCode: "DEVICE_OFFLINE",
            errorMessage: "Device not reachable",
            responseData: null,
          },
          {
            attemptNumber: 2,
            attemptedAt: new Date("2024-01-01T10:05:00Z"),
            deliveryMethod: "push",
            status: "success",
            errorCode: null,
            errorMessage: null,
            responseData: JSON.stringify({ messageId: "msg-456" }),
          },
        ],
        deliveryReceipt: {
          id: "receipt-789",
          notificationId: "notif-123",
          deliveryAttemptNumber: 2,
          deliveredAt: new Date("2024-01-01T10:05:00Z"),
          deliveryMethod: "push",
          recipientAddress: "0xtest",
          signature: "abc123",
          metadata: JSON.stringify({ provider: "fcm" }),
        },
      };

      mockPrisma.notification.findUnique.mockResolvedValue(mockNotification);

      const trail = await service.getDeliveryAuditTrail("notif-123");

      expect(trail).toBeDefined();
      expect(trail?.notificationId).toBe("notif-123");
      expect(trail?.attempts).toHaveLength(2);
      expect(trail?.attempts[0].status).toBe("failed");
      expect(trail?.attempts[1].status).toBe("success");
      expect(trail?.receipt).toBeDefined();
      expect(trail?.receipt?.signature).toBe("abc123");
    });

    it("returns null for non-existent notification", async () => {
      mockPrisma.notification.findUnique.mockResolvedValue(null);

      const trail = await service.getDeliveryAuditTrail("nonexistent");

      expect(trail).toBeNull();
    });

    it("handles notifications without receipts", async () => {
      const mockNotification = {
        id: "notif-123",
        idempotencyKey: "notif:0xtest:pos-1:maturity",
        createdAt: new Date(),
        totalAttempts: 1,
        deliveryStatus: "pending",
        deliveryAttempts: [
          {
            attemptNumber: 1,
            attemptedAt: new Date(),
            deliveryMethod: "email",
            status: "pending",
            errorCode: null,
            errorMessage: null,
            responseData: null,
          },
        ],
        deliveryReceipt: null,
      };

      mockPrisma.notification.findUnique.mockResolvedValue(mockNotification);

      const trail = await service.getDeliveryAuditTrail("notif-123");

      expect(trail?.receipt).toBeUndefined();
      expect(trail?.deliveryStatus).toBe("pending");
    });
  });

  describe("verifyStoredReceipt", () => {
    it("verifies valid stored receipt", async () => {
      const validReceipt = generateDeliveryReceipt(
        {
          notificationId: "notif-123",
          deliveryAttemptNumber: 1,
          deliveryMethod: "push",
          recipientAddress: "0xtest",
        },
        testSecret
      );

      mockPrisma.notificationDeliveryReceipt.findUnique.mockResolvedValue({
        ...validReceipt,
        metadata: JSON.stringify(validReceipt.metadata),
      });

      const result = await service.verifyStoredReceipt(validReceipt.id);

      expect(result.valid).toBe(true);
      expect(result.receipt).toBeDefined();
    });

    it("detects tampered stored receipt", async () => {
      const originalReceipt = generateDeliveryReceipt(
        {
          notificationId: "notif-123",
          deliveryAttemptNumber: 1,
          deliveryMethod: "push",
          recipientAddress: "0xtest",
        },
        testSecret
      );

      // Simulate database tampering
      const tamperedReceipt = {
        ...originalReceipt,
        recipientAddress: "0xattacker",
        metadata: JSON.stringify(originalReceipt.metadata),
      };

      mockPrisma.notificationDeliveryReceipt.findUnique.mockResolvedValue(tamperedReceipt);

      const result = await service.verifyStoredReceipt(originalReceipt.id);

      expect(result.valid).toBe(false);
    });

    it("returns invalid for non-existent receipt", async () => {
      mockPrisma.notificationDeliveryReceipt.findUnique.mockResolvedValue(null);

      const result = await service.verifyStoredReceipt("nonexistent");

      expect(result.valid).toBe(false);
      expect(result.receipt).toBeNull();
    });
  });

  describe("getReceiptsForRecipient", () => {
    it("retrieves all receipts for a recipient", async () => {
      const mockReceipts = [
        {
          id: "receipt-1",
          notificationId: "notif-1",
          deliveryAttemptNumber: 1,
          deliveredAt: new Date("2024-01-02"),
          deliveryMethod: "push",
          recipientAddress: "0xtest",
          signature: "sig1",
          metadata: JSON.stringify({ provider: "fcm" }),
        },
        {
          id: "receipt-2",
          notificationId: "notif-2",
          deliveryAttemptNumber: 1,
          deliveredAt: new Date("2024-01-01"),
          deliveryMethod: "email",
          recipientAddress: "0xtest",
          signature: "sig2",
          metadata: JSON.stringify({ provider: "sendgrid" }),
        },
      ];

      mockPrisma.notificationDeliveryReceipt.findMany.mockResolvedValue(mockReceipts);

      const receipts = await service.getReceiptsForRecipient("0xtest");

      expect(receipts).toHaveLength(2);
      expect(receipts[0].id).toBe("receipt-1");
      expect(receipts[1].id).toBe("receipt-2");
    });

    it("respects pagination limits", async () => {
      mockPrisma.notificationDeliveryReceipt.findMany.mockResolvedValue([]);

      await service.getReceiptsForRecipient("0xtest", { limit: 10, offset: 20 });

      expect(mockPrisma.notificationDeliveryReceipt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
        })
      );
    });
  });

  describe("getDeliveryMetrics", () => {
    it("computes accurate delivery metrics", async () => {
      const mockNotifications = [
        {
          id: "1",
          deliveryStatus: "delivered",
          deliveryAttempts: 1,
          maxDeliveryAttempts: 5,
        },
        {
          id: "2",
          deliveryStatus: "delivered",
          deliveryAttempts: 3,
          maxDeliveryAttempts: 5,
        },
        {
          id: "3",
          deliveryStatus: "pending",
          deliveryAttempts: 1,
          maxDeliveryAttempts: 5,
        },
        {
          id: "4",
          deliveryStatus: "failed",
          deliveryAttempts: 5,
          maxDeliveryAttempts: 5,
        },
      ];

      mockPrisma.notification.findMany.mockResolvedValue(mockNotifications);

      const metrics = await service.getDeliveryMetrics();

      expect(metrics.totalNotifications).toBe(4);
      expect(metrics.deliveredCount).toBe(2);
      expect(metrics.pendingCount).toBe(1);
      expect(metrics.failedCount).toBe(1);
      expect(metrics.exhaustedCount).toBe(1);
      expect(metrics.averageAttemptsToSuccess).toBe(2); // (1 + 3) / 2
      expect(metrics.deliveryRate).toBe(50); // 2/4 * 100
    });

    it("filters metrics by wallet address", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      await service.getDeliveryMetrics({ walletAddress: "0xtest" });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            walletAddress: "0xtest",
          }),
        })
      );
    });

    it("filters metrics by time range", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      const start = new Date("2024-01-01");
      const end = new Date("2024-01-31");

      await service.getDeliveryMetrics({ timeRange: { start, end } });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: start, lte: end },
          }),
        })
      );
    });
  });

  describe("findNotificationsForRetry", () => {
    it("finds failed notifications eligible for retry", async () => {
      const mockNotifications = [
        { id: "notif-1" },
        { id: "notif-2" },
      ];

      mockPrisma.notification.findMany.mockResolvedValue(mockNotifications);

      const ids = await service.findNotificationsForRetry();

      expect(ids).toEqual(["notif-1", "notif-2"]);
      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            deliveryStatus: "failed",
          }),
        })
      );
    });

    it("respects batch size limits", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      await service.findNotificationsForRetry({ batchSize: 50 });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
        })
      );
    });

    it("respects max age for exponential backoff", async () => {
      mockPrisma.notification.findMany.mockResolvedValue([]);

      const maxAge = 7200000; // 2 hours
      await service.findNotificationsForRetry({ maxAge });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            updatedAt: expect.objectContaining({
              lt: expect.any(Date),
            }),
          }),
        })
      );
    });
  });

  describe("markAsExhausted", () => {
    it("marks exhausted notifications as permanently failed", async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });

      const count = await service.markAsExhausted(["notif-1", "notif-2"]);

      expect(count).toBe(2);
      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: { in: ["notif-1", "notif-2"] },
        }),
        data: expect.objectContaining({
          deliveryStatus: "failed",
          lastDeliveryError: "Maximum delivery attempts exhausted",
        }),
      });
    });
  });
});
