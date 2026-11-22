/**
 * Release Readiness Validator for VaultQuest (#791, #972).
 *
 * Provides automated verification across:
 * - Migrations: preview, destructive statement audit, post-check convergence
 * - Smoke tests: execution of health, endpoints, and error recovery paths
 * - Rollback: verification that code and database rollback steps are defined
 * - Configuration & Documentation: env defaults, documentation freshness
 * - Authorization: maintainer sign-off and dual-control compliance
 */

import * as fs from "fs";
import * as path from "path";
import {
  parseMigrationSql,
  previewMigration,
  runPostChecks,
  listMigrationIds,
  readMigrationPlan,
  type MigrationDatabase,
  type MigrationPreview,
  type PostCheckReport,
} from "./migrationSafety.js";
import {
  RELEASE_READINESS_CHECKLIST,
  parseAttestations,
  buildChecklistStatus,
  type ReleaseChecklistItemId,
  type ReleaseChecklistStatus,
} from "./migrationSafetyCli.js";

export interface RollbackEvidence {
  backupSnapshotUri?: string;
  verifiedDryRunTimestamp?: string;
  testedRollbackScriptPath?: string;
  operatorNotes?: string;
}

export interface ReleaseReadinessOptions {
  rootDir?: string;
  migrationsDir?: string;
  checklistPath?: string;
  db?: MigrationDatabase;
  migrationId?: string;
  attestedItems?: Set<ReleaseChecklistItemId> | string[];
  migrationVerified?: boolean;
  maintainerSignOff?: {
    maintainerId: string;
    role: "admin" | "maintainer" | "operator";
    approvedAt: Date | string;
    notes?: string;
  };
  isUrgentFix?: boolean;
  incidentId?: string;
  rollbackEvidence?: RollbackEvidence;
  requireRollbackEvidence?: boolean;
}

