/**
 * Incident drill executable verification tests
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { IncidentDrillExecutor, type DrillConfig } from "../src/operations/incidentDrill.js";
import { LedgerService } from "../src/services/ledger.js";
import { PendingRecoveryService } from "../src/services/pendingRecovery.js";
import { QuestService } from "../src/services/questService.js";
import { StellarIndexer } from "../src/services/stellarIndexer.js";
import { createLogger } from "../src/logger.js";

describe("Incident Drill Executor", () => {
  let db: TestDb;
  let executor: IncidentDrillExecutor;
  let ledger: LedgerService;
  let recovery: PendingRecoveryService;
  let quests: QuestService;
  let indexer: StellarIndexer;

  beforeAll(async () => {
    db = await startTestDb();
    ledger = new LedgerService(db.prisma);
    quests = new QuestService(db.prisma);

    // Mock indexer and recovery for drill execution
    recovery = new PendingRecoveryService({
      store: {
        insertIfAbsent: async (recoveryCase) => ({
          created: true,
          recoveryCase: { ...recoveryCase, version: 1 },
        }),
        load: async (id) => null,
        update: async (current, next) => next,
        list: async () => [],
      },
      actions: {
        getAction: async (id) => {
          const action = await db.prisma.actionLedger.findUnique({ where: { id } });
          return action
            ? {
                id: action.id,
                walletAddress: action.walletAddress,
                actionType: action.actionType,
                status: action.status,
                txHash: action.txHash,
                createdAt: action.createdAt,
                updatedAt: action.updatedAt,
              }
            : null;
        },
        listStale: async (cutoff, limit) => {
          const actions = await db.prisma.actionLedger.findMany({
            where: {
              status: { in: ["pending", "submitted"] },
              updatedAt: { lte: cutoff },
            },
            take: limit,
            orderBy: { updatedAt: "asc" },
          });
          return actions.map((a) => ({
            id: a.id,
            walletAddress: a.walletAddress,
            actionType: a.actionType,
            status: a.status,
            txHash: a.txHash,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
          }));
        },
        countStale: async (cutoff) => {
          return db.prisma.actionLedger.count({
            where: {
              status: { in: ["pending", "submitted"] },
              updatedAt: { lte: cutoff },
            },
          });
        },
      },
      audit: {
        record: async () => {},
      },
    });

    // Mock indexer (minimal for drill)
    indexer = {
      tick: async () => ({
        processed: 10,
        imported: 8,
        duplicates: 2,
        quarantined: 0,
        cursor: "test-cursor",
        latestLedger: 1000,
        chainLatestLedger: 1100,
        ingestedLedger: 1000,
      }),
    } as unknown as StellarIndexer;

    executor = new IncidentDrillExecutor({
      prisma: db.prisma,
      ledger,
      recovery,
      quests,
      indexer,
    });
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  describe("Stuck Deposit Drill", () => {
    it("executes full stuck deposit recovery workflow", async () => {
      const config: DrillConfig = {
        type: "stuck_deposit",
        environment: "test",
        autoRollback: true,
      };

      const result = await executor.execute(config);

      expect(result.drill).toBe("stuck_deposit");
      expect(result.scenario).toContain("stuck in pending");
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.verifications.length).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.rollbackPerformed).toBe(true);

      // Verify all checks ran
      const checks = result.verifications.map((v) => v.check);
      expect(checks).toContain("Action created in pending state");
      expect(checks).toContain("Recovery case opened");
    });

    it("validates recovery case transitions", async () => {
      const config: DrillConfig = {
        type: "stuck_deposit",
        environment: "test",
        autoRollback: false,
      };

      const result = await executor.execute(config);

      const caseCheck = result.verifications.find((v) => v.check === "Recovery case opened");
      expect(caseCheck?.passed).toBe(true);
      expect(caseCheck?.actual).toBe("retryable");
    });
  });

  describe("Indexer Lag Drill", () => {
    it("detects indexer lag metrics", async () => {
      const config: DrillConfig = {
        type: "indexer_lag",
        environment: "test",
        autoRollback: true,
      };

      const result = await executor.execute(config);

      expect(result.drill).toBe("indexer_lag");
      expect(result.passed).toBe(true);

      const lagCheck = result.verifications.find((v) => v.check === "Lag metric available");
      expect(lagCheck?.passed).toBe(true);
    });
  });

  describe("Quest Race Drill", () => {
    it("validates exactly-once reward grant", async () => {
      const config: DrillConfig = {
        type: "quest_race",
        environment: "test",
        autoRollback: true,
      };

      const result = await executor.execute(config);

      expect(result.drill).toBe("quest_race");

      const grantCheck = result.verifications.find(
        (v) => v.check === "Exactly one reward grant created"
      );
      expect(grantCheck?.passed).toBe(true);
      expect(grantCheck?.actual).toBe(1);
    });

    it("validates quest completion timestamp", async () => {
      const config: DrillConfig = {
        type: "quest_race",
        environment: "test",
        autoRollback: false,
      };

      const result = await executor.execute(config);

      const timestampCheck = result.verifications.find(
        (v) => v.check === "Quest has single completedAt timestamp"
      );
      expect(timestampCheck?.passed).toBe(true);
    });
  });

  describe("Settlement Timeout Drill", () => {
    it("detects stale settlements", async () => {
      const config: DrillConfig = {
        type: "settlement_timeout",
        environment: "test",
        autoRollback: true,
      };

      const result = await executor.execute(config);

      expect(result.drill).toBe("settlement_timeout");

      const staleCheck = result.verifications.find((v) => v.check === "Stale settlement detected");
      expect(staleCheck?.passed).toBe(true);
      expect(Number(staleCheck?.actual)).toBeGreaterThanOrEqual(1);
    });

    it("flags drift as orphaned_settlement type", async () => {
      const config: DrillConfig = {
        type: "settlement_timeout",
        environment: "test",
        autoRollback: false,
      };

      const result = await executor.execute(config);

      const driftCheck = result.verifications.find(
        (v) => v.check === "Drift flagged as orphaned_settlement"
      );
      expect(driftCheck?.passed).toBe(true);
      expect(driftCheck?.actual).toBe("orphaned_settlement");
    });
  });

  describe("Reconciliation Drift Drill", () => {
    it("detects missing event drift", async () => {
      const config: DrillConfig = {
        type: "reconciliation_drift",
        environment: "test",
        autoRollback: true,
      };

      const result = await executor.execute(config);

      expect(result.drill).toBe("reconciliation_drift");

      const driftCheck = result.verifications.find((v) => v.check === "Drift detected: missing_event");
      expect(driftCheck?.passed).toBe(true);
      expect(driftCheck?.actual).toBe("missing_event");
    });

    it("proposes re-indexing repair step", async () => {
      const config: DrillConfig = {
        type: "reconciliation_drift",
        environment: "test",
        autoRollback: false,
      };

      const result = await executor.execute(config);

      const repairCheck = result.verifications.find(
        (v) => v.check === "Repair plan proposes re-indexing"
      );
      expect(repairCheck?.passed).toBe(true);
      expect(String(repairCheck?.actual)).toContain("re-");
    });
  });

  describe("Drill Safety", () => {
    it("rejects non-test/sandbox environments", async () => {
      const config = {
        type: "stuck_deposit" as const,
        environment: "production" as any,
      };

      await expect(executor.execute(config)).rejects.toThrow(
        "Incident drills can only run in test or sandbox environments"
      );
    });

    it("auto-rollback cleans up drill data", async () => {
      const config: DrillConfig = {
        type: "quest_race",
        environment: "test",
        autoRollback: true,
      };

      await executor.execute(config);

      // Verify cleanup
      const drillActions = await db.prisma.actionLedger.count({
        where: { idempotencyKey: { startsWith: "drill-" } },
      });

      const drillQuests = await db.prisma.userQuest.count({
        where: { walletAddress: { startsWith: "GDRILL" } },
      });

      expect(drillActions).toBe(0);
      expect(drillQuests).toBe(0);
    });
  });

  describe("Drill Reporting", () => {
    it("includes timing metadata", async () => {
      const config: DrillConfig = {
        type: "indexer_lag",
        environment: "test",
        autoRollback: true,
      };

      const result = await executor.execute(config);

      expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("provides actionable summary", async () => {
      const config: DrillConfig = {
        type: "stuck_deposit",
        environment: "test",
        autoRollback: true,
      };

      const result = await executor.execute(config);

      expect(result.summary).toMatch(/✅|❌/);
      expect(result.summary.toLowerCase()).toContain("deposit");
    });

    it("reports all verification outcomes", async () => {
      const config: DrillConfig = {
        type: "settlement_timeout",
        environment: "test",
        autoRollback: false,
      };

      const result = await executor.execute(config);

      for (const verification of result.verifications) {
        expect(verification).toHaveProperty("check");
        expect(verification).toHaveProperty("passed");
        expect(verification).toHaveProperty("actual");
        expect(verification).toHaveProperty("expected");
      }
    });
  });
});
