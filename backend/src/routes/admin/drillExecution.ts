/**
 * Admin endpoints for incident drill execution
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ok } from "../../responses.js";
import { IncidentDrillExecutor, type DrillConfig, type IncidentType } from "../../operations/incidentDrill.js";
import type { PrismaClient } from "@prisma/client";
import type { LedgerService } from "../../services/ledger.js";
import type { PendingRecoveryService } from "../../services/pendingRecovery.js";
import type { QuestService } from "../../services/questService.js";
import type { StellarIndexer } from "../../services/stellarIndexer.js";

export type DrillGuards = {
  adminWrite: preHandlerHookHandler;
};

const executeDrillBody = z.object({
  type: z.enum(["stuck_deposit", "indexer_lag", "quest_race", "settlement_timeout", "reconciliation_drift"]),
  environment: z.enum(["test", "sandbox"]),
  autoRollback: z.boolean().default(true),
});

const listDrillsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

interface DrillHistory {
  id: string;
  drill: string;
  environment: string;
  passed: boolean;
  executedAt: string;
  durationMs: number;
  executedBy: string;
}

export const drillExecutionRoutes = (
  prisma: PrismaClient,
  ledger: LedgerService,
  recovery: PendingRecoveryService,
  quests: QuestService,
  indexer: StellarIndexer,
  guards: DrillGuards
): FastifyPluginAsync =>
  async (app) => {
    const executor = new IncidentDrillExecutor({
      prisma,
      ledger,
      recovery,
      quests,
      indexer,
    });

    /**
     * POST /admin/drills/execute
     * 
     * Executes an incident drill and returns results.
     */
    app.post("/admin/drills/execute", { preHandler: [guards.adminWrite] }, async (req) => {
      const body = executeDrillBody.parse(req.body);
      const principal = (req as any).principal;

      // Environment check
      if (process.env.NODE_ENV === "production") {
        throw new Error("Drills cannot be executed in production environment");
      }

      const config: DrillConfig = {
        type: body.type as IncidentType,
        environment: body.environment,
        autoRollback: body.autoRollback,
      };

      app.log.info({
        drill: body.type,
        environment: body.environment,
        executedBy: principal?.subject,
      }, "executing incident drill");

      const result = await executor.execute(config);

      // Optionally store drill history
      if (process.env.STORE_DRILL_HISTORY === "true") {
        await prisma.$executeRaw`
          INSERT INTO drill_history (id, drill, environment, passed, executed_at, duration_ms, executed_by, result)
          VALUES (
            gen_random_uuid(),
            ${result.drill},
            ${config.environment},
            ${result.passed},
            ${new Date(result.startedAt)},
            ${result.durationMs},
            ${principal?.subject ?? "system"},
            ${JSON.stringify(result)}::jsonb
          )
        `;
      }

      return ok(result);
    });

    /**
     * GET /admin/drills/history
     * 
     * Lists recent drill executions (if history is enabled).
     */
    app.get("/admin/drills/history", { preHandler: [guards.adminWrite] }, async (req) => {
      const query = listDrillsQuery.parse(req.query);

      if (process.env.STORE_DRILL_HISTORY !== "true") {
        return ok({
          history: [],
          message: "Drill history storage is not enabled",
        });
      }

      const history = await prisma.$queryRaw<DrillHistory[]>`
        SELECT id, drill, environment, passed, executed_at as "executedAt", 
               duration_ms as "durationMs", executed_by as "executedBy"
        FROM drill_history
        ORDER BY executed_at DESC
        LIMIT ${query.limit}
      `;

      return ok({ history });
    });

    /**
     * GET /admin/drills/catalog
     * 
     * Lists available drills with metadata.
     */
    app.get("/admin/drills/catalog", { preHandler: [guards.adminWrite] }, async () => {
      const catalog = [
        {
          type: "stuck_deposit",
          description: "User deposit stuck in pending for >30min",
          recoveryTimeTarget: "5min",
          frequency: "Monthly",
        },
        {
          type: "indexer_lag",
          description: "Indexer falls behind chain tip by >10k ledgers",
          recoveryTimeTarget: "10min",
          frequency: "Quarterly",
        },
        {
          type: "quest_race",
          description: "Concurrent quest completion race condition",
          recoveryTimeTarget: "Immediate (automated)",
          frequency: "Quarterly",
        },
        {
          type: "settlement_timeout",
          description: "Vault settlement stuck in Resolving for >1hr",
          recoveryTimeTarget: "15min",
          frequency: "Monthly",
        },
        {
          type: "reconciliation_drift",
          description: "Missing event (indexer gap)",
          recoveryTimeTarget: "30min",
          frequency: "Quarterly",
        },
      ];

      return ok({ catalog });
    });
  };
