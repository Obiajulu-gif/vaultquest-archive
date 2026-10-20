import { SearchIndexService } from "./services/search/searchIndexService.js";
import { SearchIndexRepairService } from "./services/search/searchIndexRepairService.js";
import { searchRoutes } from "./routes/search.js";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import rateLimit from "@fastify/rate-limit";
import correlation from "./middleware/correlation.js";
import prometheusPlugin from "./middleware/prometheusPlugin.js";
import { LedgerService } from "./services/ledger.js";
import { SavedPoolsService } from "./services/savedPools.js";
import { SchemaVersionService } from "./services/schemaVersionService.js";
import { AuditService } from "./services/auditService.js";
import { actionsRoutes } from "./routes/actions.js";
import { savedPoolsRoutes } from "./routes/savedPools.js";
import { schemaVersionRoutes } from "./routes/schemaVersion.js";
import { auditRoutes } from "./routes/audit.js";
import { internalRoutes } from "./routes/internal.js";
import { TransactionTraceService } from "./services/transactionTrace.js";
import { reconciliationRoutes } from "./routes/reconciliation.js";
import { metricsRoutes } from "./routes/metrics.js";
import { usersRoutes } from "./routes/users.js";
import { prometheusRoutes } from "./routes/prometheus.js";
import { healthRoutes } from "./routes/health.js";
import type { DegradedModeService } from "./services/degradedModeService.js";
import { DegradedModeService } from "./services/degradedModeService.js";
import {
  DependencyMatrixValidator,
  validateDependencyMatrixOnStartup,
} from "./services/dependencyMatrixValidator.js";
import { MetricsService } from "./services/metricsService.js";
import { DrawProofService } from "./services/drawProofService.js";
import { FEATURE_FLAGS, FeatureFlagService } from "./services/featureFlagService.js";
import {
  FeatureFlagRolloutGuard,
  PrismaFlagRolloutStore,
  withdrawalSubmissionsHaltedCheck,
} from "./services/featureFlagRollout.js";
import { featureFlagRolloutRoutes } from "./routes/featureFlagRollouts.js";
import { drawProofRoutes } from "./routes/drawProofs.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { csrfProtection } from "./middleware/csrfProtection.js";
import { etagPlugin } from "./middleware/etag.js";
import { requireApiKey } from "./middleware/api-key-auth.js";
import { createLogger } from "./logger.js";
import { ok } from "./responses.js";
import type { Logger } from "pino";
import type { CacheService } from "./services/cacheService.js";
import { walletAuthRoutes } from "./routes/walletAuth.js";
import { WalletAuthService } from "./services/walletAuth.js";
import { requirePermission, walletSessionResolver } from "./middleware/rbac.js";
import { transactionMetricsRoutes } from "./routes/transactionMetrics.js";
import { CategoryService } from "./services/categoryService.js";
import { categoriesRoutes } from "./routes/categories.js";
import { NotificationService } from "./services/notificationService.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { DashboardAggregateService } from "./services/dashboardAggregateService.js";
import { dashboardAggregatesRoutes } from "./routes/dashboardAggregates.js";
import { EmailService } from "./services/emailService.js";
import { DataExportService } from "./services/dataExport.js";
import { DataImportService } from "./services/dataImport.js";
import { exportsRoutes } from "./routes/exports.js";
import { importsRoutes } from "./routes/imports.js";
import { permissionPreviewRoutes } from "./routes/permissionPreview.js";
import { SensitiveFieldAccessLogger } from "../../lib/sensitive-field-access.js";
import { OperationalHealthService } from "./services/operationalHealthService.js";
import { operationalHealthRoutes } from "./routes/operationalHealth.js";
import { privacyAnalyticsRoutes } from "./routes/privacyAnalytics.js";
import { TrendAggregationService } from "./services/trendAggregationService.js";
import { trendAggregationRoutes } from "./routes/trendAggregation.js";
import { IdempotencyService } from "./services/idempotencyService.js";
import {
  ImpersonationService,
  InMemoryImpersonationStore,
} from "./services/impersonation.js";
import { impersonationRoutes } from "./routes/impersonation.js";
import { createImpersonationHook } from "./middleware/impersonation.js";
import {
  CapabilityTokenService,
  type CapabilityTokenStore,
} from "./services/capabilityTokenService.js";
import { capabilityRoutes } from "./routes/capabilityTokens.js";
import {
  ResumableRepairEngine,
  PrismaRepairDataSource,
} from "./services/resumableRepairJob.js";
import { PartialFailureService } from "./services/partialFailureService.js";
import { partialFailureRoutes } from "./routes/partialFailures.js";
import { cacheRepairRoutes } from "./routes/cacheRepair.js";
import { policyDryRunRoutes } from "./routes/policyDryRun.js";
import { SecurityRevocationService } from "./services/securityRevocationService.js";
import { securityRevocationRoutes } from "./routes/securityRevocation.js";

