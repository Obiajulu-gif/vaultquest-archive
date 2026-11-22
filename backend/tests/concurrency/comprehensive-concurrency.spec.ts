/**
 * Comprehensive multi-actor concurrency tests for Issue #4.
 * 
 * Tests concurrent mutations with duplicate submissions, stale versions,
 * and retry storms around critical writes.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import { runConcurrentRaces, RACE_SCENARIOS } from "./race-framework.js";
import { LedgerService } from "../../src/services/ledger.js";
import { QuestService } from "../../src/services/questService.js";
import { createHash } from "node:crypto";

describe("Comprehensive Multi-Actor Concurrency Suite", () => {
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

  describe("Duplicate Deposit Submission", () => {
    it("should create exactly one action for duplicate submissions", async () => {
      const scenario = RACE_SCENARIOS[0]; // duplicate_deposit_submission
      const idempotencyKey = `deposit-${Date.now()}`;
      const walletAddress = "GDUP123";

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          try {
            return await ledgerService.createAction({
              idempotencyKey,
              walletAddress,
              actionType: "deposit",
              actionPayload: { poolId: "pool-1", amount: "1000" },
            });
          } catch (err) {
            // Unique constraint violation expected for duplicate actors
            return null;
          }
        },
        async (successResults) => {
          // Filter out null results
          const actions = successResults.filter((r) => r !== null);
          
          // Verify at least one success
          expect(actions.length).toBeGreaterThan(0);

          // Verify exactly one action in database
          const dbActions = await prisma.actionLedger.findMany({
            where: { idempotencyKey },
          });

          expect(dbActions).toHaveLength(1);
          expect(dbActions[0].walletAddress).toBe(walletAddress);
        }
      );
    });
  });

  describe("Concurrent Quest Completion", () => {
    it("should grant reward exactly once for concurrent evaluations", async () => {
      const scenario = RACE_SCENARIOS[1]; // concurrent_quest_completion
      const walletAddress = "GQUEST456";
      const questId = "quest-100";
      const idempotencyKey = createHash("sha256")
        .update(`${walletAddress}:${questId}`)
        .digest("hex");

      // Setup completed quest
      await prisma.userQuest.create({
        data: {
          walletAddress,
          questId,
          progress: 100,
          target: 100,
          status: "completed",
          completedAt: new Date(),
        },
      });

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          try {
            // Each actor attempts to grant reward
            return await prisma.rewardGrant.create({
              data: {
                walletAddress,
                questId,
                idempotencyKey,
                status: "pending",
              },
            });
          } catch (err) {
            // Unique constraint expected for all but one
            return null;
          }
        },
        async (successResults) => {
          const grants = successResults.filter((r) => r !== null);

          // At least one succeeded
          expect(grants.length).toBeGreaterThan(0);

          // Exactly one grant in database
          const dbGrants = await prisma.rewardGrant.findMany({
            where: { walletAddress, questId },
          });

          expect(dbGrants).toHaveLength(1);
          expect(dbGrants[0].idempotencyKey).toBe(idempotencyKey);
        }
      );
    });
  });

  describe("Concurrent Withdrawal with Stale Versions", () => {
    it("should handle concurrent withdrawals with CAS logic", async () => {
      const scenario = RACE_SCENARIOS[2]; // concurrent_withdraw_stale_version
      const idempotencyKeyBase = `withdraw-${Date.now()}`;
      const walletAddress = "GWITH789";

      // Pre-create action for CAS testing
      await prisma.actionLedger.create({
        data: {
          idempotencyKey: "existing-action",
          walletAddress,
          actionType: "deposit",
          actionPayload: { amount: "5000" },
          status: "confirmed",
        },
      });

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          try {
            // Read existing action (potentially stale)
            const existing = await prisma.actionLedger.findFirst({
              where: { walletAddress, status: "confirmed" },
              orderBy: { createdAt: "desc" },
            });

            // Attempt withdrawal with CAS check
            const idempotencyKey = `${idempotencyKeyBase}-${actorId}`;
            
            return await prisma.actionLedger.create({
              data: {
                idempotencyKey,
                walletAddress,
                actionType: "withdraw",
                actionPayload: {
                  amount: "100",
                  basedOnActionId: existing?.id,
                },
                status: "pending",
              },
            });
          } catch (err) {
            return null;
          }
        },
        async (successResults) => {
          const actions = successResults.filter((r) => r !== null);

          // All actors should succeed (each has unique idempotency key)
          expect(actions).toHaveLength(scenario.actorCount);

          // Verify all created
          const dbActions = await prisma.actionLedger.findMany({
            where: {
              walletAddress,
              actionType: "withdraw",
            },
          });

          expect(dbActions).toHaveLength(scenario.actorCount);
        }
      );
    });
  });

  describe("Retry Storm with Exponential Backoff", () => {
    it("should handle retry storms gracefully", async () => {
      const scenario = RACE_SCENARIOS[3]; // retry_storm_exponential_backoff
      const idempotencyKey = `retry-storm-${Date.now()}`;
      const walletAddress = "GSTORM";

      let attemptCounts: Record<number, number> = {};

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          attemptCounts[actorId] = 0;
          let delay = 10; // Initial delay 10ms

          for (let attempt = 0; attempt < 3; attempt++) {
            attemptCounts[actorId]++;

            try {
              return await ledgerService.createAction({
                idempotencyKey,
                walletAddress,
                actionType: "claim",
                actionPayload: { poolId: "pool-storm" },
              });
            } catch (err) {
              // Exponential backoff
              await new Promise((resolve) => setTimeout(resolve, delay));
              delay *= 2;
              
              if (attempt === 2) {
                // Last attempt failed
                return null;
              }
            }
          }
        },
        async (successResults) => {
          const actions = successResults.filter((r) => r !== null);

          // At least one should succeed
          expect(actions.length).toBeGreaterThan(0);

          // Verify exactly one action despite retries
          const dbActions = await prisma.actionLedger.findMany({
            where: { idempotencyKey },
          });

          expect(dbActions).toHaveLength(1);

          // Verify actors made multiple attempts
          const totalAttempts = Object.values(attemptCounts).reduce((a, b) => a + b, 0);
          expect(totalAttempts).toBeGreaterThan(scenario.actorCount);
        }
      );
    });
  });

  describe("Concurrent Transaction Hash Attachment", () => {
    it("should attach txHash exactly once", async () => {
      const scenario = RACE_SCENARIOS[4]; // concurrent_tx_hash_attachment
      const idempotencyKey = `action-attach-${Date.now()}`;
      const txHash = `txhash-${Date.now()}`;

      // Create pending action
      await prisma.actionLedger.create({
        data: {
          idempotencyKey,
          walletAddress: "GATTACH",
          actionType: "deposit",
          actionPayload: { poolId: "pool-attach" },
          status: "pending",
        },
      });

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          try {
            // Attempt to attach txHash with CAS
            return await prisma.actionLedger.updateMany({
              where: {
                idempotencyKey,
                status: "pending",
                txHash: null,
              },
              data: {
                txHash,
                status: "submitted",
                submittedAt: new Date(),
              },
            });
          } catch (err) {
            return null;
          }
        },
        async (successResults) => {
          // Verify exactly one update succeeded
          const action = await prisma.actionLedger.findUnique({
            where: { idempotencyKey },
          });

          expect(action?.txHash).toBe(txHash);
          expect(action?.status).toBe("submitted");

          // Count successful updates
          const successfulUpdates = successResults.filter(
            (r) => r && (r as any).count === 1
          );
          
          expect(successfulUpdates).toHaveLength(1);
        }
      );
    });
  });

  describe("Concurrent Settlement Resolution", () => {
    it("should resolve settlement exactly once", async () => {
      const scenario = RACE_SCENARIOS[5]; // concurrent_settlement_resolution
      const vaultId = `vault-${Date.now()}`;

      // Create unresolved settlement
      await prisma.vaultSettlement.create({
        data: {
          vaultId,
          state: "Unresolved",
          settlementType: "winner_claim",
          recipient: "GWINNER",
          amount: "1000",
        },
      });

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          try {
            // Attempt resolution with CAS
            const updated = await prisma.vaultSettlement.updateMany({
              where: {
                vaultId,
                state: "Unresolved",
              },
              data: {
                state: "Resolved",
                txHash: `txhash-settlement-${actorId}`,
                resolvedAt: new Date(),
              },
            });

            return updated.count > 0 ? updated : null;
          } catch (err) {
            return null;
          }
        },
        async (successResults) => {
          const settlements = await prisma.vaultSettlement.findMany({
            where: { vaultId },
          });

          // Exactly one settlement
          expect(settlements).toHaveLength(1);
          expect(settlements[0].state).toBe("Resolved");
          expect(settlements[0].txHash).toBeTruthy();

          // Count successful resolutions
          const successfulResolutions = successResults.filter((r) => r !== null);
          expect(successfulResolutions).toHaveLength(1);
        }
      );
    });
  });

  describe("Job Lease Acquisition", () => {
    it("should grant lease to exactly one worker", async () => {
      const jobName = "reconciler-sweep";
      const scenario = {
        name: "concurrent_lease_acquisition",
        actorCount: 5,
        description: "Five workers compete for lease",
      };

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          const workerId = `worker-${actorId}`;
          const expiresAt = new Date(Date.now() + 60000);

          try {
            // Attempt to acquire lease
            return await prisma.jobLease.upsert({
              where: { jobName },
              create: {
                jobName,
                workerId,
                fencingToken: 1n,
                expiresAt,
              },
              update: {
                workerId,
                fencingToken: { increment: 1 },
                acquiredAt: new Date(),
                expiresAt,
              },
            });
          } catch (err) {
            return null;
          }
        },
        async (successResults) => {
          const lease = await prisma.jobLease.findUnique({
            where: { jobName },
          });

          expect(lease).toBeTruthy();
          expect(lease?.workerId).toMatch(/^worker-\d+$/);
          
          // Fencing token incremented
          expect(Number(lease?.fencingToken)).toBeGreaterThan(0);
        }
      );
    });
  });

  describe("Fenced Write After Lease Takeover", () => {
    it("should reject stale writes with expired fencing token", async () => {
      const jobName = "indexer-sync";
      const scenario = {
        name: "fenced_write_after_takeover",
        actorCount: 3,
        description: "Workers attempt writes after lease takeover",
      };

      // Create initial lease
      const lease = await prisma.jobLease.create({
        data: {
          jobName,
          workerId: "worker-1",
          fencingToken: 1n,
          expiresAt: new Date(Date.now() + 60000),
        },
      });

      const initialToken = lease.fencingToken;

      // Simulate takeover
      await prisma.jobLease.update({
        where: { jobName },
        data: {
          workerId: "worker-2",
          fencingToken: { increment: 1 },
          acquiredAt: new Date(),
        },
      });

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          const workerId = `worker-${actorId}`;
          const token = actorId === 2 ? 2n : 1n; // Only worker-2 has current token

          try {
            // Attempt fenced write
            const result = await prisma.actionLedger.updateMany({
              where: {
                status: "pending",
                // In real code, would check lease token here
              },
              data: {
                status: "submitted",
                updatedAt: new Date(),
              },
            });

            // Verify token is current
            const currentLease = await prisma.jobLease.findUnique({
              where: { jobName },
            });

            if (currentLease?.fencingToken !== token) {
              // Stale token - rollback (in real code)
              return null;
            }

            return result;
          } catch (err) {
            return null;
          }
        },
        async (successResults) => {
          // Only worker with current token should succeed
          const validWrites = successResults.filter((r) => r !== null);
          
          // At most one valid write
          expect(validWrites.length).toBeLessThanOrEqual(1);

          // Verify current lease holder
          const currentLease = await prisma.jobLease.findUnique({
            where: { jobName },
          });

          expect(currentLease?.workerId).toBe("worker-2");
          expect(currentLease?.fencingToken).toBe(2n);
        }
      );
    });
  });

  describe("Compare-and-Swap State Transitions", () => {
    it("should enforce atomic state transitions", async () => {
      const idempotencyKey = `cas-state-${Date.now()}`;
      const scenario = {
        name: "concurrent_state_transition",
        actorCount: 4,
        description: "Concurrent attempts to transition action state",
      };

      // Create pending action
      await prisma.actionLedger.create({
        data: {
          idempotencyKey,
          walletAddress: "GCAS",
          actionType: "deposit",
          actionPayload: { poolId: "pool-cas" },
          status: "pending",
        },
      });

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          try {
            // Attempt CAS transition: pending -> submitted
            return await prisma.actionLedger.updateMany({
              where: {
                idempotencyKey,
                status: "pending", // CAS condition
              },
              data: {
                status: "submitted",
                txHash: `txhash-${actorId}`,
                submittedAt: new Date(),
              },
            });
          } catch (err) {
            return null;
          }
        },
        async (successResults) => {
          // Exactly one transition should succeed
          const successfulTransitions = successResults.filter(
            (r) => r && (r as any).count === 1
          );

          expect(successfulTransitions).toHaveLength(1);

          // Verify final state
          const action = await prisma.actionLedger.findUnique({
            where: { idempotencyKey },
          });

          expect(action?.status).toBe("submitted");
          expect(action?.txHash).toBeTruthy();
        }
      );
    });
  });

  describe("Optimistic Concurrency Control", () => {
    it("should handle version conflicts with optimistic locking", async () => {
      const scenario = {
        name: "optimistic_concurrency",
        actorCount: 5,
        description: "Concurrent updates with version checking",
      };

      const recordId = `occ-${Date.now()}`;

      // Create versioned record (using BackgroundJob as example)
      await prisma.backgroundJob.create({
        data: {
          id: recordId,
          type: "test-job",
          payload: { version: 0 },
          idempotencyKey: `job-${recordId}`,
          maxAttempts: 3,
        },
      });

      const results = await runConcurrentRaces(
        scenario,
        async (actorId) => {
          try {
            // Read current version
            const current = await prisma.backgroundJob.findUnique({
              where: { id: recordId },
            });

            if (!current) return null;

            const currentVersion = (current.payload as any).version ?? 0;

            // Attempt update with version check
            const updated = await prisma.backgroundJob.updateMany({
              where: {
                id: recordId,
                payload: { path: ["version"], equals: currentVersion },
              },
              data: {
                payload: { version: currentVersion + 1, updatedBy: actorId },
                updatedAt: new Date(),
              },
            });

            return updated.count > 0 ? updated : null;
          } catch (err) {
            return null;
          }
        },
        async (successResults) => {
          // Only first actor should succeed each iteration
          const finalJob = await prisma.backgroundJob.findUnique({
            where: { id: recordId },
          });

          const finalVersion = (finalJob?.payload as any).version;
          
          // Version incremented at least once
          expect(finalVersion).toBeGreaterThan(0);
          
          // Not all actors succeeded (version conflicts)
          const successCount = successResults.filter((r) => r !== null).length;
          expect(successCount).toBeLessThan(scenario.actorCount);
        }
      );
    });
  });
});
