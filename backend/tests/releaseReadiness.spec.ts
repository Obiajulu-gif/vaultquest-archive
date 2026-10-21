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
});