import { configureTelemetry } from "./services/telemetry.js";
import { type JobStore } from "./worker/jobStore.js";
import { JobQueue, JobWorker } from "./worker/jobWorker.js";
import {
  JOB_TYPES,
  createJobHandlers,
  drawProofJobKey,
} from "./worker/handlers.js";
import { jobsRoutes } from "./routes/jobs.js";
import { ReceiptService, StellarReceiptSigner } from "./services/receipts.js";
import {
  AuditTrailService,
  type AuditTrailStore,
} from "./services/auditTrail.js";
import {
  OperationLimitService,
  resolveOperationPolicies,
  RedisLimitCounterStore,
  InMemoryLimitCounterStore,
  type RedisLikeClient,
} from "./services/operationLimits.js";
import {
  PrismaAuditTrailStore,
  PrismaReceiptStore,
  PrismaRecoveryCaseStore,
  PrismaLimitOverrideStore,
  prismaReceiptActionSource,
  prismaPendingActionSource,
  ledgerRecoveryAdapter,
} from "./services/governanceStores.js";
import {
  operationLimitsHook,
  bodyWallet,
  enforceOperationLimit,
  chainPreHandlers,
} from "./middleware/operationLimit.js";
import { PendingRecoveryService } from "./services/pendingRecovery.js";
import { receiptsRoutes } from "./routes/receipts.js";
import { recoveryRoutes } from "./routes/recovery.js";
import { auditTrailRoutes } from "./routes/auditTrail.js";
import { operationLimitsRoutes } from "./routes/operationLimits.js";
import {
  WebhookService,
  PrismaWebhookEventStore,
  InMemoryWebhookEventStore,
  type WebhookEventStore,
} from "./services/webhookService.js";
import { webhooksRoutes, type WebhookHandlerHooks } from "./routes/webhooks.js";
import { LeaseService } from "./services/leaseService.js";
import { sorobanNativeXdrDecoder } from "./services/stellarIndexer.js";
import {
  LeaseIndexerFence,
  PrismaProjectionRebuildStore,
  PrismaProjectionTarget,
  ProjectionRebuildService,
} from "./services/projectionRebuild.js";
import { projectionRebuildRoutes } from "./routes/projectionRebuilds.js";
import { MaintainerNotesService } from "./services/maintainerNotes.js";
import { FailureEscalationService } from "./services/failureEscalation.js";
import { maintainerOperationsRoutes, startMaintainerOperations } from "./routes/maintainerOperations.js";

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
  adminWalletAddresses?: string[];
  /**
   * #771: when set, delayed/retryable work (draw-proof generation) runs on the
   * background worker instead of inline in request handlers.
   */
  jobStore?: JobStore;
  jobWorkerPollIntervalMs?: number;
  /** Comma-separated Soroban RPC endpoints used by dependency diagnostics. */
  sorobanRpcUrls?: string;
  searchIndexService?: SearchIndexService;
  searchIndexRepairService?: SearchIndexRepairService;
  degradedModeService?: DegradedModeService;
  jobQueue?: JobQueue;
  capabilityTokenService?: CapabilityTokenService;
  capabilityTokenSecret?: string;
  capabilityTokenStore?: CapabilityTokenStore;
  resumableRepairEngine?: ResumableRepairEngine;
  /** #989: the live indexer's VAULT_FACTORY_ADDRESS, so a projection rebuild replays registry events identically. */
  vaultFactoryAddress?: string;
};

