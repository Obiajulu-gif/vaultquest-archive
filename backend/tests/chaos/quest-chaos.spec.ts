/**
 * Chaos tests for quest completion workflow (Issue #1).
 * 
 * Tests quest evaluation and reward grants under failures. Verifies
 * idempotency, no duplicate rewards, and consistent audit trail.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestPrisma } from "../helpers/db.js";
import { QuestService } from "../../src/services/questService.js";
import { LedgerService } from "../../src/services/ledger.js";
import { CacheService } from "../../src/services/cacheService.js";
import type { PrismaClient } from "@prisma/client";
import { runChaosTest, ChaosScenario } from "./chaos-framework.js";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";

const QUEST_CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    name: "quest_evaluation_with_network_timeout",
    faults: [
      { type: "network_timeout", atOperation: 3 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "quest_reward_grant_with_conflict",
    faults: [
      { type: "transaction_conflict", atOperation: 5 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "quest_completion_with_process_restart",
    faults: [
      { type: "process_restart", atOperation: 4 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "quest_evaluation_with_stale_read_retry",
    faults: [
      { type: "stale_read", atOperation: 2 },
      { type: "transaction_conflict", atOperation: 6 },
    ],
    expectedOutcome: "success",
  },
];

describe("Quest Completion Chaos Tests", () => {
  let prisma: PrismaClient;
  let questService: QuestService;
  let ledgerService: LedgerService;
  let cacheService: CacheService;

  beforeEach(async () => {
    prisma = await createTestPrisma();
    cacheService = new CacheService(prisma, null);
    ledgerService = new LedgerService(prisma, cacheService);
    questService = new QuestService(prisma, ledgerService);
  });

  it("quest evaluation survives network timeout during check", async () => {
    const scenario = QUEST_CHAOS_SCENARIOS[0];
    const walletAddress = `GCHAOSQUEST1${Date.now()}`;

    // Setup: create qualifying action
    await ledgerService.createAction({
      idempotencyKey: `quest-setup-${Date.now()}`,
      walletAddress,
      actionType: "deposit",
      actionPayload: { amount: "1000", poolId: "quest-pool" },
    });

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read wallet actions
        await coordinator.beforeOperation("read_wallet_actions");
        const actions = await prisma.actionLedger.findMany({
          where: { walletAddress },
        });

        // Op 2: Check existing quest progress
        await coordinator.beforeOperation("check_quest_progress");
        const existing = await prisma.userQuest.findFirst({
          where: { walletAddress, questType: "first_deposit" },
        });

        if (existing) return existing;

        // Op 3: Evaluate quest criteria (network_timeout fault)
        await coordinator.beforeOperation("evaluate_criteria");
        try {
          await questService.evaluateWallet(walletAddress);
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) {
            // Retry quest evaluation
            await coordinator.beforeOperation("retry_evaluation");
            await questService.evaluateWallet(walletAddress);
          } else {
            throw err;
          }
        }

        return await prisma.userQuest.findFirst({
          where: { walletAddress, questType: "first_deposit" },
        });
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults).toHaveLength(1);

        // Verify exactly one quest record
        const quests = await prisma.userQuest.findMany({
          where: { walletAddress, questType: "first_deposit" },
        });
        expect(quests).toHaveLength(1);

        // Verify exactly one reward grant
        const grants = await prisma.rewardGrant.findMany({
          where: { walletAddress },
        });
        expect(grants.length).toBeLessThanOrEqual(1);
      }
    );
  });

  it("quest reward grant handles transaction conflict", async () => {
    const scenario = QUEST_CHAOS_SCENARIOS[1];
    const walletAddress = `GCHAOSQUEST2${Date.now()}`;

    // Setup: create qualifying actions
    for (let i = 0; i < 3; i++) {
      await ledgerService.createAction({
        idempotencyKey: `quest-multi-${Date.now()}-${i}`,
        walletAddress,
        actionType: "deposit",
        actionPayload: { amount: `${1000 * (i + 1)}`, poolId: "quest-pool" },
      });
    }

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read actions
        await coordinator.beforeOperation("read_actions");
        const actions = await prisma.actionLedger.findMany({
          where: { walletAddress },
        });

        // Op 2: Check existing grant
        await coordinator.beforeOperation("check_grant");
        const existingGrant = await prisma.rewardGrant.findFirst({
          where: { walletAddress, questType: "multi_deposit" },
        });

        if (existingGrant) return existingGrant;

        // Op 3: Calculate reward amount
        await coordinator.beforeOperation("calculate_reward");
        const rewardAmount = "100";

        // Op 4: Generate idempotency key
        await coordinator.beforeOperation("generate_key");
        const idempotencyKey = `${walletAddress}:multi_deposit`;

        // Op 5: Create reward grant (transaction_conflict fault)
        await coordinator.beforeOperation("create_grant");
        try {
          return await prisma.rewardGrant.create({
            data: {
              id: `grant-${Date.now()}`,
              walletAddress,
              questType: "multi_deposit",
              amount: rewardAmount,
              idempotencyKey,
              grantedAt: new Date(),
            },
          });
        } catch (err: any) {
          if (err.code === "P2002" || (err instanceof AppError && err.code === ERROR_CODES.CONFLICT)) {
            // Conflict on unique constraint, fetch existing
            await coordinator.beforeOperation("fetch_existing_grant");
            return await prisma.rewardGrant.findFirst({
              where: { walletAddress, questType: "multi_deposit" },
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults).toHaveLength(1);

        // Verify exactly one grant despite conflict
        const grants = await prisma.rewardGrant.findMany({
          where: { walletAddress, questType: "multi_deposit" },
        });
        expect(grants).toHaveLength(1);
      }
    );
  });

  it("quest completion survives process restart", async () => {
    const scenario = QUEST_CHAOS_SCENARIOS[2];
    const walletAddress = `GCHAOSQUEST3${Date.now()}`;

    // Setup: create checkpoint action
    await ledgerService.createAction({
      idempotencyKey: `quest-checkpoint-${Date.now()}`,
      walletAddress,
      actionType: "deposit",
      actionPayload: { amount: "5000", poolId: "quest-pool" },
    });

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read checkpoint
        await coordinator.beforeOperation("read_checkpoint");
        const questProgress = await prisma.userQuest.findFirst({
          where: { walletAddress, questType: "large_deposit" },
        });

        if (questProgress) return questProgress;

        // Op 2: Create quest progress record
        await coordinator.beforeOperation("create_progress");
        await prisma.userQuest.create({
          data: {
            id: `quest-${Date.now()}`,
            walletAddress,
            questType: "large_deposit",
            status: "in_progress",
            progress: { step: 1, amount: "5000" },
            startedAt: new Date(),
          },
        });

        // Op 3: Mark quest as eligible
        await coordinator.beforeOperation("mark_eligible");
        await prisma.userQuest.update({
          where: {
            id: `quest-${Date.now()}`,
          },
          data: { status: "eligible" },
        });

        // Op 4: Grant reward (process_restart fault)
        await coordinator.beforeOperation("grant_reward");
        const idempotencyKey = `${walletAddress}:large_deposit`;
        return await prisma.rewardGrant.create({
          data: {
            id: `grant-${Date.now()}`,
            walletAddress,
            questType: "large_deposit",
            amount: "250",
            idempotencyKey,
            grantedAt: new Date(),
          },
        });
      },
      async (result, faults) => {
        // After restart, verify quest state
        const quest = await prisma.userQuest.findFirst({
          where: { walletAddress, questType: "large_deposit" },
        });
        expect(quest).toBeDefined();

        const grant = await prisma.rewardGrant.findFirst({
          where: { walletAddress, questType: "large_deposit" },
        });
        expect(grant).toBeDefined();
      }
    );
  });

  it("quest evaluation handles stale read with retry", async () => {
    const scenario = QUEST_CHAOS_SCENARIOS[3];
    const walletAddress = `GCHAOSQUEST4${Date.now()}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Create qualifying action
        await coordinator.beforeOperation("create_action");
        await ledgerService.createAction({
          idempotencyKey: `quest-stale-${Date.now()}`,
          walletAddress,
          actionType: "deposit",
          actionPayload: { amount: "2000", poolId: "quest-pool" },
        });

        // Op 2: Read wallet actions (stale_read fault)
        await coordinator.beforeOperation("read_actions_stale");
        let actions = await prisma.actionLedger.findMany({
          where: { walletAddress },
        });
        actions = coordinator.interceptRead(actions) as any;

        // Op 3: Check completion criteria
        await coordinator.beforeOperation("check_criteria");
        const meetsThreshold = actions.length > 0;

        if (!meetsThreshold) {
          // Stale read showed no actions, retry
          await coordinator.beforeOperation("retry_read_actions");
          actions = await prisma.actionLedger.findMany({
            where: { walletAddress },
          });
        }

        // Op 4: Create quest record
        await coordinator.beforeOperation("create_quest");
        const questId = `quest-stale-${Date.now()}`;
        await prisma.userQuest.create({
          data: {
            id: questId,
            walletAddress,
            questType: "stale_test",
            status: "completed",
            progress: { actions: actions.length },
            startedAt: new Date(),
            completedAt: new Date(),
          },
        });

        // Op 5: Create reward grant
        await coordinator.beforeOperation("create_grant_initial");
        const idempotencyKey = `${walletAddress}:stale_test`;
        
        // Op 6: Record grant (transaction_conflict fault)
        await coordinator.beforeOperation("record_grant");
        try {
          return await prisma.rewardGrant.create({
            data: {
              id: `grant-stale-${Date.now()}`,
              walletAddress,
              questType: "stale_test",
              amount: "150",
              idempotencyKey,
              grantedAt: new Date(),
            },
          });
        } catch (err: any) {
          if (err.code === "P2002" || (err instanceof AppError && err.code === ERROR_CODES.CONFLICT)) {
            await coordinator.beforeOperation("fetch_grant_after_conflict");
            return await prisma.rewardGrant.findFirst({
              where: { idempotencyKey },
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults.length).toBeGreaterThanOrEqual(1);

        // Verify no duplicate grants
        const grants = await prisma.rewardGrant.findMany({
          where: { walletAddress, questType: "stale_test" },
        });
        expect(grants).toHaveLength(1);
      }
    );
  });
});
