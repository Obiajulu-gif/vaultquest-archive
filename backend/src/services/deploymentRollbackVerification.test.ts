/**
 * Tests for deploymentRollbackVerification (issue #1124).
 *
 * All database interactions are injected as mocks — no real Postgres needed.
 *
 * Coverage matrix:
 *   - clean rollback (all checks pass) → verdict "passed"
 *   - pending migrations outstanding → verdict "failed"
 *   - unreadable migration history → verdict "failed"
 *   - action statuses unknown to rolled-back binary → verdict "failed"
 *   - action types unknown to rolled-back binary → verdict "failed"
 *   - stale derived-cache entries, dry-run → verdict "needs_review" + repair step
 *   - stale derived-cache entries, live flush → verdict "passed", entries deleted
 *   - stale dashboard aggregates, dry-run → "needs_review"
 *   - stale dashboard aggregates, live flush → "passed"
 *   - dep that throws → check is "failed" or "warning", verdict not "passed"
 *   - schema constant and verifiedAt format
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyRollback,
  ROLLBACK_VERIFICATION_SCHEMA,
  type RollbackVerificationDeps,
} from "./deploymentRollbackVerification.js";
import type { PrismaClient } from "@prisma/client";

// ─── helpers ──────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2025-06-01T12:00:00.000Z");

/** Builds a deps object where every hook returns a "clean" response. */
function cleanDeps(): Required<RollbackVerificationDeps> {
  return {
    countPendingMigrations: vi.fn().mockResolvedValue(0),
    getLatestAppliedMigration: vi
      .fn()
      .mockResolvedValue("20250101000000_initial"),
    countUnrecognisedActionStatuses: vi.fn().mockResolvedValue(0),
    countUnrecognisedActionTypes: vi.fn().mockResolvedValue(0),
    countDerivedCacheEntriesAfter: vi.fn().mockResolvedValue(0),
    flushDerivedCacheAfter: vi.fn().mockResolvedValue(0),
    countDashboardAggregatesAfter: vi.fn().mockResolvedValue(0),
    flushDashboardAggregatesAfter: vi.fn().mockResolvedValue(0),
    now: () => FIXED_NOW,
  };
}

const mockPrisma = {} as unknown as PrismaClient;

// ─── tests ────────────────────────────────────────────────────────────────────

