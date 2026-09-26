import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { getPrometheusMetrics } from "../services/prometheusMetrics.js";

/**
 * Fastify plugin that automatically records HTTP metrics for Prometheus
 */
const prometheusPlugin: FastifyPluginAsync = async (app) => {
  const metrics = getPrometheusMetrics(app.log);

  // Record request start time and route
  app.addHook("onRequest", async (req) => {
    (req as any).prometheusStartTime = performance.now();
    (req as any).prometheusRoute = req.url.split("?")[0]; // Remove query params
  });

  // Record request metrics on response
  app.addHook("onResponse", async (req, reply) => {
    const startTime = (req as any).prometheusStartTime || performance.now();
    const route = (req as any).prometheusRoute || req.url;
    const duration = (performance.now() - startTime) / 1000; // Convert to seconds

    let method = req.method;
    let statusCode = reply.statusCode;

    // Normalize method and route for better metrics
    method = method.toUpperCase();

    // Skip recording metrics for /metrics endpoint itself
    if (route === "/metrics") {
      return;
    }

    // Get request and response sizes if available
    const requestContentLength = req.headers["content-length"]
      ? parseInt(req.headers["content-length"], 10)
      : undefined;

    const responseContentLength = reply.getHeader("content-length")
      ? parseInt(reply.getHeader("content-length") as string, 10)
      : undefined;

    metrics.recordHttpRequest(
      method,
      route,
      statusCode,
      duration,
      requestContentLength,
      responseContentLength,
    );
  });
};

export default prometheusPlugin;