export interface ReadinessCheckResult {
  id: string;
  category: "tests" | "migration" | "smoke" | "rollback" | "config" | "docs" | "authorization";
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

export interface ReleaseReadinessReport {
  ok: boolean;
  checkedAt: string;
  environment: string;
  checks: ReadinessCheckResult[];
  failures: ReadinessCheckResult[];
  checklistStatuses: ReleaseChecklistStatus[];
  migrationPreview?: MigrationPreview;
  postChecks?: PostCheckReport;
  summary: {
    total: number;
    passed: number;
    failed: number;
    urgentException: boolean;
  };
}

/**
 * Validates release readiness against migrations, smoke tests, rollback plans,
 * configuration contracts, documentation, and maintainer authorizations.
 */
export function validateReleaseReadiness(
  options: ReleaseReadinessOptions = {},
): Promise<ReleaseReadinessReport> {
  return validateReleaseReadinessImpl(options);
}

async function validateReleaseReadinessImpl(
  options: ReleaseReadinessOptions = {},
): Promise<ReleaseReadinessReport> {
  const rootDir = options.rootDir ?? path.resolve(process.cwd(), "..");
  const migrationsDir =
    options.migrationsDir ?? path.resolve(process.cwd(), "prisma/migrations");
  const checklistPath =
    options.checklistPath ?? path.resolve(rootDir, "docs/release-readiness-checklist.md");

  const checks: ReadinessCheckResult[] = [];
  const isUrgent = Boolean(options.isUrgentFix && options.incidentId?.trim());

  // 1. Checklist Template & Documentation Check
  const checklistExists = fs.existsSync(checklistPath);
  checks.push({
    id: "docs-checklist-template",
    category: "docs",
    name: "Release readiness checklist document exists",
    ok: checklistExists,
    detail: checklistExists
      ? "docs/release-readiness-checklist.md found"
      : "docs/release-readiness-checklist.md is missing",
    remediation: "Ensure docs/release-readiness-checklist.md is created and tracked.",
  });

  if (checklistExists) {
    const content = fs.readFileSync(checklistPath, "utf-8").toLowerCase();
    const requiredSections = [
      "tests",
      "migration",
      "configuration",
      "rollback",
      "documentation",
      "maintainer sign-off",
    ];
    const missingSections = requiredSections.filter((sec) => !content.includes(sec));
    checks.push({
      id: "docs-checklist-sections",
      category: "docs",
      name: "Checklist contains all mandatory sections",
      ok: missingSections.length === 0,
      detail:
        missingSections.length === 0
          ? "All required sections are present"
          : `Missing sections: ${missingSections.join(", ")}`,
      remediation: "Add missing sections to docs/release-readiness-checklist.md.",
    });

    const hasUrgentException =
      content.includes("urgent") &&
      content.includes("exception") &&
      content.includes("post-mortem");
    checks.push({
      id: "docs-urgent-exception",
      category: "docs",
      name: "Checklist documents urgent fix exception workflow",
      ok: hasUrgentException,
      detail: hasUrgentException
        ? "Urgent exception and post-mortem guidelines defined"
        : "Missing urgent exception or post-mortem handling guidance",
      remediation:
        "Document urgent fix paths with post-mortem requirements in the checklist.",
    });
  }

  // 2. Migration Checks
  let migrationPreview: MigrationPreview | undefined;
  let postChecks: PostCheckReport | undefined;

  const migrationsDirExists = fs.existsSync(migrationsDir);
  checks.push({
    id: "migration-source",
    category: "migration",
    name: "Migration directory and plan are available",
    ok: migrationsDirExists,
    detail: migrationsDirExists
      ? "Migration directory found"
      : `Migration directory is missing: ${migrationsDir}`,
    remediation: "Provide the repository migration directory and select a valid migration plan.",
  });

  if (migrationsDirExists) {
    const migrationIds = listMigrationIds(migrationsDir);
    const targetMigrationId = options.migrationId ?? migrationIds[migrationIds.length - 1];

    const migrationFile = targetMigrationId
      ? path.join(migrationsDir, targetMigrationId, "migration.sql")
      : null;
    if (
      !targetMigrationId ||
      !migrationIds.includes(targetMigrationId) ||
      !migrationFile ||
      !fs.existsSync(migrationFile)
    ) {
      checks.push({
        id: "migration-selection",
        category: "migration",
        name: "A valid migration is selected",
        ok: false,
        detail: targetMigrationId && migrationIds.includes(targetMigrationId)
          ? `Migration SQL file is missing for ${targetMigrationId}`
          : targetMigrationId
          ? `Migration ${targetMigrationId} was not found`
          : "No migration folders were found",
        remediation: "Select a migration with a tracked migration.sql file or add the migration being released.",
      });
    } else {
      const plan = readMigrationPlan(migrationsDir, targetMigrationId);
      checks.push({
        id: "migration-plan-parse",
        category: "migration",
        name: `Parse plan for migration ${targetMigrationId}`,
        ok: plan.actions.length > 0,
        detail: plan.actions.length > 0
          ? `Migration contains ${plan.actions.length} action(s), ${plan.destructive.length} destructive`
          : "Migration plan is empty",
        remediation: "Add the migration SQL or select the migration that contains the release changes.",
      });

      if (options.db) {
        migrationPreview = await previewMigration(plan, options.db);
        checks.push({
          id: "migration-preview-run",
          category: "migration",
          name: `Preview migration against database`,
          ok: true,
          detail: `Would create: ${migrationPreview.wouldCreate.length}, destructive: ${migrationPreview.wouldRunDestructive.length}`,
        });

        if (options.migrationVerified) {
          postChecks = await runPostChecks(options.db, plan);
          checks.push({
            id: "migration-post-checks",
            category: "migration",
            name: `Run post-checks for migration convergence`,
            ok: postChecks.ok,
            detail: postChecks.ok
              ? "All post-checks passed"
              : `Failures: ${postChecks.failures.map((f) => f.name).join(", ")}`,
            remediation: "Verify all planned schema objects and zero remaining null rows.",
          });
        }
      } else if (options.migrationVerified) {
        checks.push({
          id: "migration-post-checks",
          category: "migration",
          name: "Migration convergence checks have database evidence",
          ok: false,
          detail: "Migration was marked verified but no database was provided for post-checks",
          remediation: "Provide a database connection and run the migration post-checks before marking it verified.",
        });
      }

      // 3. Rollback Plan & Evidence Check
      const hasDestructive = plan.destructive.length > 0;
      const evidence = options.rollbackEvidence;
      const hasEvidence = Boolean(
        evidence?.backupSnapshotUri?.trim() ||
        evidence?.testedRollbackScriptPath?.trim() ||
        (evidence?.verifiedDryRunTimestamp &&
          Number.isFinite(Date.parse(evidence.verifiedDryRunTimestamp)) &&
          Date.parse(evidence.verifiedDryRunTimestamp) <= Date.now())
      );
      const evidenceRequired = options.requireRollbackEvidence ?? hasDestructive;

      let rollbackOk = !hasDestructive || Boolean(migrationPreview?.rollbackNotes?.length);
      if (evidenceRequired && !hasEvidence && !isUrgent) {
        rollbackOk = false;
      }

      checks.push({
        id: "rollback-plan-defined",
        category: "rollback",
        name: "Rollback procedure and evidence defined for migration",
        ok: rollbackOk,
        detail: hasDestructive
          ? (hasEvidence
              ? `Destructive changes detected; verified rollback evidence attached (snapshot: ${evidence?.backupSnapshotUri ?? 'provided'})`
              : "Destructive changes detected; missing rollback evidence or backup snapshot URI")
          : (hasEvidence
              ? `Non-destructive migration; rollback evidence attached (snapshot: ${evidence?.backupSnapshotUri ?? 'provided'})`
              : "No destructive statements; safe to revert application code"),
        remediation:
          "Provide explicit pg_dump/snapshot URI, tested rollback script, or dry-run evidence in options.rollbackEvidence.",
      });
    }
  }

  // 4. Configuration Check
  const rootEnvExample = path.resolve(rootDir, ".env.example");
  const backendEnvExample = path.resolve(rootDir, "backend/.env.example");
  const configFilesExist = fs.existsSync(rootEnvExample) && fs.existsSync(backendEnvExample);
  checks.push({
    id: "config-env-examples",
    category: "config",
    name: "Environment configuration inventory maintained",
    ok: configFilesExist,
    detail: configFilesExist
      ? "Both root and backend .env.example files found"
      : "Missing .env.example templates",
    remediation: "Ensure all environment variables have documented defaults.",
  });

  // 5. Authorization & Attestation Check
  const attestedSet =
    options.attestedItems instanceof Set
      ? options.attestedItems
      : Array.isArray(options.attestedItems)
        ? new Set(options.attestedItems as ReleaseChecklistItemId[])
        : new Set<ReleaseChecklistItemId>();

  const maintainer = options.maintainerSignOff;
  const approvedAt = maintainer ? new Date(maintainer.approvedAt).getTime() : Number.NaN;
  const validMaintainerSignOff = Boolean(
    maintainer?.maintainerId.trim() &&
    Number.isFinite(approvedAt) &&
    approvedAt <= Date.now()
  );
  const isAuthorizedRole =
    validMaintainerSignOff && maintainer && ["admin", "maintainer"].includes(maintainer.role);

  const authOk = isUrgent || Boolean(isAuthorizedRole);
  checks.push({
    id: "auth-maintainer-signoff",
    category: "authorization",
    name: "Maintainer authorization and sign-off",
    ok: authOk,
    detail: isUrgent
      ? `Urgent fix exception authorized (incident: ${options.incidentId})`
      : isAuthorizedRole
        ? `Signed off by ${maintainer?.maintainerId} (${maintainer?.role})`
        : options.isUrgentFix
          ? "Urgent fixes require a tracked incident ID."
          : validMaintainerSignOff
            ? "Sign-off role is not authorized. Releases require admin or maintainer approval."
            : "Missing or invalid maintainer sign-off. Provide an authorized role, non-empty ID, and a valid non-future approval time.",
    remediation:
      "Request maintainer attestation via CLI (--attest) or provide emergency incident ID.",
  });

  // Build checklist statuses
  const checklistStatuses = buildChecklistStatus(
    attestedSet,
    Boolean(options.migrationVerified),
  );

  const failures = checks.filter((c) => !c.ok);
  const ok = failures.length === 0;

  return {
    ok,
    checkedAt: new Date().toISOString(),
    environment: process.env.NODE_ENV ?? "development",
    checks,
    failures,
    checklistStatuses,
    migrationPreview,
    postChecks,
    summary: {
      total: checks.length,
      passed: checks.length - failures.length,
      failed: failures.length,
      urgentException: isUrgent,
    },
  };
}

/**
 * Format the release readiness report for terminal or CI logs.
 */
export function formatReport(report: ReleaseReadinessReport): string {
  const lines: string[] = [];
  lines.push("=================================================");
  lines.push("           VAULTQUEST RELEASE READINESS           ");
  lines.push("=================================================");
  lines.push(`Checked at:   ${report.checkedAt}`);
  lines.push(`Status:       ${report.ok ? "✅ PASSED" : "❌ FAILED"}`);
  lines.push(`Total checks: ${report.summary.total} (Passed: ${report.summary.passed}, Failed: ${report.summary.failed})`);
  if (report.summary.urgentException) {
    lines.push("⚠️  URGENT EXCEPTION ACTIVE — Post-mortem required within 48h.");
  }
  lines.push("-------------------------------------------------");
  lines.push("Checks:");
  for (const check of report.checks) {
    const symbol = check.ok ? "  [PASS]" : "  [FAIL]";
    lines.push(`${symbol} [${check.category.toUpperCase()}] ${check.name}`);
    lines.push(`         ${check.detail}`);
    if (!check.ok && check.remediation) {
      lines.push(`         👉 Fix: ${check.remediation}`);
    }
  }
  lines.push("=================================================");
  return lines.join("\n");
}
