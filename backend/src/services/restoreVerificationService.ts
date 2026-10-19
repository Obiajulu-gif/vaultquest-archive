/**
 * Snapshot restore verification for critical data and derived indexes.
 *
 * `scripts/validateRestore.ts` already performs read-only invariant checks
 * against a restored database. A restore is not trustworthy until the derived
 * views that were computed from the restored rows are rebuilt and verified
 * too — otherwise dashboards, search indexes, and cached projections can
 * silently disagree with the data underneath them.
 *
 * This service composes the full verification pipeline:
 *
 *  1. invariants   — read-only `validateRestoredDatabase` checks,
 *  2. derived      — rebuild derived views (dashboard aggregates) and, when a
 *                    repair hook is provided, dispatch stale derived-cache
 *                    entries to their repair job,
 *  3. verify       — confirm the rebuilt aggregate aligns with its source rows
 *                    and that no stale derived entries remain.
 *
 * Failures are loud: every mismatch contributes an explicit repair step to the
 * report, the status never reports `valid` while any failure remains, and an
 * operational exception (database unreachable mid-verification) fails with a
 * recovery hint instead of a partial report. The report is safe to log:
 * counts, table names, and scope identifiers only.
 */

import type { PrismaClient } from "@prisma/client";
import { DashboardAggregateService } from "./dashboardAggregateService.js";
import { validateRestoredDatabase } from "../scripts/validateRestore.js";

export const RESTORE_VERIFICATION_SCHEMA = "vaultquest.restore-verification.v1";

export type RestoreVerificationStatus = "valid" | "repaired" | "needs_review" | "failed";

export interface RestoreInvariantFailure {
  name: string;
  count: number;
  remediation: string;
}

export interface RestoreVerificationPhase {
  name: "invariants" | "derived_rebuild" | "derived_verification";
  status: "passed" | "failed" | "skipped";
  detail: string;
}

export interface RestoreVerificationDerivedState {
  rebuilt: boolean;
  refreshedScopes: string[];
  staleBefore: number | null;
  staleAfter: number | null;
  repairedDerivedEntries: number | null;
  aggregatePresent: boolean | null;
  aggregateAligned: boolean | null;
  aggregateSkewMs: number | null;
}

export interface RestoreVerificationReport {
  schema: typeof RESTORE_VERIFICATION_SCHEMA;
  verifiedAt: string;
  /** The invariant phase is read-only; the derived rebuild phase writes derived rows. */
  readOnlyInvariants: boolean;
  status: RestoreVerificationStatus;
  missingTables: string[];
  invariantFailures: RestoreInvariantFailure[];
  derived: RestoreVerificationDerivedState;
  failureCount: number;
  repairSteps: string[];
  phases: RestoreVerificationPhase[];
}

/** Tables whose absence means derived views cannot be rebuilt or trusted. */
export const DERIVED_VIEW_TABLES = ["dashboard_aggregates", "derived_cache", "action_ledger"];

type ValidationReport = Awaited<ReturnType<typeof validateRestoredDatabase>>;

export interface RestoreVerificationDeps {
  /** Read-only invariant checks. Defaults to `validateRestoredDatabase`. */
  validate?: (prisma: PrismaClient) => Promise<ValidationReport>;
  /** Rebuilds derived aggregate views. Defaults to the production dashboard service. */
  refreshDashboardAggregates?: (prisma: PrismaClient) => Promise<{ scope: string; watermark: Date }>;
  /** Verifies a persisted aggregate aligns with its source rows. */
  verifyDashboardAlignment?: (
    prisma: PrismaClient,
  ) => Promise<{ aggregatePresent: boolean; aligned: boolean; skewMs: number }>;
  /** Counts derived-cache entries that are stale or past expiry. */
  countStaleDerivedEntries?: (prisma: PrismaClient, now: Date) => Promise<number>;
  /**
   * Optional repair hook (defaults to the backend repair job). When omitted,
   * stale derived entries are reported with a repair step instead of repaired.
   */
  repairStaleDerived?: (prisma: PrismaClient, now: Date) => Promise<{ repaired: number; remaining: number }>;
  now?: () => Date;
}

async function defaultRefreshDashboardAggregates(prisma: PrismaClient): Promise<{ scope: string; watermark: Date }> {
  const service = new DashboardAggregateService(prisma);
  const result = await service.refreshAggregates("global");
  return { scope: result.scope, watermark: result.watermark };
}

