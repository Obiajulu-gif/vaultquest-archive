import type { FastifyPluginAsync } from "fastify";
import { getPrometheusMetrics } from "../services/prometheusMetrics.js";

/**
 * Prometheus metrics endpoint
 * Exposes metrics in the OpenMetrics text format
 */
export const prometheusRoutes: FastifyPluginAsync = async (app) => {
  const metrics = getPrometheusMetrics(app.log);

  app.get(
    "/metrics",
    {
      // Disable rate limiting for metrics endpoint to allow frequent scrapes
      config: { rateLimit: false },
    },
    async (req, reply) => {
      try {
        const metricsOutput = await metrics.metrics();
        reply.type(metrics.getContentType());
        return reply.send(metricsOutput);
      } catch (err) {
        app.log.error(err, "Failed to generate metrics");
        reply.status(500);
        return reply.send({ error: "Failed to generate metrics" });
      }
    },
  );
};