declare module "fastify" {
  interface FastifyInstance {
    /** Present only when `jobStore` was provided; call `.start()` to begin polling. */
    jobWorker?: JobWorker;
    jobQueue?: JobQueue;
    /** Guarded feature-flag rollouts; call `record()` from flag-gated code paths. */
    flagRollouts: FeatureFlagRolloutGuard;
    searchIndexService?: SearchIndexService;
    searchIndexRepairService?: SearchIndexRepairService;
    webhookService?: WebhookService;
    capabilityTokenService?: CapabilityTokenService;
    resumableRepairEngine?: ResumableRepairEngine;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const loggerInstance = deps.logger || createLogger("silent");
  const sensitiveFields = new SensitiveFieldAccessLogger(undefined, (entry) => {
    loggerInstance.info(
      { event: "sensitive_field_access", ...entry },
      "sensitive field access",
    );
  });
  sensitiveFields.onAnomaly((anomaly) => {
    loggerInstance.warn(
      { event: "sensitive_access_anomaly", ...anomaly },
      "sensitive access anomaly",
    );
  });

  // Initialize DegradedModeService if not provided
  if (!deps.degradedModeService) {
    deps.degradedModeService = new DegradedModeService();
  }

  const app = Fastify({
    // Fastify 5 passes logger instances via `loggerInstance`; `logger` only
    // accepts a configuration object (FSTDEP / fastify@5 breaking change).
    loggerInstance: loggerInstance as any,
    disableRequestLogging: true,
  });

  // #770: operation telemetry events share the app logger.
  configureTelemetry({ logger: loggerInstance });

  // Register global rate limiting with Redis store if available
  // Note: @fastify/rate-limit 11.x requires Fastify 5.x; skipped for Fastify 4.x (#567)
  const majorFastifyVersion = parseInt(
    (Fastify as unknown as { VERSION?: string }).VERSION?.split(".")[0] ?? "4",
    10,
  );
  if (majorFastifyVersion >= 5) {
    const rateLimitOptions: any = {
      global: true,
      max: 100,
      timeWindow: 60_000, // 1 minute
      keyGenerator(req: FastifyRequest) {
        return (
          req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
          req.ip
        );
      },
    };
    const redisClient = deps.cacheService?.redisClient;
    if (redisClient) {
      rateLimitOptions.redis = redisClient;
    }
    app.register(rateLimit, rateLimitOptions);
  }

  // Register CSRF protection middleware
  app.register(csrfProtection);

  // Register ETag and Cache-Control middleware
  app.register(etagPlugin);

  // Register correlation ID middleware
  app.register(correlation);

  // Register Prometheus metrics plugin
  app.register(prometheusPlugin);

  // Structured Logging for incoming requests and performance duration
  app.addHook("onRequest", async (req, reply) => {
    (req.raw as any).tempStartTime = performance.now();
    const route = req.routeOptions?.url ?? "unmatched";
    req.log.info(
      {
        event: "request_incoming",
        method: req.method,
        url: route,
        correlation_id: req.correlationId,
      },
      "Incoming request",
    );
  });

  app.addHook("onResponse", async (req, reply) => {
    const startTime = (req.raw as any).tempStartTime || performance.now();
    const duration = performance.now() - startTime;
    const route = req.routeOptions?.url ?? "unmatched";
    req.log.info(
      {
        event: "request_completed",
        method: req.method,
        url: route,
        correlation_id: req.correlationId,
        status_code: reply.statusCode,
        duration_ms: Math.round(duration * 100) / 100,
      },
      "Request completed",
    );
  });

  // Inject CacheService into LedgerService
  const svc = new LedgerService(deps.prisma, deps.cacheService);
  const idempotencySvc = new IdempotencyService(deps.prisma);
  const savedPoolsSvc = new SavedPoolsService(
    deps.prisma,
    deps.cacheService,
    deps.categoriesCacheTtlSeconds,
    idempotencySvc,
  );
  const metricsSvc = new MetricsService(deps.prisma);

