import type { FastifyPluginAsync } from "fastify";
import type { OperationalHealthService } from "../services/operationalHealthService.js";
import { requirePermission, serviceSecretResolver } from "../middleware/rbac.js";
import { AppError } from "../errors.js";
import { ok } from "../responses.js";

export const HEALTH_CATEGORIES = [
  "Orphaned Actions",
  "Stale Pending Events",
  "Failed Background Jobs",
  "Unresolved Vault Settlements",
  "Pending Repair Proposals",
  "Poison Events",
] as const;

export type HealthCategory = (typeof HEALTH_CATEGORIES)[number];

export type HealthSeverity = "critical" | "warning" | "info";

export interface HealthCategoryDetail {
  category: HealthCategory;
  severity: HealthSeverity;
  total: number;
  items: Array<Record<string, unknown>>;
}

const CATEGORY_SEVERITY: Record<HealthCategory, HealthSeverity> = {
  "Orphaned Actions": "critical",
  "Stale Pending Events": "warning",
  "Failed Background Jobs": "critical",
  "Unresolved Vault Settlements": "critical",
  "Pending Repair Proposals": "warning",
  "Poison Events": "critical",
};

/**
 * Redacts sensitive identifiers (wallet addresses, keys, secrets)
 * while keeping the first/last characters for correlation.
 */
export const redactSensitive = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (s.length <= 8) return "[redacted]";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

const SENSITIVE_KEYS = /(wallet|address|secret|key|token|signature)/i;

const redactRecord = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = SENSITIVE_KEYS.test(key) ? redactSensitive(value) : value;
  }
  return out;
};

/**
 * Maintainer dashboard routes for operational health monitoring.
 * All routes require internal service authentication.
 */
export const operationalHealthRoutes = (
  healthSvc: OperationalHealthService,
  secret: string
): FastifyPluginAsync =>
  async (app) => {
    const service = serviceSecretResolver(secret);
    const guard = (perm: Parameters<typeof requirePermission>[0]) =>
      requirePermission(perm, [service]);

    /**
     * GET /internal/health/report
     *
     * Returns comprehensive operational health report with:
     * - Overall system status (healthy/warning/critical)
     * - Health indicators with counts, severity, and actionable insights
     * - Investigation links (SQL queries) for each indicator
     *
     * Response includes sensitive query strings for maintainer investigation.
     * No sensitive user data is exposed in the report itself.
     */
    app.get("/internal/health/report", { preHandler: [guard("internal.health.read")] }, async (req) => {
      try {
        const report = await healthSvc.generateHealthReport();
        return ok(report);
      } catch (err) {
        req.log.error({ err }, "failed to generate health report");
        throw AppError.serverError("health report generation failed", String(err));
      }
    });

    /**
     * GET /internal/health/report/summary
     *
     * Lightweight summary for dashboard status indicator.
     * Returns only: overallStatus, totalIssues, criticalCount, warningCount
     * Useful for frontends that poll health frequently.
     */
    app.get(
      "/internal/health/report/summary",
      { preHandler: [guard("internal.health.read")] },
      async (req) => {
        try {
          const report = await healthSvc.generateHealthReport();
          return ok({
            timestamp: report.timestamp,
            overallStatus: report.overallStatus,
            totalIssues: report.summary.totalIssues,
            criticalCount: report.summary.criticalCount,
            warningCount: report.summary.warningCount,
          });
        } catch (err) {
          req.log.error({ err }, "failed to generate health summary");
          throw AppError.serverError("health summary generation failed", String(err));
        }
      }
    );

    /**
     * GET /internal/health/category/:category
     *
     * Drill-down into a specific health category.
     * Returns up to 50 detailed records for investigation.
     *
     * Supported categories:
     * - Orphaned Actions
     * - Stale Pending Events
     * - Failed Background Jobs
     * - Unresolved Vault Settlements
     * - Pending Repair Proposals
     * - Poison Events
     *
     * Records are paginated; sensitive PII (wallet addresses) is redacted
     * before returning to the client.
     */
    app.get(
      "/internal/health/category/:category",
      { preHandler: [guard("internal.health.read")] },
      async (req) => {
        const { category } = req.params as { category: string };

        if (!HEALTH_CATEGORIES.includes(category as HealthCategory)) {
          throw AppError.validation(`invalid category: ${category}`);
        }

        try {
          const details = await healthSvc.getHealthCategoryDetails(category);
          return ok({
            category,
            severity: CATEGORY_SEVERITY[category as HealthCategory],
            total: details.total,
            items: details.items.map(redactRecord),
          });
        } catch (err) {
          req.log.error({ err, category }, "failed to fetch category details");
          throw AppError.serverError("category details fetch failed", String(err));
        }
      }
    );
  };
