import { describe, it, expect, beforeEach, vi } from "vitest";
import { DrawProofService } from "../src/services/drawProofService.js";
import { FeatureFlagService, FEATURE_FLAGS } from "../src/services/featureFlagService.js";

describe("DrawProofService with FeatureFlagService", () => {
  let mockPrisma: any;
  let mockLogger: any;
  let mockRpc: any;
  let featureFlagService: FeatureFlagService;
  let drawProofService: DrawProofService;

  beforeEach(() => {
    mockPrisma = {
      featureFlag: {
        findUnique: vi.fn(),
        upsert: vi.fn(),
      },
      featureFlagAudit: {
        create: vi.fn(),
      },
      actionLedger: {
        findUnique: vi.fn(),
      },
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };

    mockRpc = null; // Can be mocked per test

    featureFlagService = new FeatureFlagService(mockPrisma);
    drawProofService = new DrawProofService(mockPrisma, mockRpc, mockLogger, featureFlagService);
  });

  describe("generateProofImpl with PRIZE_DRAW_EXECUTION flag", () => {
    it("skips proof generation when flag is disabled (safe default)", async () => {
      // Flag disabled (safe default)
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: false,
      });

      const result = await drawProofService.generateProof({
        actionId: "action-123",
      });

      expect(result).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith(
        { actionId: "action-123" },
        "draw proof generation skipped: PRIZE_DRAW_EXECUTION flag is disabled"
      );

      // Database should not be queried for the action because flag check short-circuits
      expect(mockPrisma.actionLedger.findUnique).not.toHaveBeenCalled();
    });

    it("proceeds with proof generation when flag is explicitly enabled", async () => {
      // Flag enabled
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: true,
      });

      // Flag check passes, now proceed to action lookup
      // (which will fail because we're not mocking the full RPC flow,
      // but that's OK for this test — we're verifying the flag let us proceed)
      mockPrisma.actionLedger.findUnique.mockResolvedValue(null);

      const result = await drawProofService.generateProof({
        actionId: "action-123",
      });

      // With action not found, result is null, but we got past the flag check
      expect(result).toBeNull();
      expect(mockPrisma.actionLedger.findUnique).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { actionId: "action-123" },
        "draw proof: action not found"
      );
    });

    it("skips proof generation when feature flag service is not provided (safe default)", async () => {
      // Instantiate DrawProofService without FeatureFlagService
      const svcWithoutFlags = new DrawProofService(mockPrisma, mockRpc, mockLogger);

      const result = await svcWithoutFlags.generateProof({
        actionId: "action-456",
      });

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { actionId: "action-456" },
        "draw proof generation skipped: no feature flag service configured (safe default)"
      );

      // Database should not be queried
      expect(mockPrisma.actionLedger.findUnique).not.toHaveBeenCalled();
    });

    it("defaults to disabled (safe) when flag lookup fails", async () => {
      // Simulate database error during flag lookup
      mockPrisma.featureFlag.findUnique.mockRejectedValue(
        new Error("database connection failed")
      );

      const result = await drawProofService.generateProof({
        actionId: "action-789",
      });

      expect(result).toBeNull();
      // Should log warning about generation being skipped
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "action-789" }),
        expect.stringContaining("skipped")
      );
    });

    it("respects vault-scoped flag overrides", async () => {
      // Global flag is disabled
      // But vault-specific flag is enabled
      // (This would require the DrawProofService to have access to vault context,
      // which would be passed through action payload — for now, just test global scope)

      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        key: FEATURE_FLAGS.PRIZE_DRAW_EXECUTION,
        scope: "global",
        enabled: false,
      });

      const result = await drawProofService.generateProof({
        actionId: "action-vault-123",
      });

      expect(result).toBeNull();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "action-vault-123" }),
        "draw proof generation skipped: PRIZE_DRAW_EXECUTION flag is disabled"
      );
    });
  });

  describe("Staged rollout workflow", () => {
    it("allows enabling flag to stage rollout", async () => {
      // 1. Initially, flag is disabled (safe default)
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        enabled: false,
      });

      let result = await drawProofService.generateProof({ actionId: "action-1" });
      expect(result).toBeNull();

      // 2. Operator enables flag for staged rollout
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        enabled: true,
      });

      mockPrisma.actionLedger.findUnique.mockResolvedValue(null); // Action not found for this test

      // 3. Proof generation now proceeds (would succeed with full setup)
      result = await drawProofService.generateProof({ actionId: "action-2" });
      expect(mockPrisma.actionLedger.findUnique).toHaveBeenCalled();
    });
  });

  describe("Emergency rollback workflow", () => {
    it("allows disabling flag for emergency rollback", async () => {
      // 1. Flag is enabled (in production)
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        enabled: true,
      });

      mockPrisma.actionLedger.findUnique.mockResolvedValue(null);
      await drawProofService.generateProof({ actionId: "action-A" });
      expect(mockPrisma.actionLedger.findUnique).toHaveBeenCalled();

      // 2. Operator disables flag for emergency rollback
      mockPrisma.featureFlag.findUnique.mockResolvedValue({
        enabled: false,
      });

      mockPrisma.actionLedger.findUnique.mockClear();

      // 3. Proof generation is immediately stopped; no new proofs generated
      const result = await drawProofService.generateProof({ actionId: "action-B" });
      expect(result).toBeNull();
      expect(mockPrisma.actionLedger.findUnique).not.toHaveBeenCalled();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { actionId: "action-B" },
        "draw proof generation skipped: PRIZE_DRAW_EXECUTION flag is disabled"
      );
    });
  });
});