  // Feature flag service for runtime toggles
  const featureFlagSvc = new FeatureFlagService(deps.prisma);
  // Guarded rollouts: scoped enablement, outcome monitoring, automatic
  // rollback and rollback verification (docs/FEATURE_FLAGS.md).
  const flagRollouts = new FeatureFlagRolloutGuard({
    store: new PrismaFlagRolloutStore(deps.prisma),
    flags: featureFlagSvc,
    autoReverify: true,
    checks: {
      [FEATURE_FLAGS.WITHDRAWAL_SUBMISSION_ENABLED]: [
        withdrawalSubmissionsHaltedCheck((since, wallet) =>
          deps.prisma.actionLedger.count({
            where: { actionType: "withdraw", submittedAt: { gte: since }, ...(wallet ? { walletAddress: wallet } : {}) },
          }),
        ),
      ],
    },
  });
  app.decorate("flagRollouts", flagRollouts);
  app.addHook("onClose", async () => flagRollouts.close());

  const drawProofSvc = new DrawProofService(
    deps.prisma,
    null,
    deps.logger,
    featureFlagSvc,
  );
  const schemaVersionSvc = new SchemaVersionService(deps.prisma);
  const auditSvc = new AuditService(deps.prisma);

  const jobQueue =
    deps.jobQueue ||
    (deps.jobStore ? new JobQueue({ store: deps.jobStore }) : undefined);
  if (jobQueue) {
    const worker = new JobWorker({
      queue: jobQueue,
      handlers: createJobHandlers({
        drawProofs: drawProofSvc,
        cacheRepair: null as any,
      }),
      logger: loggerInstance,
      pollIntervalMs: deps.jobWorkerPollIntervalMs,
    });
    app.decorate("jobQueue", jobQueue);
    app.decorate("jobWorker", worker);
    app.addHook("onClose", async () => {
      await worker.stop();
    });
  }

  svc.onActionConfirmed((actionId, actionType) => {
    if (actionType !== "select_winner") return;
    if (jobQueue) {
      // Retryable and observable: failures land in the dead-letter state with context.
      jobQueue
        .enqueue({
          type: JOB_TYPES.DRAW_PROOF_GENERATE,
          payload: { actionId },
          idempotencyKey: drawProofJobKey(actionId),
        })
        .catch((err) => {
          deps.logger?.error(
            { err, actionId },
            "failed to enqueue draw proof job",
          );
        });
      return;
    }
    drawProofSvc.generateProof({ actionId }).catch((err) => {
      deps.logger?.error({ err, actionId }, "draw proof generation failed");
    });
  });

  // API key guard for external-service endpoints (#273).
  // Guard is a no-op when apiKey is undefined (local dev without configuration).
  const apiKeyGuard = requireApiKey(deps.apiKey);

  // ── #812–#815 ───────────────────────────────────────────────────────────
  // One shared, hash-chained audit trail (#814). Access changes, recovery
  // transitions (#813) and limit overrides (#815) are all written to it.
  const auditTrail = new AuditTrailService(
    deps.auditTrailStore ?? new PrismaAuditTrailStore(deps.prisma),
  );

  // #815: counters live in Redis when available so every replica enforces
  // the same limits; otherwise per process.
  const redisForLimits = deps.cacheService?.redisClient as unknown as
    | RedisLikeClient
    | null
    | undefined;
  const operationLimits = new OperationLimitService({
    policies: resolveOperationPolicies(deps.operationLimits),
    counters: redisForLimits
      ? new RedisLimitCounterStore(redisForLimits)
      : new InMemoryLimitCounterStore(),
    overrides: new PrismaLimitOverrideStore(deps.prisma),
    audit: auditTrail,
  });
  // Public routes without a permission guard are limited here (method +
  // route pattern); guarded routes chain enforceOperationLimit after the guard.
  app.addHook(
    "preHandler",
    operationLimitsHook(operationLimits, [
      {
        method: "POST",
        url: "/actions",
        operation: "action.create",
        walletHint: bodyWallet("wallet_address"),
      },
      {
        method: "POST",
        url: "/wallet-auth/challenge",
        operation: "wallet_auth.challenge",
      },
    ]),
  );

