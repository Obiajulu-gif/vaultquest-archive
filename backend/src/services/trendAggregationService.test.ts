/**
 * Tests for trend aggregation service
 *
 * Verifies:
 * - Deterministic aggregation for fixture data
 * - Privacy redaction for sensitive data
 * - Date range handling and edge cases
 * - Large result set handling
 * - Schema versioning
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TrendAggregationService, WINDOW_DURATIONS, TREND_SCHEMA_VERSION, type TrendMetric } from "./trendAggregationService";
import type { PrismaClient } from "@prisma/client";

// Mock Prisma client
const mockPrisma = {
  trendAggregate: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  actionLedger: {
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
  savedPool: {
    findMany: vi.fn(),
  },
} as unknown as PrismaClient;

describe("TrendAggregationService", () => {
  let service: TrendAggregationService;

  beforeEach(() => {
    service = new TrendAggregationService(mockPrisma);
    vi.clearAllMocks();
  });

  describe("WINDOW_DURATIONS", () => {
    it("should have correct window durations", () => {
      expect(WINDOW_DURATIONS.hour).toBe(60 * 60 * 1000);
      expect(WINDOW_DURATIONS.day).toBe(24 * 60 * 60 * 1000);
      expect(WINDOW_DURATIONS.week).toBe(7 * 24 * 60 * 60 * 1000);
      expect(WINDOW_DURATIONS.month).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe("aggregateTrends", () => {
    it("should aggregate deposits for a time range", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([
        {
          actionPayload: { amount: 100 },
          walletAddress: "wallet1",
          createdAt: startDate,
        },
        {
          actionPayload: { amount: 200 },
          walletAddress: "wallet2",
          createdAt: startDate,
        },
      ]);

      const result = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
      });

      expect(result.metricName).toBe("total_deposits");
      expect(result.window).toBe("day");
      expect(result.schemaVersion).toBe(TREND_SCHEMA_VERSION);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].value).toBe(300);
      expect(result.data[0].count).toBe(2);
    });

    it("should aggregate with metadata when requested", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([
        {
          actionPayload: { amount: 100 },
          walletAddress: "wallet1",
          createdAt: startDate,
        },
      ]);

      const result = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
        includeMetadata: true,
      });

      expect(result.data[0].metadata).toBeDefined();
      expect(result.data[0].metadata?.uniqueWallets).toBe(1);
    });

    it("should handle empty data", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([]);

      const result = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
      });

      expect(result.data[0].value).toBe(0);
      expect(result.data[0].count).toBe(0);
    });
  });

  describe("aggregateMultipleMetrics", () => {
    it("should aggregate multiple metrics in parallel", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([]);
      mockPrisma.savedPool.findMany.mockResolvedValue([]);

      const result = await service.aggregateMultipleMetrics(
        ["total_deposits", "total_withdrawals", "pool_count"],
        "day",
        startDate,
        endDate
      );

      expect(Object.keys(result)).toHaveLength(3);
      expect(result.total_deposits).toBeDefined();
      expect(result.total_withdrawals).toBeDefined();
      expect(result.pool_count).toBeDefined();
    });
  });

  describe("exportTrends", () => {
    it("should export trends with schema version", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([]);
      mockPrisma.savedPool.findMany.mockResolvedValue([]);

      const result = await service.exportTrends(
        ["total_deposits", "total_withdrawals"],
        ["day"],
        startDate,
        endDate
      );

      expect(result.schemaVersion).toBe(TREND_SCHEMA_VERSION);
      expect(result.exportDate).toBeDefined();
      expect(result.metrics).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.metadata.windows).toEqual(["day"]);
    });
  });

  describe("privacy redaction", () => {
    it("should redact sensitive fields", () => {
      const data = {
        walletAddress: "GD...123",
        email: "user@example.com",
        amount: 100,
      };

      const redacted = service.applyPrivacyRedaction(data);

      expect(redacted.walletAddress).toBeDefined();
      expect(redacted.walletAddress).not.toBe("GD...123");
      expect(redacted.email).toBeUndefined();
      expect(redacted.amount).toBe(100);
    });

    it("should hash wallet addresses", () => {
      const data = {
        walletAddress: "GD...123",
        amount: 100,
      };

      const redacted = service.applyPrivacyRedaction(data);

      expect(redacted.walletAddress).toMatch(/^[a-f0-9]+$/);
      expect(redacted.walletAddress).not.toBe("GD...123");
    });
  });

  describe("date range handling", () => {
    it("should handle single day window", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-01T23:59:59Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([]);

      const result = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
      });

      expect(result.data).toHaveLength(1);
    });

    it("should handle multi-day window", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-03T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([]);

      const result = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
      });

      expect(result.data.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle hour window", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-01T23:59:59Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([]);

      const result = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "hour",
        startDate,
        endDate,
      });

      expect(result.data.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("deterministic aggregation", () => {
    it("should produce consistent results for same input", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([
        {
          actionPayload: { amount: 100 },
          walletAddress: "wallet1",
          createdAt: startDate,
        },
      ]);

      const result1 = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
      });

      const result2 = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
      });

      expect(result1.data[0].value).toBe(result2.data[0].value);
      expect(result1.data[0].count).toBe(result2.data[0].count);
    });
  });

  describe("large result sets", () => {
    it("should handle large number of records", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      // Mock 1000 records
      const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
        actionPayload: { amount: 10 },
        walletAddress: `wallet${i % 100}`,
        createdAt: startDate,
      }));

      mockPrisma.actionLedger.findMany.mockResolvedValue(largeDataset);

      const result = await service.aggregateTrends({
        metricName: "total_deposits",
        window: "day",
        startDate,
        endDate,
      });

      expect(result.data[0].value).toBe(10000);
      expect(result.data[0].count).toBe(1000);
    });
  });

  describe("different metric types", () => {
    it("should aggregate failed transactions", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.findMany.mockResolvedValue([
        {
          actionType: "deposit",
          errorCode: "NETWORK_ERROR",
          walletAddress: "wallet1",
        },
        {
          actionType: "withdraw",
          errorCode: "CONTRACT_ERROR",
          walletAddress: "wallet2",
        },
      ]);

      const result = await service.aggregateTrends({
        metricName: "failed_transactions",
        window: "day",
        startDate,
        endDate,
        includeMetadata: true,
      });

      expect(result.data[0].value).toBe(2);
      expect(result.data[0].metadata?.byActionType).toBeDefined();
    });

    it("should aggregate active users", async () => {
      const startDate = new Date("2024-01-01T00:00:00Z");
      const endDate = new Date("2024-01-02T00:00:00Z");

      mockPrisma.actionLedger.groupBy.mockResolvedValue([
        { walletAddress: "wallet1", _count: 5 },
        { walletAddress: "wallet2", _count: 3 },
      ]);

      const result = await service.aggregateTrends({
        metricName: "active_users",
        window: "day",
        startDate,
        endDate,
      });

      expect(result.data[0].value).toBe(2);
    });
  });
});
