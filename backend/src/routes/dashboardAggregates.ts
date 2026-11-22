/**
 * Dashboard Aggregates Route (issue #750)
 *
 * GET /dashboard/aggregates?scope=global
 *
 * Returns a watermark-tagged aggregate snapshot for the requested scope.
 * The watermark is the MAX(updated_at) of the action_ledger rows that were
 * included when the aggregate was last computed, so the frontend can verify
 * that aggregate and detail data represent the same consistent snapshot.
 *
 * POST /dashboard/aggregates/refresh?scope=global (internal, api-key guarded)
 *
 * Forces a transactional aggregate recomputation for the requested scope.
 * Normally this is triggered automatically by the reconciler after every
 * deposit/withdrawal confirmation, but can be called manually in admin
 * or test scenarios.
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import type { DashboardAggregateService, AggregateScope } from "../services/dashboardAggregateService.js";
import { ok } from "../responses.js";
import { AppError } from "../errors.js";

export const dashboardAggregatesRoutes = (
  svc: DashboardAggregateService,
  apiKeyGuard: preHandlerHookHandler
): FastifyPluginAsync =>
  async (app) => {
    /**
     * GET /dashboard/aggregates
     *
     * Query params:
     *   scope  – aggregate scope identifier (default: "global")
     *
     * Response (200):
     * {
     *   data: {
     *     scope:               string,
     *     watermark:           ISO timestamp (ceiling updatedAt of included rows),
     *     total_value_locked:  string,
     *     total_prize_pool:    string,
     *     win_distribution:    Array<{ walletAddress, amount, roundId, confirmedAt }>,
     *     deposit_count:       number,
     *     deposit_total:       string,
     *     computed_at:         ISO timestamp
     *   }
     * }
     *
     * Usage by the dashboard:
     *  1. Fetch aggregates (this endpoint) to get TVL, prize pool, etc.
     *  2. Fetch detail rows (/actions?wallet=...) for the per-row breakdown.
     *  3. Compare each detail row's updatedAt against the watermark returned
     *     here. If any row.updatedAt > watermark, show a staleness banner.
     */
    app.get("/dashboard/aggregates", async (req, reply) => {
      const query = req.query as Record<string, string | undefined>;
      const scope = (query.scope ?? "global") as AggregateScope;

      const snapshot = await svc.getAggregate(scope);

      if (!snapshot) {
        // No snapshot yet — return a zeroed response with a null watermark
        // so the UI can render a "loading / no data" state gracefully.
        return ok({
          scope,
          watermark: null,
          total_value_locked: "0.00",
          total_prize_pool: "0.00",
          win_distribution: [],
          deposit_count: 0,
          deposit_total: "0.00",
          computed_at: null,
        });
      }

      return ok({
        scope: snapshot.scope,
        watermark: snapshot.watermark.toISOString(),
        total_value_locked: snapshot.totalValueLocked,
        total_prize_pool: snapshot.totalPrizePool,
        win_distribution: snapshot.winDistribution,
        deposit_count: snapshot.depositCount,
        deposit_total: snapshot.depositTotal,
        computed_at: snapshot.computedAt.toISOString(),
      });
    });

    /**
     * POST /dashboard/aggregates/refresh  (internal; api-key guarded)
     *
     * Forces a synchronous transactional refresh of the aggregate for the
     * given scope. Use sparingly — the reconciler triggers this automatically.
     */
    app.post(
      "/dashboard/aggregates/refresh",
      { preHandler: apiKeyGuard },
      async (req) => {
        const query = req.query as Record<string, string | undefined>;
        const scope = (query.scope ?? "global") as AggregateScope;

        const result = await svc.refreshAggregates(scope);

        return ok({
          scope: result.scope,
          watermark: result.watermark.toISOString(),
          deposit_count: result.depositCount,
          deposit_total: result.depositTotal,
        });
      }
    );
  };
