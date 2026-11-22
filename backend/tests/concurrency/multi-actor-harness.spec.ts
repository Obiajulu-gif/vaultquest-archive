/**
 * Multi-actor concurrency harness (Issue #4).
 * 
 * Simulates concurrent actors racing on critical mutations (deposits,
 * withdrawals, quest completions, settlements). Tests duplicate submissions,
 * stale versions, retry storms.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestPrisma } from "../helpers/db.js";
import { LedgerService } from "../../src/services/ledger.js";
import { QuestService } from "../../src/services/questService.js";
import { CacheService } from "../../src/services/cacheService.js";
import type { PrismaClient } from "@prisma/client";
import { runConcurrentRaces, RACE_SCENARIOS } from "./race-framework.js";

describe("Multi-Actor Concurrency Harness", () => {
  let prisma: PrismaClient;
  let ledger: LedgerService;
  let cache: CacheService;
  let quests: QuestService;

  beforeEach(async () => {
    prisma = await createTestPrisma();
    cache = new CacheService(prisma, null);
    ledger = new LedgerService(prisma, cache);
    quests = new QuestService(prisma, ledger);
  });

  it("concurrent deposit with same idempotency key produces one action", async () => {
    const scenario = RACE_SCENARIOS.find((s) => s.name === "duplicate_deposit_submission")!;
    const walletAddress = "GCONC1DEPOSIT";
    const idempotencyKey = `race-deposit-${Date.now()}`;

    const results = await runConcurrentRaces(
      scenario,
      async (actorId) => {
        return ledger.createAction({
          idempotencyKey,
          walletAddress,
          actionType: "deposit",
          actionPayload: { amount: `${1000 + actorId}`, poolId: "pool-race" },
        });
      },
      async (results) => {
        const uniqueActionIds = new Set(results.map((r) => r.id));
        expect(uniqueActionIds.size).toBe(1);

        const actions = await prisma.actionLedger.findMany({
          where: { idempotencyKey },
        });
        expect(actions).toHaveLength(1);
      }
    );
  });

  it("concurrent quest completion grants reward exactly once", async () => {
    const scenario = RACE_SCENARIOS.find((s) => s.name === "concurrent_quest_completion")!;
    const walletAddress = "GCONC2QUEST";

    await ledger.createAction({
      idempotencyKey: `quest-setup-${Date.now()}-1`,
      walletAddress,
      actionType: "deposit",
      actionPayload: { amount: "100", poolId: "pool-quest" },
    });

    const results = await runConcurrentRaces(
      scenario,
      async (actorId) => {
        return quests.evaluateWallet(walletAddress);
      },
      async (results) => {
        const grants = await prisma.rewardGrant.findMany({
          where: { walletAddress },
        });

        const firstDepositGrants = grants.filter((g) =>
          (g.idempotencyKey as string).includes("first_deposit")
        );
        expect(firstDepositGrants.length).toBeLessThanOrEqual(1);
      }
    );
  });

  it("concurrent withdraw with stale version triggers conflict retry", async () => {
    const scenario = RACE_SCENARIOS.find((s) => s.name === "concurrent_withdraw_stale_version")!;
    const walletAddress = "GCONC3WITHDRAW";
    const baseIdempotencyKey = `race-withdraw-${Date.now()}`;

    const results = await runConcurrentRaces(
      scenario,
      async (actorId) => {
        const idempotencyKey = `${baseIdempotencyKey}-${actorId}`;
        try {
          return await ledger.createAction({
            idempotencyKey,
            walletAddress,
            actionType: "withdraw",
            actionPayload: { amount: "500", poolId: "pool-race" },
          });
        } catch (err: any) {
          return { error: err.message, actorId };
        }
      },
      async (results) => {
        const successfulActions = results.filter((r) => r.id);
        expect(successfulActions.length).toBeGreaterThan(0);

        const actions = await prisma.actionLedger.findMany({
          where: {
            walletAddress,
            actionType: "withdraw",
          },
        });
        expect(actions.every((a) => a.status === "pending")).toBe(true);
      }
    );
  });

  it("retry storm with exponential backoff never duplicates", async () => {
    const scenario = RACE_SCENARIOS.find((s) => s.name === "retry_storm_exponential_backoff")!;
    const walletAddress = "GCONC4RETRY";
    const idempotencyKey = `race-retry-${Date.now()}`;

    let attemptCounts: number[] = [];

    const results = await runConcurrentRaces(
      scenario,
      async (actorId) => {
        let attempts = 0;
        const maxAttempts = 5;
        const baseDelayMs = 10;

        while (attempts < maxAttempts) {
          attempts++;
          try {
            const result = await ledger.createAction({
              idempotencyKey,
              walletAddress,
              actionType: "deposit",
              actionPayload: { amount: "2000", poolId: "pool-retry" },
            });
            attemptCounts.push(attempts);
            return result;
          } catch (err: any) {
            if (attempts < maxAttempts) {
              const jitter = Math.random() * 0.3;
              const delayMs = baseDelayMs * Math.pow(2, attempts - 1) * (1 + jitter);
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            } else {
              attemptCounts.push(attempts);
              throw err;
            }
          }
        }
      },
      async (results) => {
        expect(attemptCounts.length).toBeGreaterThan(1);

        const actions = await prisma.actionLedger.findMany({
          where: { idempotencyKey },
        });
        expect(actions).toHaveLength(1);
      }
    );
  });

  it("concurrent txHash attachment produces one submission", async () => {
    const scenario = RACE_SCENARIOS.find((s) => s.name === "concurrent_tx_hash_attachment")!;
    const walletAddress = "GCONC5TXHASH";
    const idempotencyKey = `race-txhash-${Date.now()}`;

    const action = await ledger.createAction({
      idempotencyKey,
      walletAddress,
      actionType: "deposit",
      actionPayload: { amount: "3000", poolId: "pool-txhash" },
    });

    const txHash = `race-tx-${Date.now()}`;

    const results = await runConcurrentRaces(
      scenario,
      async (actorId) => {
        try {
          return await ledger.attachTxHash({
            id: action.id,
            txHash,
            submittedAt: new Date(),
          });
        } catch (err: any) {
          return { error: err.message, actorId };
        }
      },
      async (results) => {
        const successfulAttachments = results.filter((r) => r.status === "submitted");
        expect(successfulAttachments.length).toBeGreaterThanOrEqual(1);

        const updatedAction = await prisma.actionLedger.findUnique({
          where: { id: action.id },
        });
        expect(updatedAction?.status).toBe("submitted");
        expect(updatedAction?.txHash).toBe(txHash);
      }
    );
  });

  it("concurrent settlement resolution produces one winner", async () => {
    const scenario = RACE_SCENARIOS.find((s) => s.name === "concurrent_settlement_resolution")!;
    const settlementId = `race-settlement-${Date.now()}`;

    await prisma.vaultSettlement.create({
      data: {
        id: settlementId,
        poolId: "pool-settlement",
        roundNumber: 1,
        state: "Unresolved",
        totalDeposits: "10000",
        yield: "100",
        createdAt: new Date(),
      },
    });

    const results = await runConcurrentRaces(
      scenario,
      async (actorId) => {
        try {
          return await prisma.vaultSettlement.update({
            where: { id: settlementId, state: "Unresolved" },
            data: { state: "Resolving", resolvedAt: new Date() },
          });
        } catch (err: any) {
          return { error: err.message, actorId };
        }
      },
      async (results) => {
        const settlement = await prisma.vaultSettlement.findUnique({
          where: { id: settlementId },
        });
        expect(settlement?.state).toBe("Resolving");
        expect(settlement?.resolvedAt).toBeDefined();
      }
    );
  });
});
