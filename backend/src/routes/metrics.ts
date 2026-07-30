import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import type { MetricsService } from "../services/metricsService.js";

export const metricsRoutes = (
  svc: MetricsService,
  apiKeyGuard: preHandlerHookHandler
): FastifyPluginAsync => {
  return async (app) => {
    app.get("/api/metrics", { preHandler: apiKeyGuard }, async (req, reply) => {
      const summary = await svc.getProtocolSummary();
      return reply.send({ ok: true, data: summary });
    });

    app.get("/api/metrics/aggregate", { preHandler: apiKeyGuard }, async (req, reply) => {
      const metrics = await svc.getAggregateProtocolMetrics();
      return reply.send({
        ok: true,
        data: metrics,
        meta: {
          generated_at: metrics.timestamp,
          freshness: metrics.dataFreshness,
        },
      });
    });

    app.get("/api/metrics/round", { preHandler: apiKeyGuard }, async (req, reply) => {
      const roundData = await svc.getCurrentRoundStatus();
      return reply.send({ ok: true, data: roundData });
    });

    app.get("/api/metrics/history", { preHandler: apiKeyGuard }, async (req, reply) => {
      const history = await svc.getHistoricalSummary();
      return reply.send({ ok: true, data: history });
    });
  };
};
