/**
 * Tests for idempotency service
 *
 * Verifies:
 * - Idempotency key creation and validation
 * - Duplicate request handling
 * - Expired key handling
 * - Key collision cases
 * - Response caching
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { IdempotencyService, DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS, MAX_TTL_SECONDS } from "./idempotencyService";
import type { PrismaClient } from "@prisma/client";

// Mock Prisma client
const mockPrisma = {
  idempotencyKey: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
} as unknown as PrismaClient;

describe("IdempotencyService", () => {
  let service: IdempotencyService;

  beforeEach(() => {
    service = new IdempotencyService(mockPrisma);
    vi.clearAllMocks();
  });

  describe("checkKey", () => {
    it("should return not duplicate for non-existent key", async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);

      const result = await service.checkKey("test-key");

      expect(result.isDuplicate).toBe(false);
      expect(result.isExpired).toBe(false);
      expect(result.record).toBeUndefined();
    });

    it("should return duplicate for existing valid key", async () => {
      const mockRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        walletAddress: "wallet-1",
        status: "completed",
        response: { result: "success" },
        expiresAt: new Date(Date.now() + 3600000), // 1 hour from now
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(mockRecord);

      const result = await service.checkKey("test-key");

      expect(result.isDuplicate).toBe(true);
      expect(result.isExpired).toBe(false);
      expect(result.record).toEqual(mockRecord);
    });

    it("should mark expired keys and return expired", async () => {
      const mockRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        walletAddress: "wallet-1",
        status: "completed",
        response: { result: "success" },
        expiresAt: new Date(Date.now() - 3600000), // 1 hour ago
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(mockRecord);
      mockPrisma.idempotencyKey.update.mockResolvedValue({ ...mockRecord, status: "expired" });

      const result = await service.checkKey("test-key");

      expect(result.isDuplicate).toBe(false);
      expect(result.isExpired).toBe(true);
      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: "test-key" },
        data: { status: "expired" },
      });
    });
  });

  describe("createKey", () => {
    it("should create a new idempotency key", async () => {
      const mockRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        walletAddress: "wallet-1",
        status: "pending",
        response: null,
        expiresAt: new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.create.mockResolvedValue(mockRecord);

      const result = await service.createKey({
        key: "test-key",
        operationType: "action",
        walletAddress: "wallet-1",
      });

      expect(result).toEqual(mockRecord);
      expect(mockPrisma.idempotencyKey.create).toHaveBeenCalledWith({
        data: {
          key: "test-key",
          operationType: "action",
          walletAddress: "wallet-1",
          status: "pending",
          response: null,
          expiresAt: expect.any(Date),
        },
      });
    });

    it("should use default TTL when not specified", async () => {
      const mockRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        walletAddress: "wallet-1",
        status: "pending",
        response: null,
        expiresAt: new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.create.mockResolvedValue(mockRecord);

      await service.createKey({
        key: "test-key",
        operationType: "action",
      });

      const createCall = mockPrisma.idempotencyKey.create.mock.calls[0][0];
      const expiresAt = createCall.data.expiresAt;
      const expectedExpiresAt = new Date(Date.now() + DEFAULT_TTL_SECONDS * 1000);

      expect(Math.abs(expiresAt.getTime() - expectedExpiresAt.getTime())).toBeLessThan(1000);
    });

    it("should clamp TTL to minimum", async () => {
      mockPrisma.idempotencyKey.create.mockResolvedValue({});

      await service.createKey({
        key: "test-key",
        operationType: "action",
        ttlSeconds: 10, // Below minimum
      });

      const createCall = mockPrisma.idempotencyKey.create.mock.calls[0][0];
      const expiresAt = createCall.data.expiresAt;
      const expectedExpiresAt = new Date(Date.now() + MIN_TTL_SECONDS * 1000);

      expect(Math.abs(expiresAt.getTime() - expectedExpiresAt.getTime())).toBeLessThan(1000);
    });

    it("should clamp TTL to maximum", async () => {
      mockPrisma.idempotencyKey.create.mockResolvedValue({});

      await service.createKey({
        key: "test-key",
        operationType: "action",
        ttlSeconds: MAX_TTL_SECONDS + 1000, // Above maximum
      });

      const createCall = mockPrisma.idempotencyKey.create.mock.calls[0][0];
      const expiresAt = createCall.data.expiresAt;
      const expectedExpiresAt = new Date(Date.now() + MAX_TTL_SECONDS * 1000);

      expect(Math.abs(expiresAt.getTime() - expectedExpiresAt.getTime())).toBeLessThan(1000);
    });
  });

  describe("executeWithIdempotency", () => {
    it("should execute operation and cache result for new key", async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
      mockPrisma.idempotencyKey.create.mockResolvedValue({
        id: "1",
        key: "test-key",
        operationType: "action",
        status: "pending",
        response: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.idempotencyKey.update.mockResolvedValue({});

      const operation = vi.fn().mockResolvedValue({ result: "success" });

      const result = await service.executeWithIdempotency(
        {
          key: "test-key",
          operationType: "action",
        },
        operation
      );

      expect(result.wasDuplicate).toBe(false);
      expect(result.data).toEqual({ result: "success" });
      expect(result.fromCache).toBe(false);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: "test-key" },
        data: {
          status: "completed",
          response: { result: "success" },
        },
      });
    });

    it("should return cached result for duplicate key", async () => {
      const mockRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        status: "completed",
        response: { result: "cached" },
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(mockRecord);

      const operation = vi.fn().mockResolvedValue({ result: "new" });

      const result = await service.executeWithIdempotency(
        {
          key: "test-key",
          operationType: "action",
        },
        operation
      );

      expect(result.wasDuplicate).toBe(true);
      expect(result.data).toEqual({ result: "cached" });
      expect(result.fromCache).toBe(true);
      expect(operation).not.toHaveBeenCalled();
    });

    it("should throw error for failed duplicate key", async () => {
      const mockRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        status: "failed",
        errorCode: "VALIDATION_ERROR",
        errorDetail: "Invalid input",
        response: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(mockRecord);

      const operation = vi.fn().mockResolvedValue({ result: "new" });

      await expect(
        service.executeWithIdempotency(
          {
            key: "test-key",
            operationType: "action",
          },
          operation
        )
      ).rejects.toThrow("Operation previously failed: VALIDATION_ERROR - Invalid input");

      expect(operation).not.toHaveBeenCalled();
    });

    it("should throw error for pending duplicate key", async () => {
      const mockRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        status: "pending",
        response: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(mockRecord);

      const operation = vi.fn().mockResolvedValue({ result: "new" });

      await expect(
        service.executeWithIdempotency(
          {
            key: "test-key",
            operationType: "action",
          },
          operation
        )
      ).rejects.toThrow("Operation is already in progress with this idempotency key");

      expect(operation).not.toHaveBeenCalled();
    });

    it("should delete expired key and execute new operation", async () => {
      const expiredRecord = {
        id: "1",
        key: "test-key",
        operationType: "action",
        status: "completed",
        response: { result: "old" },
        expiresAt: new Date(Date.now() - 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(expiredRecord);
      mockPrisma.idempotencyKey.update.mockResolvedValue({ ...expiredRecord, status: "expired" });
      mockPrisma.idempotencyKey.delete.mockResolvedValue({});
      mockPrisma.idempotencyKey.create.mockResolvedValue({
        id: "2",
        key: "test-key",
        operationType: "action",
        status: "pending",
        response: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.idempotencyKey.update.mockResolvedValue({});

      const operation = vi.fn().mockResolvedValue({ result: "new" });

      const result = await service.executeWithIdempotency(
        {
          key: "test-key",
          operationType: "action",
        },
        operation
      );

      expect(result.wasDuplicate).toBe(false);
      expect(result.data).toEqual({ result: "new" });
      expect(mockPrisma.idempotencyKey.delete).toHaveBeenCalledWith({
        where: { key: "test-key" },
      });
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should store error on operation failure", async () => {
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
      mockPrisma.idempotencyKey.create.mockResolvedValue({
        id: "1",
        key: "test-key",
        operationType: "action",
        status: "pending",
        response: null,
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPrisma.idempotencyKey.update.mockResolvedValue({});

      const operation = vi.fn().mockRejectedValue(new Error("Operation failed"));

      await expect(
        service.executeWithIdempotency(
          {
            key: "test-key",
            operationType: "action",
          },
          operation
        )
      ).rejects.toThrow("Operation failed");

      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: "test-key" },
        data: {
          status: "failed",
          errorCode: "Error",
          errorDetail: "Operation failed",
        },
      });
    });
  });

  describe("markCompleted", () => {
    it("should mark key as completed with response", async () => {
      mockPrisma.idempotencyKey.update.mockResolvedValue({});

      await service.markCompleted("test-key", { result: "success" });

      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: "test-key" },
        data: {
          status: "completed",
          response: { result: "success" },
        },
      });
    });
  });

  describe("markFailed", () => {
    it("should mark key as failed with error details", async () => {
      mockPrisma.idempotencyKey.update.mockResolvedValue({});

      await service.markFailed("test-key", "VALIDATION_ERROR", "Invalid input");

      expect(mockPrisma.idempotencyKey.update).toHaveBeenCalledWith({
        where: { key: "test-key" },
        data: {
          status: "failed",
          errorCode: "VALIDATION_ERROR",
          errorDetail: "Invalid input",
        },
      });
    });
  });

  describe("deleteKey", () => {
    it("should delete a key", async () => {
      mockPrisma.idempotencyKey.delete.mockResolvedValue({});

      await service.deleteKey("test-key");

      expect(mockPrisma.idempotencyKey.delete).toHaveBeenCalledWith({
        where: { key: "test-key" },
      });
    });
  });

  describe("cleanupExpired", () => {
    it("should delete expired keys and return count", async () => {
      mockPrisma.idempotencyKey.deleteMany.mockResolvedValue({ count: 42 });

      const count = await service.cleanupExpired();

      expect(count).toBe(42);
      expect(mockPrisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
        where: {
          expiresAt: { lt: expect.any(Date) },
        },
      });
    });
  });

  describe("getKeysForWallet", () => {
    it("should return keys for wallet", async () => {
      const mockRecords = [
        {
          id: "1",
          key: "key-1",
          operationType: "action",
          walletAddress: "wallet-1",
          status: "completed",
          response: null,
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrisma.idempotencyKey.findMany.mockResolvedValue(mockRecords);

      const result = await service.getKeysForWallet("wallet-1");

      expect(result).toEqual(mockRecords);
      expect(mockPrisma.idempotencyKey.findMany).toHaveBeenCalledWith({
        where: {
          walletAddress: "wallet-1",
        },
        orderBy: { createdAt: "desc" },
      });
    });

    it("should filter by operation type when provided", async () => {
      mockPrisma.idempotencyKey.findMany.mockResolvedValue([]);

      await service.getKeysForWallet("wallet-1", "action");

      expect(mockPrisma.idempotencyKey.findMany).toHaveBeenCalledWith({
        where: {
          walletAddress: "wallet-1",
          operationType: "action",
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("generateKey", () => {
    it("should generate deterministic key from parameters", () => {
      const params1 = { wallet: "wallet-1", amount: 100, poolId: "pool-1" };
      const params2 = { amount: 100, poolId: "pool-1", wallet: "wallet-1" }; // Different order

      const key1 = IdempotencyService.generateKey("action", params1);
      const key2 = IdempotencyService.generateKey("action", params2);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^action:[a-f0-9]{64}$/);
    });

    it("should generate different keys for different parameters", () => {
      const params1 = { wallet: "wallet-1", amount: 100 };
      const params2 = { wallet: "wallet-1", amount: 200 };

      const key1 = IdempotencyService.generateKey("action", params1);
      const key2 = IdempotencyService.generateKey("action", params2);

      expect(key1).not.toBe(key2);
    });

    it("should generate different keys for different operation types", () => {
      const params = { wallet: "wallet-1", amount: 100 };

      const key1 = IdempotencyService.generateKey("action", params);
      const key2 = IdempotencyService.generateKey("settlement", params);

      expect(key1).not.toBe(key2);
    });
  });
});