  // #812: signed receipts for critical operations.
  const receiptSvc = new ReceiptService({
    store: new PrismaReceiptStore(deps.prisma),
    signer: deps.receiptSigningSecret
      ? StellarReceiptSigner.fromSecret(deps.receiptSigningSecret)
      : StellarReceiptSigner.ephemeral(),
    actions: prismaReceiptActionSource(deps.prisma),
    previousKeyIds: deps.receiptPreviousPublicKeys,
  });
  if (receiptSvc.ephemeralKey) {
    loggerInstance.warn(
      { keyId: receiptSvc.keyId },
      "RECEIPT_SIGNING_SECRET is not set: receipts are signed with an ephemeral key and stop verifying after a restart",
    );
  }

  // #813: stuck pending-action recovery.
  const recoverySvc = new PendingRecoveryService({
    store: new PrismaRecoveryCaseStore(deps.prisma),
    actions: prismaPendingActionSource(deps.prisma),
    ledger: ledgerRecoveryAdapter(svc),
    audit: auditTrail,
    staleAfterMs: deps.pendingStaleThresholdMs,
    maxAttempts: deps.recoveryMaxAttempts,
  });

  const walletAuthSvc = new WalletAuthService(deps.prisma, auditTrail);
  const walletPrincipal = walletSessionResolver(
    walletAuthSvc,
    deps.adminWalletAddresses ?? [],
  );
  const categorySvc = new CategoryService(
    deps.prisma,
    deps.cacheService,
    deps.categoriesCacheTtlSeconds,
  );
  const notificationSvc = new NotificationService(
    deps.prisma,
    deps.reminderLeadHours,
    idempotencySvc,
  );
  const dashboardAggregateSvc = new DashboardAggregateService(deps.prisma);
  const operationalHealthSvc = new OperationalHealthService(deps.prisma);
  const trendAggregationSvc = new TrendAggregationService(deps.prisma);

  // Register routes (healthRoutes already includes /health endpoint)
  app.register(
    actionsRoutes(svc, apiKeyGuard, {
      onActionChanged: (action) => receiptSvc.issueForAction(action),
    }),
  );
  app.register(walletAuthRoutes(walletAuthSvc));
  app.register(
    healthRoutes(
      svc,
      {
        prisma: deps.prisma,
        cacheService: deps.cacheService,
        rpcUrls: deps.sorobanRpcUrls,
      },
      deps.degradedModeService,
    ),
  );
  app.register(
    savedPoolsRoutes(
      savedPoolsSvc,
      requirePermission("own.data.write", [walletPrincipal]),
    ),
  );
  app.register(schemaVersionRoutes(schemaVersionSvc));
  app.register(
    internalRoutes(
      svc,
      deps.internalSecret,
      new TransactionTraceService(deps.prisma),
      { onReconciled: (txHash) => receiptSvc.issueForTxHash(txHash) },
    ),
  );
  app.register(reconciliationRoutes(deps.prisma, deps.internalSecret));
  if (deps.cacheService) {
    app.register(cacheRepairRoutes(deps.cacheService, deps.internalSecret));
  }
  app.register(
    operationalHealthRoutes(operationalHealthSvc, deps.internalSecret),
  );
  app.register(privacyAnalyticsRoutes(deps.prisma, deps.internalSecret));
  const resumableRepair =
    deps.resumableRepairEngine ??
    new ResumableRepairEngine({
      dataSource: new PrismaRepairDataSource(deps.prisma),
    });
  app.decorate("resumableRepairEngine", resumableRepair);
  if (jobQueue) {
    app.register(
      jobsRoutes(
        jobQueue,
        deps.internalSecret,
        undefined,
        undefined,
        resumableRepair,
      ),
    );
  }
  app.register(usersRoutes, {
    prefix: "/api/users",
    prisma: deps.prisma,
    accessLogger: sensitiveFields,
  });
  app.register(metricsRoutes(metricsSvc, apiKeyGuard));
  app.register(prometheusRoutes);
  app.register(drawProofRoutes(drawProofSvc));
  app.register(transactionMetricsRoutes(deps.prisma, apiKeyGuard));
  app.register(categoriesRoutes(categorySvc, apiKeyGuard));
  app.register(notificationsRoutes(notificationSvc));
  app.register(
    auditRoutes(auditSvc, {
      read: requirePermission("admin.audit.read", [walletPrincipal]),
      write: requirePermission("admin.audit.write", [walletPrincipal]),
      export: requirePermission("admin.audit.export", [walletPrincipal]),
    }),
  );
  app.register(dashboardAggregatesRoutes(dashboardAggregateSvc, apiKeyGuard));
  app.register(trendAggregationRoutes(trendAggregationSvc, apiKeyGuard));

