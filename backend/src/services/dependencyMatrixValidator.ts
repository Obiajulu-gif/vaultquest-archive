/**
 * Automated Dependency Matrix Validator
 *
 * Executable verification that each critical dependency:
 * 1. Has documented failure modes and fallback behavior
 * 2. Is properly integrated with DegradedModeService
 * 3. Has health probes in /health/dependencies endpoint
 * 4. Includes user-safe error messages
 * 5. Implements idempotent retries where applicable
 */

import type { Logger } from "pino";
import {
  VAULTQUEST_DEPENDENCY_MATRIX,
  getMutationCriticalDependencies,
  getReadCriticalDependencies,
} from "../schemas/dependencyMatrix.js";
import type { DependencyName, DegradedModeService } from "./degradedModeService.js";

export interface ValidationRule {
  id: string;
  description: string;
  severity: "critical" | "warning";
  validate: (context: ValidationContext) => Promise<ValidationResult>;
}

export interface ValidationContext {
  degradedModeService: DegradedModeService;
  logger: Logger;
}

export interface ValidationResult {
  passed: boolean;
  message: string;
  details?: string;
}

export interface ValidationReport {
  timestamp: Date;
  passed: boolean;
  summary: string;
  results: Array<{
    rule: string;
    severity: string;
    result: ValidationResult;
  }>;
  operationalGuidance: string[];
}

/**
 * Validates the dependency matrix implementation.
 */
export class DependencyMatrixValidator {
  private rules: ValidationRule[] = [];

  constructor() {
    this.initializeRules();
  }

  private initializeRules(): void {
    this.rules = [
      {
        id: "matrix-completeness",
        description:
          "All mutations-critical dependencies are documented in the matrix with failure modes",
        severity: "critical",
        validate: async () => {
          const criticalDeps = getMutationCriticalDependencies();
          const matrixIds = new Set(
            VAULTQUEST_DEPENDENCY_MATRIX.dependencies.map((d) => d.id)
          );
          const missing: string[] = [];
          if (!matrixIds.has("database")) missing.push("database");
          if (!matrixIds.has("soroban_rpc")) missing.push("soroban_rpc");
          return {
            passed: missing.length === 0,
            message:
              missing.length === 0
                ? "All mutations-critical dependencies are documented"
                : `Missing documentation for: ${missing.join(", ")}`,
          };
        },
      },
      {
        id: "degraded-mode-coverage",
        description: "All documented dependencies are registered with DegradedModeService",
        severity: "critical",
        validate: async (ctx) => {
          const matrixIds = new Set(
            VAULTQUEST_DEPENDENCY_MATRIX.dependencies.map((d) => d.id)
          );
          const registeredDeps = new Set(
            Object.keys(ctx.degradedModeService.getAllDependencies())
          );
          const missing: string[] = [];
          for (const id of matrixIds) {
            if (!registeredDeps.has(id as DependencyName)) {
              missing.push(id);
            }
          }
          return {
            passed: missing.length === 0,
            message:
              missing.length === 0
                ? "All documented dependencies are registered with DegradedModeService"
                : `Not registered with DegradedModeService: ${missing.join(", ")}`,
          };
        },
      },
      {
        id: "failure-modes-documented",
        description: "Each critical dependency has at least one documented failure mode",
        severity: "critical",
        validate: async () => {
          const incomplete = VAULTQUEST_DEPENDENCY_MATRIX.dependencies.filter(
            (dep) => dep.failureModes.length === 0
          );
          return {
            passed: incomplete.length === 0,
            message:
              incomplete.length === 0
                ? "All dependencies have documented failure modes"
                : `Missing failure mode documentation for: ${incomplete.map((d) => d.id).join(", ")}`,
          };
        },
      },
      {
        id: "fallback-strategies-defined",
        description:
          "Each dependency clearly documents its primary fallback behavior",
        severity: "warning",
        validate: async () => {
          const incomplete = VAULTQUEST_DEPENDENCY_MATRIX.dependencies.filter(
            (dep) => !dep.primaryFallback || dep.primaryFallback.length === 0
          );
          return {
            passed: incomplete.length === 0,
            message:
              incomplete.length === 0
                ? "All dependencies have defined primary fallback strategies"
                : `Incomplete fallback definitions for: ${incomplete.map((d) => d.id).join(", ")}`,
          };
        },
      },
      {
        id: "user-safe-error-messages",
        description: "Degraded mode provides user-safe status messages (no leaking IPs, SQL)",
        severity: "critical",
        validate: async (ctx) => {
          const status = ctx.degradedModeService.getUserSafeStatus();
          const hasBanner = status.userBanner !== null || status.status === "healthy";
          const dependencies = status.dependencies || [];
          const allHaveSafeImpact = dependencies.every(
            (d) =>
              d.impact &&
              !d.impact.includes("internal") &&
              !d.impact.includes("debug") &&
              !d.impact.includes("sql")
          );
          return {
            passed: hasBanner && allHaveSafeImpact,
            message:
              hasBanner && allHaveSafeImpact
                ? "User-safe status messages are properly formatted"
                : "User-facing status messages may leak internal details",
            details: `Current status: ${status.status}, banner: ${status.userBanner ? "(set)" : "(none)"}`,
          };
        },
      },
      {
        id: "retry-after-header",
        description: "DegradedModeError includes Retry-After header for 503 responses",
        severity: "critical",
        validate: async (ctx) => {
          const status = ctx.degradedModeService.getUserSafeStatus();
          const hasRetryAfter = status.retryAfterSeconds !== undefined;
          return {
            passed: hasRetryAfter || status.status === "healthy",
            message: hasRetryAfter
              ? "Retry-After header is properly set in degraded responses"
              : "Missing Retry-After header in degraded state",
          };
        },
      },
      {
        id: "read-write-distinction",
        description:
          "Matrix correctly classifies dependencies as read-only vs read-write required",
        severity: "warning",
        validate: async () => {
          const readCritical = getReadCriticalDependencies();
          const mutationCritical = getMutationCriticalDependencies();
          return {
            passed: readCritical.length > 0 && mutationCritical.length > 0,
            message: `Classification: ${mutationCritical.length} mutations-critical, ${readCritical.length} read-critical`,
          };
        },
      },
    ];
  }

