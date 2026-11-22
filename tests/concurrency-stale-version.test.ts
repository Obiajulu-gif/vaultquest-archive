/**
 * Concurrency tests for duplicate submissions and stale versions (#966).
 *
 * Verifies client/library optimistic concurrency control:
 * - Normal path: mutations with valid version tokens succeed
 * - Failure path: stale version tokens yield actionable conflict errors
 * - Retry path: automated retries with fresh version tokens resolve conflicts
 * - Authorization path: entity type and id isolation prevents cross-entity mutation
 */

import { describe, it, expect, vi } from "vitest";
import {
  createVersionToken,
  isVersionValid,
  createConflictError,
  executeWithVersionCheck,
  executeWithRetryOnConflict,
  extractVersionToken,
  formatVersionToken,
  type VersionToken,
} from "../lib/concurrencyControl";
import { VAULT_REJECTION_REASONS } from "../lib/rejectionReasons";

describe("concurrencyControl - Client Optimistic Concurrency (#966)", () => {
  it("normal path: executes mutation when version tokens match", async () => {
    const token = createVersionToken("pool-1", "saved_pool", 1000, 1);
    const operation = vi.fn().mockResolvedValue({ poolId: "pool-1", name: "Updated Pool" });

    const result = await executeWithVersionCheck(operation, token, token);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("Updated Pool");
    }
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("failure path: returns conflict error when expected version is stale", async () => {
    const staleExpected = createVersionToken("pool-1", "saved_pool", 1000, 1);
    const serverActual = createVersionToken("pool-1", "saved_pool", 1010, 2);
    const operation = vi.fn().mockResolvedValue({ success: true });

    const result = await executeWithVersionCheck(operation, serverActual, staleExpected);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.conflict.reasonCode).toBe(VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION);
      expect(result.conflict.expectedVersion).toEqual(staleExpected);
      expect(result.conflict.actualVersion).toEqual(serverActual);
      expect(result.conflict.retryable).toBe(true);
      expect(result.conflict.userMessage).toBeTruthy();
      expect(result.conflict.recoveryHint).toBeTruthy();
    }
    expect(operation).not.toHaveBeenCalled();
  });

  it("retry path: automatically re-fetches authoritative version and retries to completion", async () => {
    const v1 = createVersionToken("pool-1", "saved_pool", 1000, 1);
    const v2 = createVersionToken("pool-1", "saved_pool", 1010, 2);

    const getVersion = vi.fn()
      .mockResolvedValueOnce(v1)
      .mockResolvedValueOnce(v2);

    const operation = vi.fn()
      .mockRejectedValueOnce({ conflict: createConflictError("saved_pool", v1, v2) })
      .mockResolvedValueOnce({ id: "pool-1", updated: true, sequence: 2 });

    const result = await executeWithRetryOnConflict(operation, getVersion, 2);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.updated).toBe(true);
      expect(result.data.sequence).toBe(2);
    }
    expect(operation).toHaveBeenCalledTimes(2);
    expect(getVersion).toHaveBeenCalledTimes(2);
  });

  it("authorization & entity isolation: version tokens for different entities cannot validate", () => {
    const tokenAlice = createVersionToken("pool-alice", "saved_pool", 1000, 1);
    const tokenBob = createVersionToken("pool-bob", "saved_pool", 1000, 1);
    const tokenPosition = createVersionToken("pool-alice", "user_position", 1000, 1);

    expect(isVersionValid(tokenAlice, tokenBob)).toBe(false);
    expect(isVersionValid(tokenAlice, tokenPosition)).toBe(false);
    expect(isVersionValid(tokenAlice, null)).toBe(false);
    expect(isVersionValid(null, tokenAlice)).toBe(false);
  });

  it("parallel race: multiple concurrent callers resolve through version checks", async () => {
    let currentSequence = 1;
    let currentVersion = 1000;

    const commitMutation = async (expected: VersionToken, callerId: string) => {
      const serverToken = createVersionToken("pool-race", "saved_pool", currentVersion, currentSequence);
      if (!isVersionValid(serverToken, expected)) {
        return {
          success: false,
          conflict: createConflictError("saved_pool", expected, serverToken),
        };
      }
      currentSequence += 1;
      currentVersion += 5;
      return { success: true, data: { winner: callerId, sequence: currentSequence } };
    };

    const initialToken = createVersionToken("pool-race", "saved_pool", 1000, 1);

    // Three concurrent callers race using the initial token
    const results = await Promise.all([
      commitMutation(initialToken, "caller-1"),
      commitMutation(initialToken, "caller-2"),
      commitMutation(initialToken, "caller-3"),
    ]);

    const successes = results.filter((r) => r.success);
    const conflicts = results.filter((r) => !r.success);

    // Exactly one caller wins with initial token
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(2);
    expect(currentSequence).toBe(2);
  });
});