describe("verifyRollback", () => {
  describe("report envelope", () => {
    it("stamps the correct schema version and verifiedAt", async () => {
      const report = await verifyRollback(mockPrisma, {
        deps: cleanDeps(),
        targetVersion: "v1.2.3",
      });
      expect(report.schema).toBe(ROLLBACK_VERIFICATION_SCHEMA);
      expect(report.verifiedAt).toBe(FIXED_NOW.toISOString());
      expect(report.targetVersion).toBe("v1.2.3");
    });

    it("defaults targetVersion to 'unknown'", async () => {
      const report = await verifyRollback(mockPrisma, { deps: cleanDeps() });
      expect(report.targetVersion).toBe("unknown");
    });

    it("defaults dryRun to true", async () => {
      const report = await verifyRollback(mockPrisma, { deps: cleanDeps() });
      expect(report.dryRun).toBe(true);
    });
  });

  describe("clean rollback", () => {
    it("returns verdict 'passed' when every check is clean", async () => {
      const report = await verifyRollback(mockPrisma, {
        dryRun: true,
        deps: cleanDeps(),
      });
      expect(report.verdict).toBe("passed");
      expect(report.failureCount).toBe(0);
      expect(report.repairSteps).toHaveLength(0);
      expect(report.checks.every((c) => c.status === "passed")).toBe(true);
    });
  });

  // ── Schema / migration checks ───────────────────────────────────────────────

  describe("schema_migrations_applied", () => {
    it("fails when pending migrations > 0", async () => {
      const deps = cleanDeps();
      deps.countPendingMigrations = vi.fn().mockResolvedValue(3);

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find((c) => c.name === "schema_migrations_applied");
      expect(check?.status).toBe("failed");
      expect(check?.detail).toContain("3");
      expect(report.verdict).toBe("failed");
      expect(report.repairSteps.some((s) => s.includes("migration"))).toBe(true);
    });

    it("fails when countPendingMigrations returns -1 (table unreadable)", async () => {
      const deps = cleanDeps();
      deps.countPendingMigrations = vi.fn().mockResolvedValue(-1);

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find((c) => c.name === "schema_migrations_applied");
      expect(check?.status).toBe("failed");
      expect(check?.detail).toContain("unreadable");
      expect(report.verdict).toBe("failed");
    });

    it("fails when countPendingMigrations throws", async () => {
      const deps = cleanDeps();
      deps.countPendingMigrations = vi.fn().mockRejectedValue(new Error("connection refused"));

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find((c) => c.name === "schema_migrations_applied");
      expect(check?.status).toBe("failed");
      expect(report.verdict).toBe("failed");
    });

    it("passes when no pending migrations", async () => {
      const deps = cleanDeps();
      deps.countPendingMigrations = vi.fn().mockResolvedValue(0);

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find((c) => c.name === "schema_migrations_applied");
      expect(check?.status).toBe("passed");
    });
  });

  describe("migration_history_readable", () => {
    it("passes and surfaces the latest migration name", async () => {
      const deps = cleanDeps();
      deps.getLatestAppliedMigration = vi.fn().mockResolvedValue("20250601_add_index");

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find((c) => c.name === "migration_history_readable");
      expect(check?.status).toBe("passed");
      expect(check?.detail).toContain("20250601_add_index");
    });

    it("fails when getLatestAppliedMigration throws", async () => {
      const deps = cleanDeps();
      deps.getLatestAppliedMigration = vi.fn().mockRejectedValue(new Error("table missing"));

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find((c) => c.name === "migration_history_readable");
      expect(check?.status).toBe("failed");
      expect(report.verdict).toBe("failed");
    });
  });

  // ── Action-ledger compatibility checks ────────────────────────────────────

  describe("action_ledger_status_compatibility", () => {
    it("fails when unrecognised statuses exist", async () => {
      const deps = cleanDeps();
      deps.countUnrecognisedActionStatuses = vi.fn().mockResolvedValue(7);

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find(
        (c) => c.name === "action_ledger_status_compatibility",
      );
      expect(check?.status).toBe("failed");
      expect(check?.detail).toContain("7");
      expect(report.verdict).toBe("failed");
    });

    it("surfaces custom knownActionStatuses in the dep call", async () => {
      const deps = cleanDeps();
      const customStatuses = ["pending", "confirmed", "super_new_status"];

      await verifyRollback(mockPrisma, {
        knownActionStatuses: customStatuses,
        deps,
      });

      expect(deps.countUnrecognisedActionStatuses).toHaveBeenCalledWith(
        mockPrisma,
        customStatuses,
      );
    });

    it("records a warning when the dep throws", async () => {
      const deps = cleanDeps();
      deps.countUnrecognisedActionStatuses = vi
        .fn()
        .mockRejectedValue(new Error("query timeout"));

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find(
        (c) => c.name === "action_ledger_status_compatibility",
      );
      expect(check?.status).toBe("warning");
      // A warning alone promotes to needs_review, not failed
      expect(report.verdict).not.toBe("passed");
    });
  });

  describe("action_ledger_type_compatibility", () => {
    it("fails when unrecognised action types exist", async () => {
      const deps = cleanDeps();
      deps.countUnrecognisedActionTypes = vi.fn().mockResolvedValue(2);

      const report = await verifyRollback(mockPrisma, { deps });

      const check = report.checks.find(
        (c) => c.name === "action_ledger_type_compatibility",
      );
      expect(check?.status).toBe("failed");
      expect(report.verdict).toBe("failed");
    });

    it("passes when all action types are known", async () => {
      const report = await verifyRollback(mockPrisma, { deps: cleanDeps() });
      const check = report.checks.find(
        (c) => c.name === "action_ledger_type_compatibility",
      );
      expect(check?.status).toBe("passed");
    });
  });

  // ── Derived-cache staleness ───────────────────────────────────────────────

  describe("derived_cache_staleness", () => {
    it("returns warning (not flush) in dry-run mode when stale entries exist", async () => {
      const deps = cleanDeps();
      deps.countDerivedCacheEntriesAfter = vi.fn().mockResolvedValue(12);

      const report = await verifyRollback(mockPrisma, {
        dryRun: true,
        deps,
      });

      const check = report.checks.find((c) => c.name === "derived_cache_staleness");
      expect(check?.status).toBe("warning");
      expect(check?.detail).toContain("12");
      expect(deps.flushDerivedCacheAfter).not.toHaveBeenCalled();
      expect(report.repairSteps.some((s) => s.includes("12"))).toBe(true);
    });

    it("flushes and passes when dryRun=false and stale entries exist", async () => {
      const deps = cleanDeps();
      deps.countDerivedCacheEntriesAfter = vi.fn().mockResolvedValue(5);
      deps.flushDerivedCacheAfter = vi.fn().mockResolvedValue(5);

      const report = await verifyRollback(mockPrisma, {
        dryRun: false,
        deps,
      });

      const check = report.checks.find((c) => c.name === "derived_cache_staleness");
      expect(check?.status).toBe("passed");
      expect(check?.detail).toContain("5");
      expect(deps.flushDerivedCacheAfter).toHaveBeenCalledOnce();
    });

    it("fails when flush throws in live mode", async () => {
      const deps = cleanDeps();
      deps.countDerivedCacheEntriesAfter = vi.fn().mockResolvedValue(3);
      deps.flushDerivedCacheAfter = vi
        .fn()
        .mockRejectedValue(new Error("deadlock detected"));

      const report = await verifyRollback(mockPrisma, {
        dryRun: false,
        deps,
      });

      const check = report.checks.find((c) => c.name === "derived_cache_staleness");
      expect(check?.status).toBe("failed");
      expect(report.verdict).toBe("failed");
    });

    it("passes when no stale derived-cache entries exist", async () => {
      const report = await verifyRollback(mockPrisma, { deps: cleanDeps() });
      const check = report.checks.find((c) => c.name === "derived_cache_staleness");
      expect(check?.status).toBe("passed");
      expect(check?.detail).toContain("No derived-cache entries");
    });
  });

  // ── Dashboard aggregate staleness ─────────────────────────────────────────

  describe("dashboard_aggregate_staleness", () => {
    it("warns in dry-run when stale aggregates exist", async () => {
      const deps = cleanDeps();
      deps.countDashboardAggregatesAfter = vi.fn().mockResolvedValue(4);

      const report = await verifyRollback(mockPrisma, {
        dryRun: true,
        deps,
      });

      const check = report.checks.find((c) => c.name === "dashboard_aggregate_staleness");
      expect(check?.status).toBe("warning");
      expect(deps.flushDashboardAggregatesAfter).not.toHaveBeenCalled();
    });

    it("flushes and passes when dryRun=false", async () => {
      const deps = cleanDeps();
      deps.countDashboardAggregatesAfter = vi.fn().mockResolvedValue(2);
      deps.flushDashboardAggregatesAfter = vi.fn().mockResolvedValue(2);

      const report = await verifyRollback(mockPrisma, {
        dryRun: false,
        deps,
      });

      const check = report.checks.find((c) => c.name === "dashboard_aggregate_staleness");
      expect(check?.status).toBe("passed");
      expect(deps.flushDashboardAggregatesAfter).toHaveBeenCalledOnce();
    });

    it("fails when flush throws in live mode", async () => {
      const deps = cleanDeps();
      deps.countDashboardAggregatesAfter = vi.fn().mockResolvedValue(1);
      deps.flushDashboardAggregatesAfter = vi
        .fn()
        .mockRejectedValue(new Error("connection reset"));

      const report = await verifyRollback(mockPrisma, {
        dryRun: false,
        deps,
      });

      const check = report.checks.find((c) => c.name === "dashboard_aggregate_staleness");
      expect(check?.status).toBe("failed");
      expect(report.verdict).toBe("failed");
    });
  });

  // ── rolledBackDeployedAt scoping ──────────────────────────────────────────

  describe("rolledBackDeployedAt", () => {
    it("passes the caller-supplied timestamp to derived-view checks", async () => {
      const deps = cleanDeps();
      const deployedAt = new Date("2025-05-30T10:00:00Z");

      await verifyRollback(mockPrisma, {
        rolledBackDeployedAt: deployedAt,
        deps,
      });

      expect(deps.countDerivedCacheEntriesAfter).toHaveBeenCalledWith(
        mockPrisma,
        deployedAt,
      );
      expect(deps.countDashboardAggregatesAfter).toHaveBeenCalledWith(
        mockPrisma,
        deployedAt,
      );
    });

    it("defaults rolledBackDeployedAt to 1 hour before now", async () => {
      const deps = cleanDeps();

      await verifyRollback(mockPrisma, { deps });

      const expectedCutoff = new Date(FIXED_NOW.getTime() - 60 * 60 * 1000);

      expect(deps.countDerivedCacheEntriesAfter).toHaveBeenCalledWith(
        mockPrisma,
        expectedCutoff,
      );
    });
  });

  // ── Multi-failure verdict ─────────────────────────────────────────────────

  describe("multi-failure verdict", () => {
    it("returns verdict 'failed' when any check is 'failed'", async () => {
      const deps = cleanDeps();
      deps.countPendingMigrations = vi.fn().mockResolvedValue(1);
      deps.countUnrecognisedActionStatuses = vi.fn().mockResolvedValue(2);

      const report = await verifyRollback(mockPrisma, { deps });

      expect(report.verdict).toBe("failed");
      expect(report.failureCount).toBeGreaterThanOrEqual(2);
    });

    it("returns verdict 'needs_review' when only warnings exist", async () => {
      const deps = cleanDeps();
      // warnings come from dep throws — both return warnings
      deps.countUnrecognisedActionStatuses = vi
        .fn()
        .mockRejectedValue(new Error("timeout"));
      deps.countUnrecognisedActionTypes = vi
        .fn()
        .mockRejectedValue(new Error("timeout"));

      const report = await verifyRollback(mockPrisma, { deps });

      expect(report.verdict).toBe("needs_review");
    });
  });

  // ── Repair steps are consolidated ────────────────────────────────────────

  describe("repairSteps", () => {
    it("includes a step for every failed or warning check", async () => {
      const deps = cleanDeps();
      deps.countPendingMigrations = vi.fn().mockResolvedValue(2);
      deps.countUnrecognisedActionStatuses = vi.fn().mockResolvedValue(1);
      deps.countDerivedCacheEntriesAfter = vi.fn().mockResolvedValue(3);

      const report = await verifyRollback(mockPrisma, { dryRun: true, deps });

      expect(report.repairSteps.length).toBeGreaterThan(0);
      // Each failing check contributes at least one step
      expect(report.repairSteps.some((s) => s.includes("migration"))).toBe(true);
      expect(report.repairSteps.some((s) => s.includes("action"))).toBe(true);
      expect(report.repairSteps.some((s) => s.includes("derived"))).toBe(true);
    });
  });
});
