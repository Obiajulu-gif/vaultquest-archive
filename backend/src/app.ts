import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import correlation from "./middleware/correlation.js";
import prometheusPlugin from "./middleware/prometheusPlugin.js";
import { LedgerService } from "./services/ledger.js";
import { SavedPoolsService } from "./services/savedPools.js";
import { SchemaVersionService } from "./services/schemaVersionService.js";
import { actionsRoutes } from "./routes/actions.js";
import { savedPoolsRoutes } from "./routes/savedPools.js";
import { schemaVersionRoutes } from "./routes/schemaVersion.js";
import { internalRoutes } from "./routes/internal.js";
import { metricsRoutes } from "./routes/metrics.js";
import { usersRoutes } from "./routes/users.js";
import { prometheusRoutes } from "./routes/prometheus.js";
import { healthRoutes } from "./routes/health.js";
import { MetricsService } from "./services/metricsService.js";
import { DrawProofService } from "./services/drawProofService.js";
import { drawProofRoutes } from "./routes/drawProofs.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { requireApiKey } from "./middleware/api-key-auth.js";
import { createLogger } from "./logger.js";
import { ok } from "./responses.js";
import type { Logger } from "pino";
import type { CacheService } from "./services/cacheService.js";
import { walletAuthRoutes } from "./routes/walletAuth.js";
import { WalletAuthService } from "./services/walletAuth.js";
import { transactionMetricsRoutes } from "./routes/transactionMetrics.js";
import { CategoryService } from "./services/categoryService.js";
import { categoriesRoutes } from "./routes/categories.js";
import { NotificationService } from "./services/notificationService.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { EmailService } from "./services/emailService.js";

export type AppDeps = {
  prisma: PrismaClient;
  internalSecret: string;
  /** API key for external-service endpoints (issue #273). Undefined disables enforcement. */
  apiKey?: string;
  logger?: Logger;
  cacheService?: CacheService;
  /** TTL (seconds) for the GET /api/categories cache entry (issue #485). */
  categoriesCacheTtlSeconds?: number;
  /** Reminder lead time (hours) for notification generation (issue #446). */
  reminderLeadHours?: number;
  emailService?: EmailService;
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
  app.addHook("onRequest", async (req, reply) => {
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
  const drawProofSvc = new DrawProofService(deps.prisma, null, deps.logger);
  const schemaVersionSvc = new SchemaVersionService(deps.prisma);

  svc.onActionConfirmed((actionId, actionType) => {
    if (actionType === "select_winner") {
      drawProofSvc.generateProof({ actionId }).catch((err) => {
        deps.logger?.error({ err, actionId }, "draw proof generation failed");
      });
    }
  });

  // API key guard for external-service endpoints (#273).
  // Guard is a no-op when apiKey is undefined (local dev without configuration).
  const apiKeyGuard = requireApiKey(deps.apiKey);

  const walletAuthSvc = new WalletAuthService(deps.prisma);
  const categorySvc = new CategoryService(deps.prisma, deps.cacheService, deps.categoriesCacheTtlSeconds);
  const notificationSvc = new NotificationService(deps.prisma, deps.reminderLeadHours);

  app.get("/health", async () => ok({ ok: true }));
  app.get("/health/indexer", async () => {
    const health = await svc.getIndexerHealth();
    return ok(health);
  });

  app.register(actionsRoutes(svc, apiKeyGuard));
  app.register(walletAuthRoutes(walletAuthSvc));
  app.register(healthRoutes(svc));
  app.register(savedPoolsRoutes(savedPoolsSvc));
  app.register(schemaVersionRoutes(schemaVersionSvc));
  app.register(internalRoutes(svc, deps.internalSecret));
  app.register(metricsRoutes(metricsSvc));
  app.register(usersRoutes, { prefix: "/api/users", prisma: deps.prisma });
  app.register(metricsRoutes(metricsSvc, apiKeyGuard));
  app.register(prometheusRoutes);
  app.register(drawProofRoutes(drawProofSvc));
  app.register(transactionMetricsRoutes(deps.prisma, apiKeyGuard));
  app.register(categoriesRoutes(categorySvc, apiKeyGuard));
  app.register(notificationsRoutes(notificationSvc));

  // Central Error Handler Middleware
  app.setErrorHandler(errorHandler);

  return app;
}
