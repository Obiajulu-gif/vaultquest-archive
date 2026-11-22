/**
 * Tests for optimistic concurrency control
 *
 * Verifies:
 * - Version token creation and validation
 * - Conflict detection for stale data
 * - Retry logic for conflict resolution
 * - Integration with rejection reasons
 */

import { describe, it, expect, vi } from "vitest";
import {
  isVersionValid,
  createVersionToken,
  createConflictError,
  executeWithVersionCheck,
  executeWithRetryOnConflict,
  extractVersionToken,
  formatVersionToken,
  type VersionToken,
  type VersionCheckedResult,
} from "./concurrencyControl";
import { VAULT_REJECTION_REASONS } from "./rejectionReasons";

describe("concurrencyControl", () => {
  describe("createVersionToken", () => {
    it("should create a version token from timestamp", () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      expect(token.entityId).toBe("pool-123");
      expect(token.entityType).toBe("saved_pool");
      expect(token.version).toBe(1234567890);
      expect(token.sequence).toBeUndefined();
    });

    it("should handle string timestamps", () => {
      const token = createVersionToken("pool-123", "saved_pool", "2024-01-01T00:00:00Z");
      expect(token.version).toBeGreaterThan(0);
    });

    it("should include sequence number when provided", () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890, 5);
      expect(token.sequence).toBe(5);
    });
  });

  describe("isVersionValid", () => {
    it("should return true for matching versions", () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      expect(isVersionValid(token, token)).toBe(true);
    });

    it("should return false for different entity IDs", () => {
      const token1 = createVersionToken("pool-123", "saved_pool", 1234567890);
      const token2 = createVersionToken("pool-456", "saved_pool", 1234567890);
      expect(isVersionValid(token1, token2)).toBe(false);
    });

    it("should return false for different entity types", () => {
      const token1 = createVersionToken("pool-123", "saved_pool", 1234567890);
      const token2 = createVersionToken("pool-123", "user_position", 1234567890);
      expect(isVersionValid(token1, token2)).toBe(false);
    });

    it("should return false for different versions", () => {
      const token1 = createVersionToken("pool-123", "saved_pool", 1234567890);
      const token2 = createVersionToken("pool-123", "saved_pool", 1234567891);
      expect(isVersionValid(token1, token2)).toBe(false);
    });

    it("should return false for different sequence numbers", () => {
      const token1 = createVersionToken("pool-123", "saved_pool", 1234567890, 1);
      const token2 = createVersionToken("pool-123", "saved_pool", 1234567890, 2);
      expect(isVersionValid(token1, token2)).toBe(false);
    });

    it("should return false when either version is null", () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      expect(isVersionValid(token, null)).toBe(false);
      expect(isVersionValid(null, token)).toBe(false);
      expect(isVersionValid(null, null)).toBe(false);
    });

    it("should return false when either version is undefined", () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      expect(isVersionValid(token, undefined)).toBe(false);
      expect(isVersionValid(undefined, token)).toBe(false);
    });
  });

  describe("createConflictError", () => {
    it("should create a conflict error with user-safe message", () => {
      const expected = createVersionToken("pool-123", "saved_pool", 1234567890);
      const actual = createVersionToken("pool-123", "saved_pool", 1234567891);
      const conflict = createConflictError("saved_pool", expected, actual);

      expect(conflict.reasonCode).toBe(VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION);
      expect(conflict.userMessage).toBeTruthy();
      expect(conflict.recoveryHint).toBeTruthy();
      expect(conflict.expectedVersion).toEqual(expected);
      expect(conflict.actualVersion).toEqual(actual);
      expect(conflict.retryable).toBe(true);
    });
  });

  describe("executeWithVersionCheck", () => {
    it("should execute operation when versions match", async () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      const operation = vi.fn().mockResolvedValue({ success: true });

      const result = await executeWithVersionCheck(operation, token, token);

      expect(result.success).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should return conflict error when versions don't match", async () => {
      const expected = createVersionToken("pool-123", "saved_pool", 1234567890);
      const actual = createVersionToken("pool-123", "saved_pool", 1234567891);
      const operation = vi.fn().mockResolvedValue({ success: true });

      const result = await executeWithVersionCheck(operation, actual, expected);

      expect(result.success).toBe(false);
      expect(result.conflict).toBeDefined();
      expect(operation).not.toHaveBeenCalled();
    });

    it("should propagate non-conflict errors", async () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      const operation = vi.fn().mockRejectedValue(new Error("Network error"));

      await expect(executeWithVersionCheck(operation, token, token)).rejects.toThrow("Network error");
    });
  });

  describe("executeWithRetryOnConflict", () => {
    it("should succeed on first attempt", async () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      const getVersion = vi.fn().mockResolvedValue(token);
      const operation = vi.fn().mockResolvedValue({ success: true });

      const result = await executeWithRetryOnConflict(operation, getVersion, 2);

      expect(result.success).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(getVersion).toHaveBeenCalledTimes(1);
    });

    it("should retry on conflict and succeed", async () => {
      const token1 = createVersionToken("pool-123", "saved_pool", 1234567890);
      const token2 = createVersionToken("pool-123", "saved_pool", 1234567891);
      const getVersion = vi.fn()
        .mockResolvedValueOnce(token1)
        .mockResolvedValueOnce(token2);
      const operation = vi.fn()
        .mockRejectedValueOnce({ conflict: createConflictError("saved_pool", token1, token2) })
        .mockResolvedValueOnce({ success: true });

      const result = await executeWithRetryOnConflict(operation, getVersion, 2);

      expect(result.success).toBe(true);
      expect(operation).toHaveBeenCalledTimes(2);
      expect(getVersion).toHaveBeenCalledTimes(2);
    });

    it("should return conflict error after max retries", async () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      const getVersion = vi.fn().mockResolvedValue(token);
      const conflict = createConflictError("saved_pool", token, token);
      const operation = vi.fn().mockRejectedValue({ conflict });

      const result = await executeWithRetryOnConflict(operation, getVersion, 2);

      expect(result.success).toBe(false);
      expect(result.conflict).toBeDefined();
      expect(operation).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("should proceed without version check when getVersion returns null", async () => {
      const getVersion = vi.fn().mockResolvedValue(null);
      const operation = vi.fn().mockResolvedValue({ success: true });

      const result = await executeWithRetryOnConflict(operation, getVersion, 2);

      expect(result.success).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe("extractVersionToken", () => {
    it("should extract version from updated_at field", () => {
      const data = { updated_at: "2024-01-01T00:00:00Z" };
      const token = extractVersionToken(data, "pool-123", "saved_pool");

      expect(token).toBeDefined();
      expect(token?.entityId).toBe("pool-123");
      expect(token?.entityType).toBe("saved_pool");
      expect(token?.version).toBeGreaterThan(0);
    });

    it("should extract version from updatedAt field", () => {
      const data = { updatedAt: 1234567890 };
      const token = extractVersionToken(data, "pool-123", "saved_pool");

      expect(token).toBeDefined();
      expect(token?.version).toBe(1234567890);
    });

    it("should include sequence number if present", () => {
      const data = { updated_at: "2024-01-01T00:00:00Z", version: 5 };
      const token = extractVersionToken(data, "pool-123", "saved_pool");

      expect(token?.sequence).toBe(5);
    });

    it("should return null when data is null", () => {
      const token = extractVersionToken(null, "pool-123", "saved_pool");
      expect(token).toBeNull();
    });

    it("should return null when data is undefined", () => {
      const token = extractVersionToken(undefined, "pool-123", "saved_pool");
      expect(token).toBeNull();
    });

    it("should return null when no version field exists", () => {
      const data = { name: "test" };
      const token = extractVersionToken(data, "pool-123", "saved_pool");
      expect(token).toBeNull();
    });
  });

  describe("formatVersionToken", () => {
    it("should format version token without sequence", () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890);
      const formatted = formatVersionToken(token);

      expect(formatted).toBe("saved_pool:pool-123@1234567890");
    });

    it("should format version token with sequence", () => {
      const token = createVersionToken("pool-123", "saved_pool", 1234567890, 5);
      const formatted = formatVersionToken(token);

      expect(formatted).toBe("saved_pool:pool-123@1234567890:5");
    });
  });

  describe("integration with rejection reasons", () => {
    it("should use concurrent modification rejection reason", () => {
      const expected = createVersionToken("pool-123", "saved_pool", 1234567890);
      const actual = createVersionToken("pool-123", "saved_pool", 1234567891);
      const conflict = createConflictError("saved_pool", expected, actual);

      expect(conflict.reasonCode).toBe(VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION);
      expect(conflict.userMessage).toContain("modified");
      expect(conflict.recoveryHint).toContain("refresh");
    });
  });

  describe("concurrent edit scenarios", () => {
    it("should detect conflict when data changed between read and write", async () => {
      const readVersion = createVersionToken("pool-123", "saved_pool", 1234567890);
      const writeVersion = createVersionToken("pool-123", "saved_pool", 1234567891);
      const operation = vi.fn().mockResolvedValue({ success: true });

      const result = await executeWithVersionCheck(operation, writeVersion, readVersion);

      expect(result.success).toBe(false);
      expect(result.conflict).toBeDefined();
      expect(operation).not.toHaveBeenCalled();
    });

    it("should allow write when data unchanged", async () => {
      const version = createVersionToken("pool-123", "saved_pool", 1234567890);
      const operation = vi.fn().mockResolvedValue({ success: true });

      const result = await executeWithVersionCheck(operation, version, version);

      expect(result.success).toBe(true);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it("should handle multiple concurrent edits with retry", async () => {
      const versions = [
        createVersionToken("pool-123", "saved_pool", 1234567890),
        createVersionToken("pool-123", "saved_pool", 1234567891),
        createVersionToken("pool-123", "saved_pool", 1234567892),
      ];
      const getVersion = vi.fn()
        .mockResolvedValueOnce(versions[0])
        .mockResolvedValueOnce(versions[1])
        .mockResolvedValueOnce(versions[2]);
      const operation = vi.fn()
        .mockRejectedValueOnce({ conflict: createConflictError("saved_pool", versions[0], versions[1]) })
        .mockRejectedValueOnce({ conflict: createConflictError("saved_pool", versions[1], versions[2]) })
        .mockResolvedValueOnce({ success: true });

      const result = await executeWithRetryOnConflict(operation, getVersion, 3);

      expect(result.success).toBe(true);
      expect(operation).toHaveBeenCalledTimes(3);
    });
  });
});
