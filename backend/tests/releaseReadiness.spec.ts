import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  validateReleaseReadiness,
  formatReport,
  type ReleaseReadinessOptions,
} from "../src/scripts/releaseReadiness.js";

describe("Release Readiness Verification (#972)", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const migrationsDir = path.resolve(__dirname, "../prisma/migrations");
  const checklistPath = path.resolve(rootDir, "docs/release-readiness-checklist.md");

  const validMaintainerSignOff = {
    maintainerId: "maint_alice",
    role: "maintainer" as const,
    approvedAt: new Date().toISOString(),
    notes: "Release checks verified for release train v1.4.0",
  };

  describe("Normal paths", () => {
    it("validates repository release readiness successfully with valid signoff", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        maintainerSignOff: validMaintainerSignOff,
        attestedItems: [
          "unit_tests",
          "integration_tests",
          "migration_preview",
          "rollback_documented",
          "smoke_tests_passed",
          "config_documented",
        ],
      });

      expect(report.ok).toBe(true);
      expect(report.summary.failed).toBe(0);
      expect(report.summary.passed).toBeGreaterThan(0);
      expect(report.failures).toHaveLength(0);

      // Verify formatted markdown report output
      const formatted = formatReport(report);
      expect(formatted).toContain("VAULTQUEST RELEASE READINESS");
      expect(formatted).toContain("PASSED");
      expect(formatted).toContain("maint_alice");
    });

    it("verifies dual-control admin authorization", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        maintainerSignOff: {
          maintainerId: "admin_bob",
          role: "admin",
          approvedAt: new Date().toISOString(),
          notes: "Approved by cluster admin",
        },
      });

      expect(report.ok).toBe(true);
      const authCheck = report.checks.find((c) => c.id === "auth-maintainer-signoff");
      expect(authCheck?.ok).toBe(true);
      expect(authCheck?.detail).toContain("admin_bob");
    });
  });

  describe("Failure paths", () => {
    it("fails closed when migration plans are unavailable", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir: path.resolve(rootDir, "missing-migrations"),
        checklistPath,
        maintainerSignOff: validMaintainerSignOff,
      });

      expect(report.ok).toBe(false);
      expect(report.failures.some((check) => check.id === "migration-source")).toBe(true);
    });

    it("does not accept a migration verification claim without database post-checks", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        migrationVerified: true,
        maintainerSignOff: validMaintainerSignOff,
      });

      expect(report.ok).toBe(false);
      expect(report.failures.some((check) => check.id === "migration-post-checks")).toBe(true);
    });

    it("fails validation when checklist template is missing", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath: path.resolve(rootDir, "docs/non-existent-checklist.md"),
        maintainerSignOff: validMaintainerSignOff,
      });

      expect(report.ok).toBe(false);
      expect(report.failures.some((f) => f.id === "docs-checklist-template")).toBe(true);
      const formatted = formatReport(report);
      expect(formatted).toContain("FAILED");
    });

    it("fails authorization when maintainer sign-off is absent and not an urgent fix", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
      });

      expect(report.ok).toBe(false);
      const authCheck = report.failures.find((f) => f.id === "auth-maintainer-signoff");
      expect(authCheck).toBeDefined();
      expect(authCheck?.remediation).toContain("maintainer");
    });

    it("fails authorization when unauthorized role attempts sign-off", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        maintainerSignOff: {
          maintainerId: "guest_charlie",
          role: "operator" as any,
          approvedAt: new Date().toISOString(),
        },
      });

      expect(report.ok).toBe(false);
      const authCheck = report.failures.find((f) => f.id === "auth-maintainer-signoff");
      expect(authCheck?.detail).toContain("admin or maintainer");
    });

    it("rejects future-dated sign-off and urgent exceptions without an incident ID", async () => {
      const futureSignoff = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        maintainerSignOff: {
          ...validMaintainerSignOff,
          approvedAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      expect(futureSignoff.failures.some((check) => check.id === "auth-maintainer-signoff")).toBe(true);

      const untrackedUrgent = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        isUrgentFix: true,
      });
      expect(untrackedUrgent.summary.urgentException).toBe(false);
      expect(untrackedUrgent.failures.find((check) => check.id === "auth-maintainer-signoff")?.detail)
        .toContain("incident ID");
    });
  });

  describe("Retry paths", () => {
    it("recovers from initial missing signoff after valid retry", async () => {
      // Step 1: initial run fails authorization
      const initialReport = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
      });
      expect(initialReport.ok).toBe(false);

      // Step 2: retry with valid maintainer sign-off recovers to ok
      const retriedReport = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        maintainerSignOff: validMaintainerSignOff,
      });
      expect(retriedReport.ok).toBe(true);
      expect(retriedReport.failures).toHaveLength(0);
    });

    it("allows urgent exception workflow with post-mortem requirement", async () => {
      const urgentReport = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        isUrgentFix: true,
        incidentId: "INC-2026-10-18-001",
      });

      expect(urgentReport.ok).toBe(true);
      expect(urgentReport.summary.urgentException).toBe(true);

      const authCheck = urgentReport.checks.find((c) => c.id === "auth-maintainer-signoff");
      expect(authCheck?.ok).toBe(true);
      expect(authCheck?.detail).toContain("INC-2026-10-18-001");

      const urgentDocsCheck = urgentReport.checks.find((c) => c.id === "docs-urgent-exception");
      expect(urgentDocsCheck?.ok).toBe(true);
      expect(urgentDocsCheck?.detail).toContain("post-mortem");

      const formatted = formatReport(urgentReport);
      expect(formatted).toContain("URGENT EXCEPTION ACTIVE");
    });
  });

  describe("Rollback evidence verification", () => {
    it("validates readiness when rollback evidence snapshot is supplied", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        maintainerSignOff: validMaintainerSignOff,
        requireRollbackEvidence: true,
        rollbackEvidence: {
          backupSnapshotUri: "s3://backups.vaultquest.internal/snapshots/db-pre-release-20261025.sql.gz",
          verifiedDryRunTimestamp: "2026-10-25T01:00:00Z",
          operatorNotes: "Full pre-migration dump verified with restore dry run.",
        },
      });

      expect(report.ok).toBe(true);
      const rollbackCheck = report.checks.find((c) => c.id === "rollback-plan-defined");
      expect(rollbackCheck?.ok).toBe(true);
      expect(rollbackCheck?.detail).toContain("rollback evidence attached");
      expect(rollbackCheck?.detail).toContain("s3://backups.vaultquest.internal");
    });

    it("fails release readiness when rollback evidence is required but absent", async () => {
      const report = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        maintainerSignOff: validMaintainerSignOff,
        requireRollbackEvidence: true,
      });

      expect(report.ok).toBe(false);
      const rollbackCheck = report.failures.find((c) => c.id === "rollback-plan-defined");
      expect(rollbackCheck).toBeDefined();
      expect(rollbackCheck?.remediation).toContain("rollbackEvidence");
    });

    it("bypasses missing rollback evidence during authorized urgent fix incidents", async () => {
      const urgentReport = await validateReleaseReadiness({
        rootDir,
        migrationsDir,
        checklistPath,
        isUrgentFix: true,
        incidentId: "INC-ROLLBACK-EMERGENCY-01",
        requireRollbackEvidence: true,
      });

      expect(urgentReport.ok).toBe(true);
      const rollbackCheck = urgentReport.checks.find((c) => c.id === "rollback-plan-defined");
      expect(rollbackCheck?.ok).toBe(true);
    });
  });
});