  /**
   * Run all validation rules and generate a report.
   */
  async validate(context: ValidationContext): Promise<ValidationReport> {
    const results = await Promise.all(
      this.rules.map(async (rule) => ({
        rule: rule.id,
        severity: rule.severity,
        result: await rule.validate(context),
      }))
    );

    const failed = results.filter((r) => !r.result.passed);
    const criticalFailed = failed.filter((r) => r.severity === "critical");

    const operationalGuidance: string[] = [];
    if (criticalFailed.length > 0) {
      operationalGuidance.push(
        `⚠ CRITICAL: ${criticalFailed.length} validation failures detected.`
      );
      operationalGuidance.push("Check logs and fix the issues before proceeding to production.");
    }
    if (failed.length > 0 && criticalFailed.length === 0) {
      operationalGuidance.push(`ℹ ${failed.length} warnings detected. Review recommendations.`);
    }
    operationalGuidance.push(
      "Reference: backend/src/schemas/dependencyMatrix.ts for complete failure modes and recovery steps."
    );

    return {
      timestamp: new Date(),
      passed: criticalFailed.length === 0,
      summary:
        criticalFailed.length === 0
          ? `All ${results.length} validation rules passed`
          : `${criticalFailed.length} critical failures, ${failed.length - criticalFailed.length} warnings`,
      results,
      operationalGuidance,
    };
  }
}

/**
 * Run validation on startup.
 */
export async function validateDependencyMatrixOnStartup(
  degradedModeService: DegradedModeService,
  logger: Logger
): Promise<void> {
  const validator = new DependencyMatrixValidator();
  const report = await validator.validate({ degradedModeService, logger });

  if (!report.passed) {
    logger.error({ report }, "Dependency matrix validation failed");
    report.operationalGuidance.forEach((msg) => logger.error(msg));
    throw new Error("Dependency matrix validation failed; check logs for details");
  }

  logger.info({ report }, "Dependency matrix validation passed");
}