  // Permission-aware search indexing & repair (#802)
  const searchIndexSvc = deps.searchIndexService || new SearchIndexService();
  const searchRepairSvc =
    deps.searchIndexRepairService ||
    new SearchIndexRepairService(deps.prisma, searchIndexSvc, loggerInstance);
  app.decorate("searchIndexService", searchIndexSvc);
  app.decorate("searchIndexRepairService", searchRepairSvc);
  app.register(
    searchRoutes(
      searchIndexSvc,
      searchRepairSvc,
      [walletPrincipal],
      requirePermission("admin.audit.write", [walletPrincipal]),
    ),
  );

  // Wallet-scoped data portability (#772, #773). Authorization is enforced by
  app.register(
    permissionPreviewRoutes(
      requirePermission("admin.audit.write", [walletPrincipal]),
    ),
  );
  // the permission guards and by the services' own wallet-scope checks.
  const exportSvc = new DataExportService(
    {
      listActions: ({ walletAddress, cursor, limit }) =>
        svc.listActions({ walletAddress, cursor, limit }),
      listSavedPools: (wallet, cursor, limit) =>
        savedPoolsSvc.listSavedPools(wallet, cursor, limit),
    },
    sensitiveFields,
  );
  app.register(
    exportsRoutes(
      exportSvc,
      chainPreHandlers(
        requirePermission(
          "own.data.export",
          [walletPrincipal],
          sensitiveFields,
        ),
        enforceOperationLimit(operationLimits, "data.export"),
      ),
    ),
  );
  app.register(
    importsRoutes(
      new DataImportService(savedPoolsSvc),
      chainPreHandlers(
        requirePermission("own.data.import", [walletPrincipal]),
        enforceOperationLimit(operationLimits, "data.import"),
      ),
    ),
  );

  // #812–#815 routes. Every privileged route re-checks permissions server-side.
  app.register(
    receiptsRoutes(receiptSvc, {
      read: requirePermission("own.receipts.read", [walletPrincipal]),
      admin: requirePermission("admin.receipts.read", [walletPrincipal]),
      verifyLimit: enforceOperationLimit(operationLimits, "receipt.verify"),
    }),
  );
  app.register(
    recoveryRoutes(recoverySvc, {
      ownRead: requirePermission("own.data.read", [walletPrincipal]),
      ownRetry: chainPreHandlers(
        requirePermission("own.data.read", [walletPrincipal]),
        enforceOperationLimit(operationLimits, "recovery.retry"),
      ),
      adminRead: requirePermission("admin.recovery.read", [walletPrincipal]),
      adminWrite: requirePermission("admin.recovery.write", [walletPrincipal]),
    }),
  );
  app.register(
    auditTrailRoutes(auditTrail, {
      read: requirePermission("admin.audit_trail.read", [walletPrincipal]),
      export: chainPreHandlers(
        requirePermission("admin.audit_trail.export", [walletPrincipal]),
        enforceOperationLimit(operationLimits, "audit.export"),
      ),
    }),
  );
  app.register(
    featureFlagRolloutRoutes(flagRollouts, {
      read: requirePermission("admin.flags.read", [walletPrincipal]),
      write: requirePermission("admin.flags.write", [walletPrincipal]),
    }),
  );
  app.register(
    operationLimitsRoutes(operationLimits, {
      read: requirePermission("admin.limits.read", [walletPrincipal]),
      write: requirePermission("admin.limits.write", [walletPrincipal]),
    }),
  );

  // #791: scoped maintainer impersonation.
  const impersonationSvc = new ImpersonationService({
    store: deps.impersonationStore ?? new InMemoryImpersonationStore(),
    audit: auditTrail,
  });
  app.addHook("onRequest", createImpersonationHook(impersonationSvc));
  app.register(
    impersonationRoutes(impersonationSvc, {
      read: requirePermission("admin.impersonation.read", [walletPrincipal]),
      write: requirePermission("admin.impersonation.write", [walletPrincipal]),
    }),
  );

