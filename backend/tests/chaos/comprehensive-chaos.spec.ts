/**
 * Comprehensive chaos testing suite for Issue #1.
 * 
 * Tests deterministic fault injection across vault deposits, prize rounds,
 * quests, wallet flows, and indexer reconciliation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import {
  runChaosTest,
  ChaosCoordinator,
  VAULT_CHAOS_SCENARIOS,
  ProcessRestartError,
} from "./chaos-framework.js";
import { LedgerService } from "../../src/services/ledger.js";
import { QuestService } from "../../src/services/questService.js";
import { ERROR_CODES } from "../../src/constants.js";
import { AppError } from "../../src/errors.js";

describe("Comprehensive Chaos Testing Suite", () => {
  let prisma: PrismaClient;
  let ledgerService: LedgerService;
  let questService: QuestService;

  beforeEach(async () => {
    const db = await setupTestDatabase();
    prisma = db.prisma;
    ledgerService = new LedgerService(prisma);
    questService = new QuestService(prisma);
  });

  afterEach(async () => {
    await teardownTestDatabase(prisma);
  });

  describe("Vault Deposit Chaos Tests", () => {
    it("should recover from network timeout during deposit creation", async () => {
      const scenario = VAULT_CHAOS_SCENARIOS[0]; // deposit_with_network_timeout_then_success
      const idempotencyKey = `deposit-${Date.now()}`;

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("read_checkpoint");
          
          // Check for existing action (idempotent retry)
          const existing = await prisma.actionLedger.findUnique({
            where: { idempotencyKey },
          });
          if (existing) return existing;

          await coordinator.beforeOperation("create_action");
          
          // This will throw network timeout on operation 2
          try {
            return await ledgerService.createAction({
              idempotencyKey,
              walletAddress: "GTEST123",
              actionType: "deposit",
              actionPayload: { poolId: "pool-1", amount: "1000" },
            });
          } catch (err) {
            if (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) {
              // Retry with same idempotency key
              await coordinator.beforeOperation("retry_create_action");
              return await ledgerService.createAction({
                idempotencyKey,
                walletAddress: "GTEST123",
                actionType: "deposit",
                actionPayload: { poolId: "pool-1", amount: "1000" },
              });
            }
            throw err;
          }
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          expect(result?.idempotencyKey).toBe(idempotencyKey);
          expect(faults).toHaveLength(1);
          expect(faults[0].type).toBe("network_timeout");

          // Verify exactly one action created
          const actions = await prisma.actionLedger.findMany({
            where: { idempotencyKey },
          });
          expect(actions).toHaveLength(1);
        }
      );
    });

    it("should resume from checkpoint after process restart mid-submission", async () => {
      const scenario = VAULT_CHAOS_SCENARIOS[1]; // deposit_with_process_restart_mid_submission
      const idempotencyKey = `deposit-restart-${Date.now()}`;

      // Create initial action with checkpoint
      await prisma.actionLedger.create({
        data: {
          idempotencyKey,
          walletAddress: "GTEST456",
          actionType: "deposit",
          actionPayload: { poolId: "pool-1", amount: "2000" },
          status: "pending",
          recoveryCheckpoint: {
            stage: "intent_recorded",
            timestamp: new Date().toISOString(),
          },
        },
      });

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("read_action");
          const action = await prisma.actionLedger.findUnique({
            where: { idempotencyKey },
          });

          await coordinator.beforeOperation("update_checkpoint");
          await prisma.actionLedger.update({
            where: { id: action!.id },
            data: {
              recoveryCheckpoint: {
                stage: "external_action_started",
                timestamp: new Date().toISOString(),
              },
            },
          });

          await coordinator.beforeOperation("submit_transaction");
          // Process restart injected here
          
          // After restart, resume from checkpoint
          const resumedAction = await prisma.actionLedger.findUnique({
            where: { idempotencyKey },
          });
          
          await coordinator.beforeOperation("resume_submission");
          return await prisma.actionLedger.update({
            where: { id: resumedAction!.id },
            data: {
              status: "submitted",
              txHash: "txhash-123",
              submittedAt: new Date(),
            },
          });
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          expect(result?.status).toBe("submitted");
          expect(faults).toHaveLength(1);
          expect(faults[0].type).toBe("process_restart");
        }
      );
    });

    it("should handle stale read with optimistic retry", async () => {
      const scenario = VAULT_CHAOS_SCENARIOS[2]; // deposit_with_stale_read_then_conflict
      const idempotencyKey = `deposit-stale-${Date.now()}`;

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("read_action");
          let action = await prisma.actionLedger.findFirst({
            where: { walletAddress: "GTEST789" },
          });
          
          // Inject stale data
          action = coordinator.interceptRead(action);

          await coordinator.beforeOperation("create_action_cas");
          
          // First attempt with stale data
          try {
            return await ledgerService.createAction({
              idempotencyKey,
              walletAddress: "GTEST789",
              actionType: "deposit",
              actionPayload: { poolId: "pool-1", amount: "3000" },
            });
          } catch (err) {
            if (err instanceof AppError && err.code === ERROR_CODES.CONFLICT) {
              // Retry with fresh read
              await coordinator.beforeOperation("fresh_read");
              const freshAction = await prisma.actionLedger.findFirst({
                where: { walletAddress: "GTEST789" },
              });

              await coordinator.beforeOperation("retry_create");
              return await ledgerService.createAction({
                idempotencyKey,
                walletAddress: "GTEST789",
                actionType: "deposit",
                actionPayload: { poolId: "pool-1", amount: "3000" },
              });
            }
            throw err;
          }
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          expect(faults.some(f => f.type === "stale_read")).toBe(true);
        }
      );
    });
  });

  describe("Prize Round Chaos Tests", () => {
    it("should handle concurrent winner selections with serialization conflicts", async () => {
      const scenario = {
        name: "prize_selection_with_conflicts",
        faults: [
          { type: "transaction_conflict" as const, atOperation: 2 },
          { type: "network_timeout" as const, atOperation: 4 },
        ],
        expectedOutcome: "success" as const,
      };

      const poolId = "pool-prize-1";
      await prisma.actionLedger.create({
        data: {
          idempotencyKey: "prize-setup",
          walletAddress: "GPOOL",
          actionType: "select_winner",
          actionPayload: { poolId },
          status: "pending",
        },
      });

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("read_pool_state");
          const existingSelection = await prisma.actionLedger.findFirst({
            where: {
              actionType: "select_winner",
              actionPayload: { path: ["poolId"], equals: poolId },
              status: "confirmed",
            },
          });

          if (existingSelection) return existingSelection;

          await coordinator.beforeOperation("select_winner_cas");
          
          try {
            return await ledgerService.createAction({
              idempotencyKey: `winner-${poolId}-${Date.now()}`,
              walletAddress: "GSYSTEM",
              actionType: "select_winner",
              actionPayload: { poolId, winner: "GWINNER123" },
            });
          } catch (err) {
            if (err instanceof AppError && err.code === ERROR_CODES.CONFLICT) {
              await coordinator.beforeOperation("retry_after_conflict");
              return await ledgerService.createAction({
                idempotencyKey: `winner-${poolId}-${Date.now()}`,
                walletAddress: "GSYSTEM",
                actionType: "select_winner",
                actionPayload: { poolId, winner: "GWINNER123" },
              });
            }
            throw err;
          }
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          expect(faults).toHaveLength(2);
        }
      );
    });
  });

  describe("Quest Completion Chaos Tests", () => {
    it("should prevent duplicate reward grants under concurrent conflicts", async () => {
      const scenario = VAULT_CHAOS_SCENARIOS[4]; // quest_completion_with_concurrent_conflicts
      const walletAddress = "GQUEST123";
      const questId = "quest-1";
      const idempotencyKey = `${walletAddress}:${questId}`;

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("read_quest");
          const quest = await prisma.userQuest.findUnique({
            where: { walletAddress_questId: { walletAddress, questId } },
          });

          await coordinator.beforeOperation("check_grant_exists");
          const existingGrant = await prisma.rewardGrant.findUnique({
            where: { idempotencyKey },
          });

          if (existingGrant) return existingGrant;

          await coordinator.beforeOperation("create_grant");
          
          try {
            return await prisma.rewardGrant.create({
              data: {
                walletAddress,
                questId,
                idempotencyKey,
                status: "pending",
              },
            });
          } catch (err) {
            // Unique constraint violation = already granted
            if (err instanceof Error && err.message.includes("unique")) {
              await coordinator.beforeOperation("fetch_existing_grant");
              return await prisma.rewardGrant.findUnique({
                where: { idempotencyKey },
              });
            }
            throw err;
          }
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          
          // Verify exactly one grant exists
          const grants = await prisma.rewardGrant.findMany({
            where: { walletAddress, questId },
          });
          expect(grants).toHaveLength(1);
        }
      );
    });
  });

  describe("Indexer Reconciliation Chaos Tests", () => {
    it("should handle network failures during event ingestion", async () => {
      const scenario = {
        name: "indexer_ingestion_with_network_failures",
        faults: [
          { type: "network_timeout" as const, atOperation: 2, repeatCount: 2 },
          { type: "network_disconnect" as const, atOperation: 5 },
        ],
        expectedOutcome: "success" as const,
      };

      const txHash = "txhash-indexer-123";

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("read_checkpoint");
          const checkpoint = await prisma.indexerCheckpoint.findUnique({
            where: { id: "singleton" },
          });

          await coordinator.beforeOperation("ingest_event");
          
          let attempts = 0;
          const maxAttempts = 3;
          
          while (attempts < maxAttempts) {
            try {
              return await prisma.pendingEvent.upsert({
                where: { txHash },
                create: {
                  txHash,
                  sorobanEventId: "event-123",
                  eventPayload: { type: "deposit", amount: "1000" },
                  statusHint: "confirmed",
                },
                update: {},
              });
            } catch (err) {
              attempts++;
              if (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) {
                if (attempts >= maxAttempts) throw err;
                await coordinator.beforeOperation(`retry_ingest_${attempts}`);
                continue;
              }
              throw err;
            }
          }
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          expect(faults.length).toBeGreaterThan(0);
          
          // Verify event ingested exactly once
          const events = await prisma.pendingEvent.findMany({
            where: { txHash },
          });
          expect(events).toHaveLength(1);
        }
      );
    });

    it("should maintain idempotency under process restarts", async () => {
      const scenario = {
        name: "indexer_restart_idempotency",
        faults: [
          { type: "process_restart" as const, atOperation: 3 },
        ],
        expectedOutcome: "success" as const,
      };

      const sorobanEventId = "event-restart-456";

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("append_chain_event");
          
          // Append to chain event log (idempotent)
          await prisma.chainEvent.createMany({
            data: [{
              id: sorobanEventId,
              ledger: 1000,
              txHash: "txhash-456",
              contractId: "contract-1",
              topicXdr: [],
              valueXdr: "value-xdr",
              successful: true,
            }],
            skipDuplicates: true,
          });

          await coordinator.beforeOperation("reconcile_event");
          // Process restart here

          // After restart, continue reconciliation
          await coordinator.beforeOperation("resume_reconciliation");
          
          return await prisma.chainEvent.findUnique({
            where: { id: sorobanEventId },
          });
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          
          // Verify single event despite restart
          const events = await prisma.chainEvent.findMany({
            where: { id: sorobanEventId },
          });
          expect(events).toHaveLength(1);
        }
      );
    });
  });

  describe("Wallet Flow Chaos Tests", () => {
    it("should recover from wallet approval timeout with checkpoint resume", async () => {
      const scenario = {
        name: "wallet_approval_timeout",
        faults: [
          { type: "network_timeout" as const, atOperation: 3 },
          { type: "retry_exhausted" as const, atOperation: 6 },
        ],
        expectedOutcome: "manual_intervention" as const,
      };

      const idempotencyKey = `wallet-flow-${Date.now()}`;

      await runChaosTest(
        scenario,
        async (coordinator: ChaosCoordinator) => {
          await coordinator.beforeOperation("create_intent");
          const action = await ledgerService.createAction({
            idempotencyKey,
            walletAddress: "GWALLET123",
            actionType: "withdraw",
            actionPayload: { poolId: "pool-1", amount: "500" },
          });

          await coordinator.beforeOperation("update_checkpoint");
          await prisma.actionLedger.update({
            where: { id: action.id },
            data: {
              recoveryCheckpoint: {
                stage: "external_action_started",
                timestamp: new Date().toISOString(),
              },
            },
          });

          await coordinator.beforeOperation("wallet_approval");
          // Timeout here

          // Check recovery status
          await coordinator.beforeOperation("check_recovery");
          const recoveryAction = await prisma.actionLedger.findUnique({
            where: { id: action.id },
          });

          return recoveryAction;
        },
        async (result, faults) => {
          expect(result).toBeDefined();
          expect(result?.recoveryCheckpoint).toHaveProperty("stage");
          expect(faults.some(f => f.type === "network_timeout")).toBe(true);
        }
      );
    });
  });
});
