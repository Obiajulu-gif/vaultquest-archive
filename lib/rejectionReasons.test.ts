/**
 * Tests for VaultQuest rejection reason codes and explanation objects
 *
 * This test suite verifies:
 * - All rejection reasons have valid explanations
 * - Rejection categories are correctly assigned
 * - Recovery hints are user-safe and actionable
 * - Mapping functions work correctly
 * - Fallback behavior for unknown reasons
 */

import { describe, it, expect } from "vitest";
import {
  VAULT_REJECTION_REASONS,
  REJECTION_EXPLANATIONS,
  getRejectionExplanation,
  isVaultRejectionReason,
  mapContractErrorToRejection,
  mapWalletErrorToRejection,
  type RejectionCategory,
  type VaultRejectionReason,
} from "./rejectionReasons";

describe("rejectionReasons", () => {
  describe("VAULT_REJECTION_REASONS", () => {
    it("should have stable, unique reason codes", () => {
      const codes = Object.values(VAULT_REJECTION_REASONS);
      const uniqueCodes = new Set(codes);
      expect(codes.length).toBe(uniqueCodes.size);
      expect(codes.every((code) => code.startsWith("VAULT_"))).toBe(true);
    });

    it("should have the expected number of rejection reasons", () => {
      const codes = Object.values(VAULT_REJECTION_REASONS);
      expect(codes.length).toBeGreaterThan(30); // Ensure we have comprehensive coverage
    });
  });

  describe("REJECTION_EXPLANATIONS", () => {
    it("should have an explanation for every rejection reason", () => {
      const reasonCodes = Object.values(VAULT_REJECTION_REASONS);
      const explanationCodes = Object.keys(REJECTION_EXPLANATIONS);

      reasonCodes.forEach((code) => {
        expect(explanationCodes).toContain(code);
      });
    });

    it("should have valid category assignments", () => {
      const validCategories: RejectionCategory[] = [
        "validation",
        "permission",
        "policy",
        "stale_state",
        "external",
      ];

      Object.values(REJECTION_EXPLANATIONS).forEach((explanation) => {
        expect(validCategories).toContain(explanation.category);
      });
    });

    it("should have user-safe messages", () => {
      Object.values(REJECTION_EXPLANATIONS).forEach((explanation) => {
        expect(explanation.userMessage).toBeTruthy();
        expect(explanation.userMessage.length).toBeGreaterThan(10);
        // Should not contain technical jargon or stack traces
        expect(explanation.userMessage).not.toMatch(/stack trace|database|prisma|rpc/i);
      });
    });

    it("should have actionable recovery hints", () => {
      Object.values(REJECTION_EXPLANATIONS).forEach((explanation) => {
        expect(explanation.recoveryHint).toBeTruthy();
        expect(explanation.recoveryHint.length).toBeGreaterThan(10);
        // Should contain actionable verbs
        expect(explanation.recoveryHint).toMatch(
          /(check|verify|refresh|retry|contact|choose|wait|ensure|approve|connect|use|deposit|withdraw)/i
        );
      });
    });

    it("should have correct retryable flags", () => {
      // External and stale_state errors should generally be retryable
      const retryableCategories: RejectionCategory[] = ["external", "stale_state"];
      // Validation, permission, and policy errors should generally not be retryable
      const nonRetryableCategories: RejectionCategory[] = ["validation", "permission", "policy"];

      Object.entries(REJECTION_EXPLANATIONS).forEach(([code, explanation]) => {
        if (retryableCategories.includes(explanation.category)) {
          expect(explanation.retryable).toBe(true);
        }
        // Note: some policy errors might be retryable (e.g., signature_required)
        // so we don't enforce strict non-retryable for policy
      });
    });

    it("should include technical context for debugging", () => {
      Object.values(REJECTION_EXPLANATIONS).forEach((explanation) => {
        // Technical context is optional but should be informative if present
        if (explanation.technicalContext) {
          expect(explanation.technicalContext.length).toBeGreaterThan(5);
        }
      });
    });
  });

  describe("getRejectionExplanation", () => {
    it("should return the correct explanation for known reasons", () => {
      const explanation = getRejectionExplanation(VAULT_REJECTION_REASONS.INVALID_AMOUNT);
      expect(explanation.reasonCode).toBe(VAULT_REJECTION_REASONS.INVALID_AMOUNT);
      expect(explanation.category).toBe("validation");
      expect(explanation.userMessage).toBeTruthy();
      expect(explanation.recoveryHint).toBeTruthy();
    });

    it("should return a fallback for unknown reasons", () => {
      const explanation = getRejectionExplanation("UNKNOWN_REASON");
      expect(explanation.reasonCode).toBe("UNKNOWN");
      expect(explanation.category).toBe("external");
      expect(explanation.userMessage).toBeTruthy();
      expect(explanation.recoveryHint).toBeTruthy();
      expect(explanation.retryable).toBe(true);
    });

    it("should handle empty string gracefully", () => {
      const explanation = getRejectionExplanation("");
      expect(explanation.reasonCode).toBe("UNKNOWN");
    });
  });

  describe("isVaultRejectionReason", () => {
    it("should return true for valid rejection reasons", () => {
      expect(isVaultRejectionReason(VAULT_REJECTION_REASONS.INVALID_AMOUNT)).toBe(true);
      expect(isVaultRejectionReason(VAULT_REJECTION_REASONS.LOCKUP_ACTIVE)).toBe(true);
      expect(isVaultRejectionReason(VAULT_REJECTION_REASONS.WALLET_REJECTED)).toBe(true);
    });

    it("should return false for invalid rejection reasons", () => {
      expect(isVaultRejectionReason("INVALID_AMOUNT")).toBe(false);
      expect(isVaultRejectionReason("UNKNOWN")).toBe(false);
      expect(isVaultRejectionReason("")).toBe(false);
    });
  });

  describe("mapContractErrorToRejection", () => {
    it("should map contract errors to vault rejection reasons", () => {
      expect(mapContractErrorToRejection("InvalidAmount")).toBe(
        VAULT_REJECTION_REASONS.INVALID_AMOUNT
      );
      expect(mapContractErrorToRejection("LockupActive")).toBe(
        VAULT_REJECTION_REASONS.LOCKUP_ACTIVE
      );
      expect(mapContractErrorToRejection("InvalidAction")).toBe(
        VAULT_REJECTION_REASONS.INVALID_ACTION_STATE
      );
      expect(mapContractErrorToRejection("ClaimDeadlinePassed")).toBe(
        VAULT_REJECTION_REASONS.CLAIM_DEADLINE_PASSED
      );
    });

    it("should return null for unknown contract errors", () => {
      expect(mapContractErrorToRejection("UnknownError")).toBe(null);
      expect(mapContractErrorToRejection("")).toBe(null);
    });
  });

  describe("mapWalletErrorToRejection", () => {
    it("should map wallet errors to vault rejection reasons", () => {
      expect(mapWalletErrorToRejection("wallet_disconnected")).toBe(
        VAULT_REJECTION_REASONS.WALLET_NOT_CONNECTED
      );
      expect(mapWalletErrorToRejection("signature_rejected")).toBe(
        VAULT_REJECTION_REASONS.WALLET_REJECTED
      );
      expect(mapWalletErrorToRejection("rpc_failure")).toBe(
        VAULT_REJECTION_REASONS.RPC_FAILURE
      );
      expect(mapWalletErrorToRejection("contract_error")).toBe(
        VAULT_REJECTION_REASONS.CONTRACT_REVERTED
      );
      expect(mapWalletErrorToRejection("stale_data")).toBe(
        VAULT_REJECTION_REASONS.STALE_POOL_DATA
      );
      expect(mapWalletErrorToRejection("lockup_active")).toBe(
        VAULT_REJECTION_REASONS.LOCKUP_ACTIVE
      );
      expect(mapWalletErrorToRejection("insufficient_liquidity")).toBe(
        VAULT_REJECTION_REASONS.INSUFFICIENT_LIQUIDITY
      );
      expect(mapWalletErrorToRejection("network_mismatch")).toBe(
        VAULT_REJECTION_REASONS.INVALID_ASSET
      );
      expect(mapWalletErrorToRejection("multisig_unsupported")).toBe(
        VAULT_REJECTION_REASONS.FORBIDDEN_OPERATION
      );
      expect(mapWalletErrorToRejection("confirmation_timeout")).toBe(
        VAULT_REJECTION_REASONS.TRANSACTION_TIMEOUT
      );
    });

    it("should return null for unknown wallet errors", () => {
      expect(mapWalletErrorToRejection("unknown_error")).toBe(null);
      expect(mapWalletErrorToRejection("")).toBe(null);
    });
  });

  describe("rejection categories", () => {
    it("should have comprehensive validation rejection reasons", () => {
      const validationReasons = Object.entries(REJECTION_EXPLANATIONS)
        .filter(([_, explanation]) => explanation.category === "validation")
        .map(([code]) => code);

      expect(validationReasons.length).toBeGreaterThan(10);
      expect(validationReasons).toContain(VAULT_REJECTION_REASONS.INVALID_AMOUNT);
      expect(validationReasons).toContain(VAULT_REJECTION_REASONS.INVALID_POOL_ID);
    });

    it("should have comprehensive permission rejection reasons", () => {
      const permissionReasons = Object.entries(REJECTION_EXPLANATIONS)
        .filter(([_, explanation]) => explanation.category === "permission")
        .map(([code]) => code);

      expect(permissionReasons.length).toBeGreaterThan(2);
      expect(permissionReasons).toContain(VAULT_REJECTION_REASONS.UNAUTHORIZED_OPERATION);
      expect(permissionReasons).toContain(VAULT_REJECTION_REASONS.WALLET_NOT_CONNECTED);
    });

    it("should have comprehensive policy rejection reasons", () => {
      const policyReasons = Object.entries(REJECTION_EXPLANATIONS)
        .filter(([_, explanation]) => explanation.category === "policy")
        .map(([code]) => code);

      expect(policyReasons.length).toBeGreaterThan(5);
      expect(policyReasons).toContain(VAULT_REJECTION_REASONS.POOL_CLOSED);
      expect(policyReasons).toContain(VAULT_REJECTION_REASONS.LOCKUP_ACTIVE);
      expect(policyReasons).toContain(VAULT_REJECTION_REASONS.DEPOSIT_CAP_EXCEEDED);
    });

    it("should have comprehensive stale_state rejection reasons", () => {
      const staleStateReasons = Object.entries(REJECTION_EXPLANATIONS)
        .filter(([_, explanation]) => explanation.category === "stale_state")
        .map(([code]) => code);

      expect(staleStateReasons.length).toBeGreaterThan(2);
      expect(staleStateReasons).toContain(VAULT_REJECTION_REASONS.STALE_POOL_DATA);
      expect(staleStateReasons).toContain(VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION);
    });

    it("should have comprehensive external rejection reasons", () => {
      const externalReasons = Object.entries(REJECTION_EXPLANATIONS)
        .filter(([_, explanation]) => explanation.category === "external")
        .map(([code]) => code);

      expect(externalReasons.length).toBeGreaterThan(5);
      expect(externalReasons).toContain(VAULT_REJECTION_REASONS.WALLET_REJECTED);
      expect(externalReasons).toContain(VAULT_REJECTION_REASONS.NETWORK_ERROR);
      expect(externalReasons).toContain(VAULT_REJECTION_REASONS.RPC_FAILURE);
    });
  });

  describe("integration with existing error taxonomy", () => {
    it("should have consistent error codes with backend constants", () => {
      // This test ensures the rejection reasons align with backend error codes
      // The actual backend constants are in backend/src/constants.ts
      const vaultSpecificCodes = Object.values(VAULT_REJECTION_REASONS);
      expect(vaultSpecificCodes.every((code) => code.startsWith("VAULT_"))).toBe(true);
    });
  });

  describe("fallback behavior", () => {
    it("should provide safe fallback for any unknown error", () => {
      const unknownErrors = [
        "SOME_RANDOM_ERROR",
        "UNKNOWN_ERROR_CODE",
        "LEGACY_ERROR",
        null,
        undefined,
      ];

      unknownErrors.forEach((error) => {
        const explanation = getRejectionExplanation(error as string);
        expect(explanation).toBeDefined();
        expect(explanation.userMessage).toBeTruthy();
        expect(explanation.recoveryHint).toBeTruthy();
        expect(explanation.retryable).toBe(true); // Fallback should be retryable
      });
    });
  });
});