async function defaultVerifyDashboardAlignment(
  prisma: PrismaClient,
): Promise<{ aggregatePresent: boolean; aligned: boolean; skewMs: number }> {
  const service = new DashboardAggregateService(prisma);
  const snapshot = await service.getAggregate("global");
  if (!snapshot) return { aggregatePresent: false, aligned: false, skewMs: Number.POSITIVE_INFINITY };
  const detailRows = await prisma.actionLedger.findMany({
    where: { actionType: "deposit", status: "confirmed", redactedAt: null },
    select: { updatedAt: true },
  });
  const { aligned, skew } = service.verifyWatermarkAlignment(snapshot, detailRows);
  return { aggregatePresent: true, aligned, skewMs: skew };
}

async function defaultCountStaleDerivedEntries(prisma: PrismaClient, now: Date): Promise<number> {
  return prisma.derivedCache.count({
    where: { OR: [{ staleAt: { not: null } }, { expiresAt: { lt: now } }] },
  });
}

/**
 * Runs the verification pipeline against a restored database. `rebuildDerived`
 * controls whether derived views are reconciled (write) or only their existing
 * state is reported (read-only, useful for a quick integrity probe).
 */
export async function verifyRestoredDatabase(
  prisma: PrismaClient,
  options: { rebuildDerived?: boolean; deps?: RestoreVerificationDeps } = {},
): Promise<RestoreVerificationReport> {
  const deps = options.deps ?? {};
  const now = (deps.now ?? (() => new Date()))();
  const rebuildDerived = options.rebuildDerived !== false;

  const validate = deps.validate ?? validateRestoredDatabase;
  const refreshDashboardAggregates = deps.refreshDashboardAggregates ?? defaultRefreshDashboardAggregates;
  const verifyDashboardAlignment = deps.verifyDashboardAlignment ?? defaultVerifyDashboardAlignment;
  const countStaleDerivedEntries = deps.countStaleDerivedEntries ?? defaultCountStaleDerivedEntries;
  const repairStaleDerived = deps.repairStaleDerived;

  const phases: RestoreVerificationPhase[] = [];
  const repairSteps: string[] = [];
  const derived: RestoreVerificationDerivedState = {
    rebuilt: false,
    refreshedScopes: [],
    staleBefore: null,
    staleAfter: null,
    repairedDerivedEntries: null,
    aggregatePresent: null,
    aggregateAligned: null,
    aggregateSkewMs: null,
  };

  // ── Phase 1: invariants ────────────────────────────────────────────────────
  const validation = await validate(prisma);
  const invariantFailures: RestoreInvariantFailure[] = validation.checks
    .filter((check) => check.count > 0)
    .map((check) => ({ name: check.name, count: check.count, remediation: check.remediation }));

  for (const name of validation.missingTables) {
    repairSteps.push(
      `Restore the missing core table "${name}" (or re-run the restore with the full archive) before trusting this database.`,
    );
  }
  for (const failure of invariantFailures) {
    repairSteps.push(`${failure.name} (${failure.count} record(s)): ${failure.remediation}`);
  }
  phases.push({
    name: "invariants",
    status: invariantFailures.length === 0 && validation.missingTables.length === 0 ? "passed" : "failed",
    detail:
      invariantFailures.length === 0 && validation.missingTables.length === 0
        ? "All read-only invariants passed."
        : `${validation.missingTables.length} missing table(s), ${invariantFailures.length} invariant failure(s).`,
  });

  const derivedViable =
    rebuildDerived && !DERIVED_VIEW_TABLES.some((table) => validation.missingTables.includes(table));

  if (!derivedViable) {
    phases.push({
      name: "derived_rebuild",
      status: "skipped",
      detail: rebuildDerived
        ? "Skipped: required derived-view tables are missing from the restore."
        : "Skipped: derived rebuild was not requested (read-only probe).",
    });
    phases.push({
      name: "derived_verification",
      status: "skipped",
      detail: "Skipped because the derived rebuild did not run.",
    });
    if (rebuildDerived && !derivedViable) {
      repairSteps.push(
        "Rebuild the derived views after restoring the missing tables (dashboard aggregates, derived cache) and re-run verification.",
      );
    }
    const failureCount = validation.failureCount + (rebuildDerived && !derivedViable ? 1 : 0);
    return {
      schema: RESTORE_VERIFICATION_SCHEMA,
      verifiedAt: now.toISOString(),
      readOnlyInvariants: true,
      status: failureCount > 0 ? "needs_review" : "valid",
      missingTables: validation.missingTables,
      invariantFailures,
      derived,
      failureCount,
      repairSteps,
      phases,
    };
  }

  // ── Phase 2: derived rebuild ───────────────────────────────────────────────
  let repairedAny = false;
  try {
    const refreshed = await refreshDashboardAggregates(prisma);
    derived.rebuilt = true;
    derived.refreshedScopes.push(refreshed.scope);
    phases.push({
      name: "derived_rebuild",
      status: "passed",
      detail: `Dashboard aggregates rebuilt for scope "${refreshed.scope}" at watermark ${refreshed.watermark.toISOString()}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    phases.push({
      name: "derived_rebuild",
      status: "failed",
      detail: `Derived rebuild failed: ${message}`,
    });
    repairSteps.push(
      `Investigate the derived-rebuild error (${message}), fix it, and re-run \`db:validate-restore --rebuild-derived\`. Derived views must not be served until the rebuild succeeds.`,
    );
    return {
      schema: RESTORE_VERIFICATION_SCHEMA,
      verifiedAt: now.toISOString(),
      readOnlyInvariants: true,
      status: "failed",
      missingTables: validation.missingTables,
      invariantFailures,
      derived,
      failureCount: validation.failureCount + 1,
      repairSteps,
      phases,
    };
  }

  // Stale derived-cache entries are measurement + optional repair.
  try {
    derived.staleBefore = await countStaleDerivedEntries(prisma, now);
  } catch (error) {
    phases.push({
      name: "derived_verification",
      status: "failed",
      detail: `Stale derived-entry scan failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    repairSteps.push(
      "The stale derived-cache scan failed. Confirm the derived_cache table was restored intact, then re-run verification.",
    );
    return {
      schema: RESTORE_VERIFICATION_SCHEMA,
      verifiedAt: now.toISOString(),
      readOnlyInvariants: true,
      status: "failed",
      missingTables: validation.missingTables,
      invariantFailures,
      derived,
      failureCount: validation.failureCount + 1,
      repairSteps,
      phases,
    };
  }

  if (derived.staleBefore !== null && derived.staleBefore > 0) {
    if (repairStaleDerived) {
      try {
        const repair = await repairStaleDerived(prisma, now);
        derived.repairedDerivedEntries = repair.repaired;
        derived.staleAfter = repair.remaining;
        repairedAny = repairedAny || repair.repaired > 0;
      } catch (error) {
        derived.staleAfter = derived.staleBefore;
        repairSteps.push(
          `Derived-cache repair failed: ${error instanceof Error ? error.message : String(error)}. Re-run the repair job; do not serve stale derived views.`,
        );
      }
    } else {
      derived.staleAfter = derived.staleBefore;
      repairSteps.push(
        `Repair ${derived.staleBefore} stale derived-cache entr${derived.staleBefore === 1 ? "y" : "ies"} with the derived-cache repair job, then re-run verification.`,
      );
    }
  } else {
    derived.staleAfter = derived.staleBefore;
  }

  // ── Phase 3: derived verification ──────────────────────────────────────────
  const verificationProblems: string[] = [];
  try {
    const alignment = await verifyDashboardAlignment(prisma);
    derived.aggregatePresent = alignment.aggregatePresent;
    derived.aggregateAligned = alignment.aligned;
    derived.aggregateSkewMs = Number.isFinite(alignment.skewMs) ? alignment.skewMs : null;

    if (!alignment.aggregatePresent) {
      verificationProblems.push(
        "No dashboard aggregate exists after the rebuild; confirm action_ledger rows were restored before re-running.",
      );
    } else if (!alignment.aligned) {
      verificationProblems.push(
        `Dashboard aggregate is ${alignment.skewMs} ms behind its source rows after the rebuild; re-run the rebuild and inspect concurrent writers.`,
      );
    }
    if (derived.staleAfter !== null && derived.staleAfter > 0) {
      verificationProblems.push(`${derived.staleAfter} derived-cache entr(ies) remain stale after repair.`);
    }
  } catch (error) {
    verificationProblems.push(
      `Derived-view verification failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  phases.push({
    name: "derived_verification",
    status: verificationProblems.length === 0 ? "passed" : "failed",
    detail: verificationProblems.length === 0 ? "Derived views align with their source rows." : verificationProblems.join(" "),
  });
  repairSteps.push(...verificationProblems);

  const failureCount = validation.failureCount + verificationProblems.length;
  const status: RestoreVerificationStatus =
    failureCount > 0 ? "needs_review" : repairedAny ? "repaired" : "valid";

  return {
    schema: RESTORE_VERIFICATION_SCHEMA,
    verifiedAt: now.toISOString(),
    readOnlyInvariants: true,
    status,
    missingTables: validation.missingTables,
    invariantFailures,
    derived,
    failureCount,
    repairSteps,
    phases,
  };
}
