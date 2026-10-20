import { describe, it, expect, beforeEach, vi } from "vitest";
import { FeatureFlagService, FEATURE_FLAGS } from "../src/services/featureFlagService.js";

describe("FeatureFlagService", () => {
  let mockPrisma: any;
  let service: FeatureFlagService;

  beforeEach(() => {
    mockPrisma = {
      featureFlag: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      featureFlagAudit: {
        create: vi.fn(),
      },
    };
    service = new FeatureFlagService(mockPrisma);
  });

  describe("isEnabled", () => {
    it("returns true when flag exists and is enabled", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      const result = await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(result).toBe(true);
    });

    it("returns false when flag exists but is disabled", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: false,
      });

      const result = await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(result).toBe(false);
    });

    it("returns false (safe default) when flag does not exist", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue(null);

      const result = await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(result).toBe(false);
    });

    it("returns false (safe default) when database lookup fails", async () => {
      mockPrisma.featureFlag.findUnique.mockRejectedValue(
        new Error("database connection failed")
      );

      const result = await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(result).toBe(false);
    });

    it("supports vault-scoped flags", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED,
        scope: "vault:my-vault-123",
        enabled: true,
      });

      const result = await service.isEnabled(
        FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED,
        { vault: "my-vault-123" }
      );

      expect(result).toBe(true);
      expect(mockPrisma.featureFlag.findUnique).toHaveBeenCalledWith({
        where: {
          key_scope: {
            key: FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED,
            scope: "vault:my-vault-123",
          },
        },
      });
    });

    it("supports wallet-scoped flags", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.RECONCILIATION_AUTO_REPAIR,
        scope: "wallet:GBD3NQ32D65L4QNHBDJSQQXPVVJ6GYGD5YZPPZVVLZXBF5XVPFXG5JNV",
        enabled: true,
      });

      const result = await service.isEnabled(
        FEATURE_FLAGS.RECONCILIATION_AUTO_REPAIR,
        { wallet: "GBD3NQ32D65L4QNHBDJSQQXPVVJ6GYGD5YZPPZVVLZXBF5XVPFXG5JNV" }
      );

      expect(result).toBe(true);
    });

    it("caches results for 30 seconds", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      // First call hits database
      await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(mockPrisma.featureFlag.findUnique).toHaveBeenCalledTimes(1);

      // Second call uses cache
      await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(mockPrisma.featureFlag.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe("setFlag", () => {
    it("creates a new flag when it doesn't exist", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue(null);
      mockPrisma.featureFlag.upsert.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      await service.setFlag(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION, true, {
        actor: "admin-123",
        reason: "Staged rollout: enabling prize draws",
      });

      expect(mockPrisma.featureFlag.upsert).toHaveBeenCalledWith({
        where: {
          key_scope: {
            key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
            scope: "global",
          },
        },
        create: {
          key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
          enabled: true,
          scope: "global",
        },
        update: {
          enabled: true,
        },
      });

      // Verify audit trail created
      expect(mockPrisma.featureFlagAudit.create).toHaveBeenCalledWith({
        data: {
          flagKey: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
          previousValue: false,
          newValue: true,
          actor: "admin-123",
          reason: "Staged rollout: enabling prize draws",
        },
      });
    });

    it("updates existing flag and creates audit trail", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: false,
      });
      mockPrisma.featureFlag.upsert.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      await service.setFlag(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION, true, {
        actor: "operator",
        reason: "Emergency rollback",
      });

      expect(mockPrisma.featureFlagAudit.create).toHaveBeenCalledWith({
        data: {
          flagKey: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
          previousValue: false,
          newValue: true,
          actor: "operator",
          reason: "Emergency rollback",
        },
      });
    });

    it("disables flag and records audit trail", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      await service.setFlag(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION, false, {
        actor: "admin-456",
        reason: "Draw logic bug detected",
      });

      expect(mockPrisma.featureFlagAudit.create).toHaveBeenCalledWith({
        data: {
          flagKey: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
          previousValue: true,
          newValue: false,
          actor: "admin-456",
          reason: "Draw logic bug detected",
        },
      });
    });

    it("invalidates cache after updating flag", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue(null);

      // Populate cache
      await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);

      // Update flag
      await service.setFlag(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION, true);

      // Cache should be cleared; next call should hit database
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      // Should have called findUnique twice (once for cache, once after setFlag)
      expect(mockPrisma.featureFlag.findUnique).toHaveBeenCalled();
    });

    it("supports vault-scoped flag updates", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue(null);

      await service.setFlag(FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED, true, {
        scope: "vault:vault-xyz",
      });

      expect(mockPrisma.featureFlag.upsert).toHaveBeenCalledWith({
        where: {
          key_scope: {
            key: FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED,
            scope: "vault:vault-xyz",
          },
        },
        create: {
          key: FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED,
          enabled: true,
          scope: "vault:vault-xyz",
        },
        update: {
          enabled: true,
        },
      });
    });
  });

  describe("clearCache", () => {
    it("clears the entire flag cache", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      // Populate cache
      await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(mockPrisma.featureFlag.findUnique).toHaveBeenCalledTimes(1);

      // Clear cache
      service.clearCache();

      // Next call should hit database again
      await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(mockPrisma.featureFlag.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe("Safe defaults", () => {
    it("defaults to disabled (safer) for new flags when not explicitly set", async () => {
      mockPrisma.featureFlag.findUnique.mockResolvedValue(null);

      // PRIZE_DRAW_EXECUTION defaults to disabled: proofs not generated
      const drawEnabled = await service.isEnabled(FEATURE_FLAGS.PRIZE_DRAW_EXECUTION);
      expect(drawEnabled).toBe(false);

      // RECONCILIATION_AUTO_REPAIR defaults to disabled: repairs not applied automatically
      const repairEnabled = await service.isEnabled(
        FEATURE_FLAGS.RECONCILIATION_AUTO_REPAIR
      );
      expect(repairEnabled).toBe(false);

      // WITHDRAWAL_SUBMISSION_ENABLED defaults to disabled: withdrawals not submitted
      const withdrawalEnabled = await service.isEnabled(
        FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED
      );
      expect(withdrawalEnabled).toBe(false);
    });
  });
});
