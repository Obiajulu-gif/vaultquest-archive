import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import correlation from "./middleware/correlation.js";
import prometheusPlugin from "./middleware/prometheusPlugin.js";
import { LedgerService } from "./services/ledger.js";
import { SavedPoolsService } from "./services/savedPools.js";
import { actionsRoutes } from "./routes/actions.js";
import { savedPoolsRoutes } from "./routes/savedPools.js";
import { internalRoutes } from "./routes/internal.js";
import { metricsRoutes } from "./routes/metrics.js";
import { prometheusRoutes } from "./routes/prometheus.js";
import { healthRoutes } from "./routes/health.js";
import { MetricsService } from "./services/metricsService.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { requireApiKey } from "./middleware/api-key-auth.js";
import { createLogger } from "./logger.js";
import type { Logger } from "pino";
import type { CacheService } from "./services/cacheService.js";

export type AppDeps = {
  prisma: PrismaClient;
  internalSecret: string;
  /** API key for external-service endpoints (issue #273). Undefined disables enforcement. */
  apiKey?: string;
  logger?: Logger;
  cacheService?: CacheService;
};

export function buildApp(deps: AppDeps): FastifyInstance {
  const loggerInstance = deps.logger || createLogger("silent");
  const app = Fastify({
    logger: loggerInstance as any,
    disableRequestLogging: true,
  });

  // Register rate limiting and CSRF protection
  app.register(rateLimiter);

  // Register correlation ID middleware
  app.register(correlation);

  // Register Prometheus metrics plugin
  app.register(prometheusPlugin);

  // Structured Logging for incoming requests and performance duration
  app.addHook("onRequest", async (req) => {
    (req.raw as any).tempStartTime = performance.now();
    req.log.info(
      {
        event: "request_incoming",
        method: req.method,
        url: req.url,
        correlation_id: req.correlationId,
        ip: req.ip,
      },
      `Incoming request: ${req.method} ${req.url}`,
    );
  });

  app.addHook("onResponse", async (req, reply) => {
    const startTime = (req.raw as any).tempStartTime || performance.now();
    const duration = performance.now() - startTime;
    req.log.info(
      {
        event: "request_completed",
        method: req.method,
        url: req.url,
        correlation_id: req.correlationId,
        status_code: reply.statusCode,
        duration_ms: Math.round(duration * 100) / 100,
      },
      `Request completed: ${req.method} ${req.url} -> ${reply.statusCode} (${duration.toFixed(2)}ms)`,
    );
  });

  // Inject CacheService into LedgerService
  const svc = new LedgerService(deps.prisma, deps.cacheService);
  const savedPoolsSvc = new SavedPoolsService(deps.prisma);
  const metricsSvc = new MetricsService(deps.prisma);

  // API key guard for external-service endpoints (#273).
  // Guard is a no-op when apiKey is undefined (local dev without configuration).
  const apiKeyGuard = requireApiKey(deps.apiKey);

  app.register(actionsRoutes(svc, apiKeyGuard));
  app.register(healthRoutes(svc));
  app.register(savedPoolsRoutes(savedPoolsSvc));
  app.register(internalRoutes(svc, deps.internalSecret));
  app.register(metricsRoutes(metricsSvc, apiKeyGuard));
  app.register(prometheusRoutes);

  // Central Error Handler Middleware
  app.setErrorHandler(errorHandler);

  return app;
}
