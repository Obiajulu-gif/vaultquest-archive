import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  RESTORE_VERIFICATION_SCHEMA,
  verifyRestoredDatabase,
  type RestoreVerificationDeps,
} from "../src/services/restoreVerificationService.js";

const prisma = {} as unknown as PrismaClient;
const NOW = new Date("2026-10-16T12:00:00.000Z");

function validation(overrides: {
  checks?: Array<{ name: string; count: number; remediation: string }>;
  missingTables?: string[];
} = {}) {
  const checks = overrides.checks ?? [];
  const missingTables = overrides.missingTables ?? [];
  return {
    readOnly: true as const,
    status: checks.some((check) => check.count > 0) || missingTables.length ? "needs_review" : "valid",
    checkedAt: NOW.toISOString(),
    missingTables,
    checks,
    failureCount: missingTables.length + checks.filter((check) => check.count > 0).length,
  };
}

function healthyDeps(overrides: Partial<RestoreVerificationDeps> = {}): RestoreVerificationDeps {
  return {
    validate: async () => validation(),
    refreshDashboardAggregates: async () => ({ scope: "global", watermark: NOW }),
    verifyDashboardAlignment: async () => ({ aggregatePresent: true, aligned: true, skewMs: 0 }),
    countStaleDerivedEntries: async () => 0,
    now: () => NOW,
    ...overrides,
  };
}

describe("verifyRestoredDatabase", () => {
  it("passes a clean restore and rebuilds derived views", async () => {
    const refresh = vi.fn(async () => ({ scope: "global", watermark: NOW }));
    const report = await verifyRestoredDatabase(prisma, { deps: healthyDeps({ refreshDashboardAggregates: refresh }) });

    expect(report.schema).toBe(RESTORE_VERIFICATION_SCHEMA);
    expect(report.status).toBe("valid");
    expect(report.failureCount).toBe(0);
    expect(report.repairSteps).toEqual([]);
    expect(report.readOnlyInvariants).toBe(true);
    expect(report.derived.rebuilt).toBe(true);
    expect(report.derived.refreshedScopes).toEqual(["global"]);
    expect(report.derived.aggregateAligned).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(report.phases.map((phase) => phase.status)).toEqual(["passed", "passed", "passed"]);
  });

  it("reports invariant failures loudly with remediation and still rebuilds derived views", async () => {
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        validate: async () =>
          validation({
            checks: [
              { name: "confirmed actions missing transaction reference", count: 3, remediation: "Reconcile against chain events." },
              { name: "duplicate quest identities", count: 1, remediation: "Merge duplicates carefully." },
            ],
          }),
      }),
    });

    expect(report.status).toBe("needs_review");
    expect(report.failureCount).toBe(2);
    expect(report.invariantFailures).toHaveLength(2);
    expect(report.repairSteps).toContain("confirmed actions missing transaction reference (3 record(s)): Reconcile against chain events.");
    expect(report.derived.rebuilt).toBe(true);
  });

  it("flags missing core tables with an explicit restore step", async () => {
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        validate: async () => validation({ missingTables: ["chain_events"] }),
      }),
    });
    expect(report.status).toBe("needs_review");
    expect(report.missingTables).toEqual(["chain_events"]);
    expect(report.repairSteps.some((step) => step.includes("chain_events"))).toBe(true);
  });

  it("repairs stale derived-cache entries when a repair hook is provided", async () => {
    const repair = vi.fn(async () => ({ repaired: 4, remaining: 0 }));
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        countStaleDerivedEntries: async () => 4,
        repairStaleDerived: repair,
      }),
    });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(report.status).toBe("repaired");
    expect(report.failureCount).toBe(0);
    expect(report.derived.staleBefore).toBe(4);
    expect(report.derived.staleAfter).toBe(0);
    expect(report.derived.repairedDerivedEntries).toBe(4);
  });

  it("fails with a repair step when stale derived entries remain and no repair hook exists", async () => {
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({ countStaleDerivedEntries: async () => 3 }),
    });

    expect(report.status).toBe("needs_review");
    expect(report.derived.staleAfter).toBe(3);
    expect(report.repairSteps.some((step) => step.includes("Repair 3 stale derived-cache"))).toBe(true);
    expect(report.phases.find((phase) => phase.name === "derived_verification")?.status).toBe("failed");
  });

  it("fails loudly when the derived rebuild throws", async () => {
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        refreshDashboardAggregates: async () => {
          throw new Error("connection reset");
        },
      }),
    });

    expect(report.status).toBe("failed");
    expect(report.derived.rebuilt).toBe(false);
    expect(report.failureCount).toBe(1);
    expect(report.repairSteps.some((step) => step.includes("connection reset"))).toBe(true);
    expect(report.phases.find((phase) => phase.name === "derived_rebuild")?.status).toBe("failed");
  });

  it("fails loudly when the rebuilt aggregate is behind its source rows", async () => {
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        verifyDashboardAlignment: async () => ({ aggregatePresent: true, aligned: false, skewMs: 4200 }),
      }),
    });

    expect(report.status).toBe("needs_review");
    expect(report.derived.aggregateAligned).toBe(false);
    expect(report.derived.aggregateSkewMs).toBe(4200);
    expect(report.repairSteps.some((step) => step.includes("4200 ms behind"))).toBe(true);
  });

  it("fails when no aggregate exists after the rebuild", async () => {
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        verifyDashboardAlignment: async () => ({ aggregatePresent: false, aligned: false, skewMs: Number.POSITIVE_INFINITY }),
      }),
    });
    expect(report.status).toBe("needs_review");
    expect(report.derived.aggregatePresent).toBe(false);
    expect(report.repairSteps.some((step) => step.includes("No dashboard aggregate"))).toBe(true);
  });

  it("fails when derived-view verification throws", async () => {
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        verifyDashboardAlignment: async () => {
          throw new Error("snapshot read failed");
        },
      }),
    });
    expect(report.status).toBe("needs_review");
    expect(report.failureCount).toBe(1);
    expect(report.repairSteps.some((step) => step.includes("snapshot read failed"))).toBe(true);
  });

  it("skips the rebuild and reports a step when derived tables are missing", async () => {
    const refresh = vi.fn(async () => ({ scope: "global", watermark: NOW }));
    const report = await verifyRestoredDatabase(prisma, {
      deps: healthyDeps({
        validate: async () => validation({ missingTables: ["derived_cache"] }),
        refreshDashboardAggregates: refresh,
      }),
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(report.status).toBe("needs_review");
    expect(report.derived.rebuilt).toBe(false);
    expect(report.phases.find((phase) => phase.name === "derived_rebuild")?.status).toBe("skipped");
    expect(report.repairSteps.some((step) => step.includes("Rebuild the derived views"))).toBe(true);
  });

  it("supports a read-only probe that reports without rebuilding", async () => {
    const refresh = vi.fn(async () => ({ scope: "global", watermark: NOW }));
    const report = await verifyRestoredDatabase(prisma, {
      rebuildDerived: false,
      deps: healthyDeps({ refreshDashboardAggregates: refresh }),
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(report.status).toBe("valid");
    expect(report.derived.rebuilt).toBe(false);
    expect(report.phases.every((phase) => phase.status !== "failed")).toBe(true);
  });
});
