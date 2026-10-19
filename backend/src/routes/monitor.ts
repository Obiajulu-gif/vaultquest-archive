import type { FastifyPluginAsync } from "fastify";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { ok } from "../responses.js";
import type { SyntheticMonitorRunner } from "../services/syntheticMonitor.js";

/**
 * Synthetic journey monitor endpoints (#monitor).
 *
 * - `POST /internal/synthetic-monitor/run` executes one journey now.
 * - `GET  /internal/synthetic-monitor/status` returns the last run result
 *   (or `never_run`) for dashboards and alerting integrations.
 *
 * Both require the internal service secret. The scheduled runner shares the
 * same {@link SyntheticMonitorRunner} instance, so status stays accurate
 * regardless of what triggered the run.
 */
export const monitorRoutes = (
  runner: SyntheticMonitorRunner,
  internalSecret: string
): FastifyPluginAsync =>
  async (app) => {
    const guard = requireServiceAuth(internalSecret);

    app.post("/internal/synthetic-monitor/run", { preHandler: guard }, async () => {
      const result = await runner.run();
      return ok(result);
    });

    app.get("/internal/synthetic-monitor/status", { preHandler: guard }, async () => {
      const last = runner.getLast();
      return ok(last ?? { status: "never_run" });
    });
  };