  // #793: partial failure dashboard.
  const maintainerNotes = new MaintainerNotesService(deps.prisma);
  const failureEscalations = new FailureEscalationService(deps.prisma);
  app.register(maintainerOperationsRoutes(maintainerNotes, failureEscalations, {
    read: requirePermission("admin.recovery.read", [walletPrincipal]),
    write: requirePermission("admin.recovery.write", [walletPrincipal]),
  }));
  let stopMaintainerOperations: (() => Promise<void>) | undefined;
  app.addHook("onReady", async () => {
    stopMaintainerOperations = startMaintainerOperations(maintainerNotes, failureEscalations,
      (err) => app.log.error({ err }, "maintainer operations tick failed"));
  });
  app.addHook("onClose", async () => { await stopMaintainerOperations?.(); });
  const partialFailureSvc = new PartialFailureService(deps.prisma, auditTrail);
  app.register(
    partialFailureRoutes(partialFailureSvc, {
      read: requirePermission("admin.recovery.read", [walletPrincipal]),
      write: requirePermission("admin.recovery.write", [walletPrincipal]),
    }),
  );

  // #989: versioned projection rebuild from the stored chain event log. Its
  // LedgerService shares the live cache (checkpoint) but registers no
  // onActionConfirmed callback: replay rebuilds projections, not side effects.
  const projectionRebuildSvc = new ProjectionRebuildService({
    runs: new PrismaProjectionRebuildStore(deps.prisma),
    target: new PrismaProjectionTarget(deps.prisma, new LedgerService(deps.prisma, deps.cacheService), {
      decoder: sorobanNativeXdrDecoder,
      factoryAddress: deps.vaultFactoryAddress,
      logger: loggerInstance,
    }),
    fence: new LeaseIndexerFence(new LeaseService(deps.prisma)),
    audit: auditTrail,
    logger: loggerInstance,
  });
  app.register(
    projectionRebuildRoutes(projectionRebuildSvc, {
      read: requirePermission("admin.recovery.read", [walletPrincipal]),
      write: requirePermission("admin.recovery.write", [walletPrincipal]),
    }),
  );

  // #984: Expiring capability tokens for sensitive actions.
  const capabilitySvc =
    deps.capabilityTokenService ??
    new CapabilityTokenService({
      secretKey: deps.capabilityTokenSecret ?? deps.internalSecret,
      store: deps.capabilityTokenStore,
    });
  app.decorate("capabilityTokenService", capabilitySvc);
  app.register(capabilityRoutes, { capabilityService: capabilitySvc });

  // #799: signed webhook verification and replay-window enforcement.
  const webhookStore =
    deps.webhookEventStore ?? new PrismaWebhookEventStore(deps.prisma);
  const webhookSvc =
    deps.webhookService ??
    new WebhookService({
      store: webhookStore,
      secrets: {
        internal: deps.webhookSecret ?? deps.internalSecret,
        stripe: deps.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET,
        stellarPublicKey:
          deps.stellarWebhookPublicKey ??
          process.env.STELLAR_WEBHOOK_PUBLIC_KEY,
        custom: deps.webhookSecret ?? deps.internalSecret,
      },
      defaultToleranceSeconds: deps.webhookToleranceSeconds,
    });
  app.decorate("webhookService", webhookSvc);
  app.register(
    webhooksRoutes(
      webhookSvc,
      deps.webhookHooks ?? {
        onPrizeDraw: async (event) => {
          const poolId = event.payload?.data?.pool_id || event.payload?.pool_id;
          deps.logger?.info(
            { poolId, eventId: event.eventId },
            "Prize draw completed webhook received",
          );
        },
        onVaultDeposit: async (event) => {
          deps.logger?.info(
            { eventId: event.eventId },
            "Vault deposit webhook received",
          );
        },
      },
    ),
  );

  // Central Error Handler Middleware
  app.setErrorHandler(errorHandler);

  return app;
}
