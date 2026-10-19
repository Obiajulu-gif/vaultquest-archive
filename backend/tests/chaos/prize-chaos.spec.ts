/**
 * Chaos tests for prize round workflow (Issue #1).
 * 
 * Tests prize draw execution under network failures, process restarts, and
 * concurrent winner selections. Verifies no duplicate prize grants.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createTestPrisma } from "../helpers/db.js";
import { DrawProofService } from "../../src/services/drawProofService.js";
import type { PrismaClient } from "@prisma/client";
import { runChaosTest, ChaosScenario, ProcessRestartError } from "./chaos-framework.js";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";

const PRIZE_CHAOS_SCENARIOS: ChaosScenario[] = [
  {
    name: "prize_draw_with_network_failure",
    faults: [
      { type: "network_timeout", atOperation: 3 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "prize_draw_with_process_restart",
    faults: [
      { type: "process_restart", atOperation: 4 },
    ],
    expectedOutcome: "success",
  },
  {
    name: "prize_draw_with_concurrent_winner_selection",
    faults: [
      { type: "transaction_conflict", atOperation: 5 },
      { type: "stale_read", atOperation: 6 },
    ],
    expectedOutcome: "success",
  },
];

describe("Prize Draw Chaos Tests", () => {
  let prisma: PrismaClient;
  let drawProofService: DrawProofService;

  beforeEach(async () => {
    prisma = await createTestPrisma();
    drawProofService = new DrawProofService(prisma);
  });

  it("prize draw survives network failure during winner selection", async () => {
    const scenario = PRIZE_CHAOS_SCENARIOS[0];
    const roundNumber = Math.floor(Date.now() / 1000);
    const poolId = `chaos-pool-${roundNumber}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Check existing draw
        await coordinator.beforeOperation("check_existing_draw");
        const existing = await prisma.prizeDrawResult.findFirst({
          where: { roundNumber, poolId },
        });

        if (existing) return existing;

        // Op 2: Generate random seed
        await coordinator.beforeOperation("generate_seed");
        const seed = `chaos-seed-${Date.now()}`;

        // Op 3: Create draw result (network_timeout fault)
        await coordinator.beforeOperation("create_draw_result");
        try {
          return await drawProofService.recordDrawResult({
            roundNumber,
            poolId,
            winnerAddress: "GCHAOSWINNER1",
            seed,
            participants: 100,
          });
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.NETWORK_ERROR) {
            // Retry with idempotency
            await coordinator.beforeOperation("retry_create_draw");
            return await drawProofService.recordDrawResult({
              roundNumber,
              poolId,
              winnerAddress: "GCHAOSWINNER1",
              seed,
              participants: 100,
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults).toHaveLength(1);

        // Verify exactly one draw result
        const draws = await prisma.prizeDrawResult.findMany({
          where: { roundNumber, poolId },
        });
        expect(draws).toHaveLength(1);
      }
    );
  });

  it("prize draw survives process restart mid-execution", async () => {
    const scenario = PRIZE_CHAOS_SCENARIOS[1];
    const roundNumber = Math.floor(Date.now() / 1000) + 1;
    const poolId = `chaos-pool-restart-${roundNumber}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Create settlement checkpoint
        await coordinator.beforeOperation("create_settlement");
        await prisma.vaultSettlement.create({
          data: {
            id: `settlement-${roundNumber}`,
            poolId,
            roundNumber,
            state: "Unresolved",
            totalDeposits: "10000",
            yield: "100",
            createdAt: new Date(),
          },
        });

        // Op 2: Mark settlement as resolving
        await coordinator.beforeOperation("mark_resolving");
        await prisma.vaultSettlement.update({
          where: { id: `settlement-${roundNumber}` },
          data: { state: "Resolving" },
        });

        // Op 3: Generate participants snapshot
        await coordinator.beforeOperation("snapshot_participants");
        const participants = 50;

        // Op 4: Execute draw (process_restart fault)
        await coordinator.beforeOperation("execute_draw");
        const seed = `restart-seed-${Date.now()}`;
        const winnerAddress = "GCHAOSRESTART1";

        return await drawProofService.recordDrawResult({
          roundNumber,
          poolId,
          winnerAddress,
          seed,
          participants,
        });
      },
      async (result, faults) => {
        // After restart, verify settlement and draw are consistent
        const settlement = await prisma.vaultSettlement.findFirst({
          where: { roundNumber, poolId },
        });
        expect(settlement).toBeDefined();

        const draw = await prisma.prizeDrawResult.findFirst({
          where: { roundNumber, poolId },
        });
        expect(draw).toBeDefined();
        expect(draw?.winnerAddress).toBe("GCHAOSRESTART1");
      }
    );
  });

  it("prize draw handles concurrent winner selection atomically", async () => {
    const scenario = PRIZE_CHAOS_SCENARIOS[2];
    const roundNumber = Math.floor(Date.now() / 1000) + 2;
    const poolId = `chaos-pool-concurrent-${roundNumber}`;

    await runChaosTest(
      scenario,
      async (coordinator) => {
        // Op 1: Read checkpoint
        await coordinator.beforeOperation("read_checkpoint");
        const existing = await prisma.prizeDrawResult.findFirst({
          where: { roundNumber, poolId },
        });

        if (existing) return existing;

        // Op 2: Generate seed deterministically
        await coordinator.beforeOperation("generate_deterministic_seed");
        const seed = `concurrent-seed-${roundNumber}`;

        // Op 3: Read participants (stale_read after this)
        await coordinator.beforeOperation("read_participants");
        let participants = 75;

        // Op 4: Select winner
        await coordinator.beforeOperation("select_winner");
        const winnerAddress = "GCHAOSCONCURRENT1";

        // Op 5: Record draw result (transaction_conflict fault)
        await coordinator.beforeOperation("record_draw");
        try {
          return await drawProofService.recordDrawResult({
            roundNumber,
            poolId,
            winnerAddress,
            seed,
            participants,
          });
        } catch (err) {
          if (err instanceof AppError && err.code === ERROR_CODES.CONFLICT) {
            // Op 6: Retry after conflict (stale_read fault)
            await coordinator.beforeOperation("retry_after_conflict");
            const fresh = await prisma.prizeDrawResult.findFirst({
              where: { roundNumber, poolId },
            });

            if (fresh) return fresh;

            // Retry with fresh data
            return await drawProofService.recordDrawResult({
              roundNumber,
              poolId,
              winnerAddress,
              seed,
              participants,
            });
          }
          throw err;
        }
      },
      async (result, faults) => {
        expect(result).toBeDefined();
        expect(faults.length).toBeGreaterThanOrEqual(1);

        // Verify exactly one winner
        const draws = await prisma.prizeDrawResult.findMany({
          where: { roundNumber, poolId },
        });
        expect(draws).toHaveLength(1);
      }
    );
  });
});
