/**
 * Tests for backend integration of VaultQuest rejection reasons
 *
 * This test suite verifies:
 * - Backend error codes include VaultQuest-specific rejection reasons
 * - Error taxonomy properly categorizes VaultQuest rejections
 * - Error handler properly surfaces rejection explanations
 */

import { describe, it, expect } from "vitest";
import { ERROR_CODES } from "../src/constants.js";
import { ERROR_CATALOG, describeError, toUserSafeError } from "../src/errorTaxonomy.js";

describe("backend rejection reasons integration", () => {
  describe("ERROR_CODES includes VaultQuest reasons", () => {
    it("should include all VaultQuest rejection reasons", () => {
      const vaultSpecificCodes = [
        "VAULT_INVALID_AMOUNT",
        "VAULT_INVALID_POOL_ID",
        "VAULT_INVALID_WALLET_ADDRESS",
        "VAULT_INVALID_ASSET",
        "VAULT_INVALID_TIMESTAMP",
        "VAULT_UNAUTHORIZED_OPERATION",
        "VAULT_FORBIDDEN_OPERATION",
        "VAULT_WALLET_NOT_CONNECTED",
        "VAULT_SIGNATURE_REQUIRED",
        "VAULT_POOL_CLOSED",
        "VAULT_POOL_LOCKED",
        "VAULT_POOL_CANCELLED",
        "VAULT_POOL_EMERGENCY",
        "VAULT_DEPOSIT_CAP_EXCEEDED",
        "VAULT_POOL_CAP_EXCEEDED",
        "VAULT_LOCKUP_ACTIVE",
        "VAULT_CLAIM_DEADLINE_PASSED",
        "VAULT_INSUFFICIENT_LIQUIDITY",
        "VAULT_INSUFFICIENT_BALANCE",
        "VAULT_ALREADY_CLAIMED",
        "VAULT_NOT_PARTICIPANT",
        "VAULT_INSUFFICIENT_YIELD_RESERVE",
        "VAULT_INVALID_ACTION_STATE",
        "VAULT_STALE_POOL_DATA",
        "VAULT_STALE_POSITION_DATA",
        "VAULT_CONCURRENT_MODIFICATION",
        "VAULT_VERSION_MISMATCH",
        "VAULT_WALLET_REJECTED",
        "VAULT_WALLET_TIMEOUT",
        "VAULT_NETWORK_ERROR",
        "VAULT_RPC_FAILURE",
        "VAULT_CONTRACT_REVERTED",
        "VAULT_TRANSACTION_TIMEOUT",
        "VAULT_INDEXER_UNAVAILABLE",
      ];

      vaultSpecificCodes.forEach((code) => {
        expect(ERROR_CODES[code as keyof typeof ERROR_CODES]).toBeDefined();
      });
    });
  });

  describe("ERROR_CATALOG includes VaultQuest explanations", () => {
    it("should have catalog entries for all VaultQuest rejection reasons", () => {
      const vaultSpecificCodes = [
        "VAULT_INVALID_AMOUNT",
        "VAULT_INVALID_POOL_ID",
        "VAULT_INVALID_WALLET_ADDRESS",
        "VAULT_INVALID_ASSET",
        "VAULT_INVALID_TIMESTAMP",
        "VAULT_UNAUTHORIZED_OPERATION",
        "VAULT_FORBIDDEN_OPERATION",
        "VAULT_WALLET_NOT_CONNECTED",
        "VAULT_SIGNATURE_REQUIRED",
        "VAULT_POOL_CLOSED",
        "VAULT_POOL_LOCKED",
        "VAULT_POOL_CANCELLED",
        "VAULT_POOL_EMERGENCY",
        "VAULT_DEPOSIT_CAP_EXCEEDED",
        "VAULT_POOL_CAP_EXCEEDED",
        "VAULT_LOCKUP_ACTIVE",
        "VAULT_CLAIM_DEADLINE_PASSED",
        "VAULT_INSUFFICIENT_LIQUIDITY",
        "VAULT_INSUFFICIENT_BALANCE",
        "VAULT_ALREADY_CLAIMED",
        "VAULT_NOT_PARTICIPANT",
        "VAULT_INSUFFICIENT_YIELD_RESERVE",
        "VAULT_INVALID_ACTION_STATE",
        "VAULT_STALE_POOL_DATA",
        "VAULT_STALE_POSITION_DATA",
        "VAULT_CONCURRENT_MODIFICATION",
        "VAULT_VERSION_MISMATCH",
        "VAULT_WALLET_REJECTED",
        "VAULT_WALLET_TIMEOUT",
        "VAULT_NETWORK_ERROR",
        "VAULT_RPC_FAILURE",
        "VAULT_CONTRACT_REVERTED",
        "VAULT_TRANSACTION_TIMEOUT",
        "VAULT_INDEXER_UNAVAILABLE",
      ];

      vaultSpecificCodes.forEach((code) => {
        const errorCode = ERROR_CODES[code as keyof typeof ERROR_CODES];
        expect(ERROR_CATALOG[errorCode]).toBeDefined();
        expect(ERROR_CATALOG[errorCode].userMessage).toBeTruthy();
        expect(ERROR_CATALOG[errorCode].recovery).toBeTruthy();
      });
    });

    it("should have correct categories for VaultQuest rejections", () => {
      // Validation errors
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_INVALID_AMOUNT].category).toBe("validation");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_INVALID_POOL_ID].category).toBe("validation");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_POOL_CLOSED].category).toBe("validation");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_POOL_LOCKED].category).toBe("validation");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_LOCKUP_ACTIVE].category).toBe("validation");

      // Permission errors
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_UNAUTHORIZED_OPERATION].category).toBe("authorization");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_FORBIDDEN_OPERATION].category).toBe("authorization");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_WALLET_NOT_CONNECTED].category).toBe("authorization");

      // Dependency errors (stale state)
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_STALE_POOL_DATA].category).toBe("dependency");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_STALE_POSITION_DATA].category).toBe("dependency");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_CONCURRENT_MODIFICATION].category).toBe("dependency");

      // Wallet errors
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_WALLET_REJECTED].category).toBe("wallet");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_WALLET_TIMEOUT].category).toBe("wallet");

      // Settlement errors
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_CONTRACT_REVERTED].category).toBe("settlement");
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_TRANSACTION_TIMEOUT].category).toBe("settlement");
    });

    it("should have correct retryable flags for VaultQuest rejections", () => {
      // External/dependency errors should be retryable
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_STALE_POOL_DATA].retryable).toBe(true);
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_NETWORK_ERROR].retryable).toBe(true);
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_RPC_FAILURE].retryable).toBe(true);
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_WALLET_REJECTED].retryable).toBe(true);
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_WALLET_TIMEOUT].retryable).toBe(true);

      // Validation errors should not be retryable
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_INVALID_AMOUNT].retryable).toBe(false);
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_INVALID_POOL_ID].retryable).toBe(false);
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_LOCKUP_ACTIVE].retryable).toBe(false);
      expect(ERROR_CATALOG[ERROR_CODES.VAULT_POOL_CLOSED].retryable).toBe(false);
    });
  });

  describe("toUserSafeError integration", () => {
    it("should return user-safe error for VaultQuest rejection reasons", () => {
      const userError = toUserSafeError(
        ERROR_CODES.VAULT_INVALID_AMOUNT,
        400,
        "Amount must be positive"
      );

      expect(userError.code).toBe(ERROR_CODES.VAULT_INVALID_AMOUNT);
      expect(userError.category).toBe("validation");
      expect(userError.retryable).toBe(false);
      expect(userError.message).toBeTruthy();
      expect(userError.recovery).toBeTruthy();
    });

    it("should use catalog message for non-exposable VaultQuest errors", () => {
      const userError = toUserSafeError(
        ERROR_CODES.VAULT_NETWORK_ERROR,
        500,
        "Internal RPC failure details"
      );

      expect(userError.code).toBe(ERROR_CODES.VAULT_NETWORK_ERROR);
      expect(userError.category).toBe("dependency");
      expect(userError.retryable).toBe(true);
      // Should use catalog message, not the provided internal message
      expect(userError.message).toBe(ERROR_CATALOG[ERROR_CODES.VAULT_NETWORK_ERROR].userMessage);
    });

    it("should handle unknown VaultQuest error codes with fallback", () => {
      const userError = toUserSafeError("VAULT_UNKNOWN_ERROR", 500, "Unknown error");

      expect(userError.code).toBe("VAULT_UNKNOWN_ERROR");
      expect(userError.category).toBe("validation"); // Fallback for 4xx
      expect(userError.message).toBeTruthy();
    });
  });

  describe("describeError integration", () => {
    it("should return descriptor for known VaultQuest error codes", () => {
      const descriptor = describeError(ERROR_CODES.VAULT_LOCKUP_ACTIVE);

      expect(descriptor).toBeDefined();
      expect(descriptor.category).toBe("validation");
      expect(descriptor.userMessage).toBeTruthy();
      expect(descriptor.recovery).toBeTruthy();
      expect(descriptor.retryable).toBe(false);
    });

    it("should return fallback for unknown VaultQuest error codes", () => {
      const descriptor = describeError("VAULT_UNKNOWN_ERROR");

      expect(descriptor).toBeDefined();
      expect(descriptor.category).toBe("internal"); // Fallback category
      expect(descriptor.userMessage).toBeTruthy();
    });
  });
});
