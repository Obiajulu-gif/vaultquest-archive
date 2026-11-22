/**
 * Chaos tests for vault deposit workflow (Issue #1).
 * 
 * Tests deposit flow under network failures, process restarts, stale reads,
 * and retry storms. Verifies idempotency and eventual consistency.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import { LedgerService } from "../../src/services/ledger.js";
import { CacheService } from "../../src/services/cacheService.js";
import { createTestPrisma } from "../helpers/db.js";
import { runChaosTest, VAULT_CHAOS_SCENARIOS, ProcessRestartError } from "./chaos-framework.js";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";
import type { PrismaClient } from "@prisma/client";
import type { ChaosCoordinator } from "./chaos-framework.js";

describe("Deposit Chaos Tests", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let cache: CacheService;

  beforeEach(async () => {
    prisma = await createTestPrisma();
    cache = new CacheService(prisma, null);
    ledger = new LedgerService(prisma, cache);
  });

  it("deposit survives network timeout with retry", async () => {
    const scenario = VAULT_CHAOS_SCENARIOS.find(
      (s) => s.name === "deposit_with_network_timeout_then_success"
    )!;

    const walletAddress = "GCHAOSTESTADDR1";
    const idempotencyKey = `chaos-deposit-${Date.now()}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read checkpoint (no fault)
        await coordinator.beforeOperation("read_checkpoint");
        const existing = await ledger.getAction(idempotencyKey);

        if (existing) {
          return existing;
        }

        // Op 2: Create action (network_timeout fault)
        await coordinator.beforeOperation("create_action");
        try {
          return await ledger.createAction({
            idempotencyKey,
            walletAddress,
            actionType: "deposit",
            actionPayload: { amount: "1000", poolId: "test-pool" },
          });
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) {
            // Retry after fault
            await coordinator.beforeOperation("retry_create_action");
            return await ledger.createAction({
              idempotencyKey,
              walletAddress,
              actionType: "deposit",
              actionPayload: { amount: "1000", poolId: "test-pool" },
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(result?.status).toBe("pending");
        expect(result?.idempotencyKey).toBe(idempotencyKey);
        expect(faults).toHaveLength(1);
        expect(faults[0].type).toBe("network_timeout");

        // Verify exactly one action was created
        const actions = await prisma.actionLedger.findMany({
          where: { idempotencyKey },
        });
        expect(actions).toHaveLength(1);
      }
    );
  });

  it("deposit survives process restart mid-flow", async () => {
    const scenario = VAULT_CHAOS_SCENARIOS.find(
      (s) => s.name === "deposit_with_process_restart_mid_submission"
    )!;

    const walletAddress = "GCHAOSTESTADDR2";
    const idempotencyKey = `chaos-deposit-restart-${Date.now()}`;

    // Pre-create action in pending state
    await ledger.createAction({
      idempotencyKey,
      walletAddress,
      actionType: "deposit",
      actionPayload: { amount: "2000", poolId: "test-pool" },
    });

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read existing action
        await coordinator.beforeOperation("read_action");
        const action = await ledger.getAction(idempotencyKey);
        expect(action).toBeDefined();

        // Op 2: Mark checkpoint (no fault)
        await coordinator.beforeOperation("mark_checkpoint");
        await ledger.markCheckpoint({
          id: action!.id,
          checkpoint: { stage: "external_action_started" },
        });

        // Op 3: Attach txHash (process_restart fault)
        await coordinator.beforeOperation("attach_tx_hash");
        return await ledger.attachTxHash({
          id: action!.id,
          txHash: `chaos-tx-${Date.now()}`,
          submittedAt: new Date(),
        });
      },
      async (result, faults) => {
        // After restart, resume should succeed
        const action = await ledger.getAction(idempotencyKey);
        expect(action).toBeDefined();
        expect(action?.status).toBe("submitted");
        expect(action?.txHash).toBeDefined();
        expect(faults).toHaveLength(1);
        expect(faults[0].type).toBe("process_restart");
      }
    );
  });

  it("deposit handles stale read with optimistic retry", async () => {
    const scenario = VAULT_CHAOS_SCENARIOS.find(
      (s) => s.name === "deposit_with_stale_read_then_conflict"
    )!;

    const walletAddress = "GCHAOSTESTADDR3";
    const idempotencyKey = `chaos-deposit-stale-${Date.now()}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Stale read (fault injects old data)
        await coordinator.beforeOperation("read_action_stale");
        let action = await ledger.getAction(idempotencyKey);
        action = coordinator.interceptRead(action);

        if (!action) {
          // Op 2: Create action
          await coordinator.beforeOperation("create_action");
          action = await ledger.createAction({
            idempotencyKey,
            walletAddress,
            actionType: "deposit",
            actionPayload: { amount: "3000", poolId: "test-pool" },
          });
        }

        // Op 3: Another read to verify
        await coordinator.beforeOperation("verify_read");
        const fresh = await ledger.getAction(idempotencyKey);

        // Op 4: Update with CAS (transaction_conflict fault expected)
        await coordinator.beforeOperation("update_with_cas");
        try {
          await ledger.markCheckpoint({
            id: action.id,
            checkpoint: { stage: "wallet_approval_requested" },
          });
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.CONFLICT) {
            // Retry with fresh read
            await coordinator.beforeOperation("retry_after_conflict");
            const current = await ledger.getAction(idempotencyKey);
            await ledger.markCheckpoint({
              id: current!.id,
              checkpoint: { stage: "wallet_approval_requested" },
            });
          } else {
            throw err;
          }
        }

        return await ledger.getAction(idempotencyKey);
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(result?.recoveryCheckpoint).toEqual({ stage: "wallet_approval_requested" });
        expect(faults.length).toBeGreaterThanOrEqual(1);
        expect(faults.some((f) => f.type === "stale_read")).toBe(true);
      }
    );
  });

  it("deposit with retry storm never creates duplicates", async () => {
    const scenario = VAULT_CHAOS_SCENARIOS.find(
      (s) => s.name === "withdraw_with_multiple_retries"
    )!;

    const walletAddress = "GCHAOSTESTADDR4";
    const idempotencyKey = `chaos-deposit-retries-${Date.now()}`;

    let attemptCount = 0;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        const createActionWithRetry = async (): Promise<any> => {
          attemptCount++;
          await coordinator.beforeOperation(`create_attempt_${attemptCount}`);

          try {
            return await ledger.createAction({
              idempotencyKey,
              walletAddress,
              actionType: "deposit",
              actionPayload: { amount: "4000", poolId: "test-pool" },
            });
          } catch (err) {
            if (
              (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) ||
              (err instanceof AppError && err.code === ERROR_CODES.CONFLICT)
            ) {
              if (attemptCount < 6) {
                return createActionWithRetry();
              }
              throw err;
            }
            throw err;
          }
        };

        return createActionWithRetry();
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(attemptCount).toBeGreaterThan(1); // Retries happened

        // Verify exactly one action exists
        const actions = await prisma.actionLedger.findMany({
          where: { idempotencyKey },
        });
        expect(actions).toHaveLength(1);
        expect(actions[0].walletAddress).toBe(walletAddress);
      }
    );
  });
});
