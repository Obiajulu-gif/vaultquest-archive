/**
 * Deployment rollback verification checks (issue #1124).
 *
 * When an operator rolls back a backend deployment, three things must be
 * confirmed before serving traffic:
 *
 *  1. **Schema compatibility** — the rolled-back binary's Prisma schema
 *     matches the live database's migration history.  A schema mismatch means
 *     ORM queries will fail or silently corrupt data.
 *
 *  2. **Action-ledger consistency** — no actions were written by the
 *     now-reverted binary that are incompatible with the rolled-back code
 *     (e.g. actions with status values or payload shapes the older code does
 *     not understand).
 *
 *  3. **Derived-view staleness** — cached projections (dashboard aggregates,
 *     derived cache) may have been populated by the newer binary's
 *     aggregation logic and must be flushed or rebuilt to avoid a
 *     version-mismatch in reads.
 *
 * The service is intentionally read-first / loud-on-failure:
 * - Every check produces an explicit `RollbackCheckResult` entry.
 * - The final verdict is `passed` only when every required check passes.
 * - Callers control `dryRun` — in dry-run mode no writes occur; every
 *   recommended action is returned as a `repairStep` string instead.
 * - All deps are injected so the service is fully unit-testable with mock
 *   Prisma without a real database.
 *
 * Usage — called by the deployment pipeline after rolling back a release:
 *
 *   const report = await verifyRollback(prisma, { dryRun: true });
 *   if (report.verdict !== "passed") {
 *     logger.error(report, "Rollback verification failed — do not serve traffic");
 *     process.exit(1);
 *   }
 */

import type { PrismaClient } from "@prisma/client";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const ROLLBACK_VERIFICATION_SCHEMA = "vaultquest.rollback-verification.v1";

export type RollbackVerdictStatus = "passed" | "failed" | "needs_review";

export type RollbackCheckStatus = "passed" | "failed" | "skipped" | "warning";

export interface RollbackCheckResult {
  /** Short machine-readable check identifier. */
  name: string;
  status: RollbackCheckStatus;
  /** Human-readable summary of what was checked and what was found. */
  detail: string;
  /** Recommended operator action when status is not "passed". */
  repairStep?: string;
}

export interface RollbackVerificationReport {
  schema: typeof ROLLBACK_VERIFICATION_SCHEMA;
  verifiedAt: string;
  /** Binary version/commit hash being rolled back *to* (caller-supplied). */
  targetVersion: string;
  dryRun: boolean;
  verdict: RollbackVerdictStatus;
  checks: RollbackCheckResult[];
  /** Every actionable repair step, consolidated for easy operator consumption. */
  repairSteps: string[];
  /** Number of checks that did not pass (failed + needs_review). */
  failureCount: number;
}

// ─── Dependency injection interface ──────────────────────────────────────────

export interface RollbackVerificationDeps {
  /**
   * Returns the number of pending Prisma migrations that have not yet been
   * applied to the live database.  Zero means schema is in sync.
   * Defaults to a Prisma `$queryRaw` introspection query.
   */
  countPendingMigrations?: (prisma: PrismaClient) => Promise<number>;

  /**
   * Returns the most recent migration name applied to the live database,
   * or null if the _prisma_migrations table is absent/empty.
   */
  getLatestAppliedMigration?: (prisma: PrismaClient) => Promise<string | null>;

  /**
   * Returns the number of action_ledger rows whose `status` is not among the
   * set of values the rolled-back binary understands.
   * Defaults to a query against the known legacy-safe status set.
   */
  countUnrecognisedActionStatuses?: (
    prisma: PrismaClient,
    knownStatuses: string[],
  ) => Promise<number>;

  /**
   * Returns the number of action_ledger rows whose `actionType` is not in the
   * provided known set.
   */
  countUnrecognisedActionTypes?: (
    prisma: PrismaClient,
    knownTypes: string[],
  ) => Promise<number>;

  /**
   * Counts derived-cache entries that were written after `writtenAfter`.
   * Used to detect entries that may have been produced by the now-reverted
   * binary's aggregation logic.
   */
  countDerivedCacheEntriesAfter?: (
    prisma: PrismaClient,
    writtenAfter: Date,
  ) => Promise<number>;

  /**
   * Flushes (deletes) all derived-cache entries written after `writtenAfter`.
   * Only called when `dryRun` is false.
   * Returns the number of entries deleted.
   */
  flushDerivedCacheAfter?: (prisma: PrismaClient, writtenAfter: Date) => Promise<number>;

  /**
   * Counts dashboard_aggregates rows whose `updatedAt` is after `writtenAfter`.
   */
  countDashboardAggregatesAfter?: (
    prisma: PrismaClient,
    writtenAfter: Date,
  ) => Promise<number>;

  /**
   * Deletes dashboard_aggregates rows written after `writtenAfter`.
   * Only called when `dryRun` is false.
   */
  flushDashboardAggregatesAfter?: (
    prisma: PrismaClient,
    writtenAfter: Date,
  ) => Promise<number>;

  now?: () => Date;
}

// ─── Options ─────────────────────────────────────────────────────────────────

export interface RollbackVerificationOptions {
  /**
   * The version/commit being rolled back *to* — used for labelling only.
   * Defaults to "unknown".
   */
  targetVersion?: string;

  /**
   * When true (default), no writes are performed; repair steps are reported
   * but not executed.
   */
  dryRun?: boolean;

  /**
   * The deployment timestamp of the binary being rolled back *from*.
   * Used to scope the derived-view staleness check to rows written by the
   * now-reverted binary.  Defaults to 1 hour ago.
   */
  rolledBackDeployedAt?: Date;

  /**
   * Action statuses the rolled-back binary understands.
   * Defaults to the set that has been stable since the initial ledger design.
   */
  knownActionStatuses?: string[];

  /**
   * Action types the rolled-back binary understands.
   * Defaults to the core set.
   */
  knownActionTypes?: string[];

  deps?: RollbackVerificationDeps;
}

// ─── Default known-value sets (conservative legacy-safe lists) ───────────────

const DEFAULT_KNOWN_ACTION_STATUSES = [
  "pending",
  "submitted",
  "confirmed",
  "failed",
  "reverted",
  "orphaned",
];

const DEFAULT_KNOWN_ACTION_TYPES = [
  "deposit",
  "withdraw",
  "join",
  "drip",
  "claim",
  "transfer",
];

// ─── Default dep implementations ─────────────────────────────────────────────

async function defaultCountPendingMigrations(prisma: PrismaClient): Promise<number> {
  try {
    // `_prisma_migrations` is the standard table Prisma uses.
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL
    `;
    return Number(rows[0]?.count ?? 0);
  } catch {
    // If the table doesn't exist the migration history is unreadable.
    return -1;
  }
}

async function defaultGetLatestAppliedMigration(prisma: PrismaClient): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

async function defaultCountUnrecognisedActionStatuses(
  prisma: PrismaClient,
  knownStatuses: string[],
): Promise<number> {
  return prisma.actionLedger.count({
    where: {
      status: { notIn: knownStatuses },
    },
  });
}

async function defaultCountUnrecognisedActionTypes(
  prisma: PrismaClient,
  knownTypes: string[],
): Promise<number> {
  return prisma.actionLedger.count({
    where: {
      actionType: { notIn: knownTypes },
    },
  });
}

async function defaultCountDerivedCacheEntriesAfter(
  prisma: PrismaClient,
  writtenAfter: Date,
): Promise<number> {
  return prisma.derivedCache.count({
    where: { updatedAt: { gt: writtenAfter } },
  });
}

async function defaultFlushDerivedCacheAfter(
  prisma: PrismaClient,
  writtenAfter: Date,
): Promise<number> {
  const result = await prisma.derivedCache.deleteMany({
    where: { updatedAt: { gt: writtenAfter } },
  });
  return result.count;
}

async function defaultCountDashboardAggregatesAfter(
  prisma: PrismaClient,
  writtenAfter: Date,
): Promise<number> {
  return prisma.dashboardAggregate.count({
    where: { updatedAt: { gt: writtenAfter } },
  });
}

async function defaultFlushDashboardAggregatesAfter(
  prisma: PrismaClient,
  writtenAfter: Date,
): Promise<number> {
  const result = await prisma.dashboardAggregate.deleteMany({
    where: { updatedAt: { gt: writtenAfter } },
  });
  return result.count;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run all rollback verification checks.  Call this immediately after a
 * deployment rollback, before the rolled-back binary starts serving traffic.
 *
 * Returns a structured report.  The caller must check `report.verdict` and
 * refuse traffic when it is not `"passed"`.
 */
export async function verifyRollback(
  prisma: PrismaClient,
  options: RollbackVerificationOptions = {},
): Promise<RollbackVerificationReport> {
  const {
    targetVersion = "unknown",
    dryRun = true,
    knownActionStatuses = DEFAULT_KNOWN_ACTION_STATUSES,
    knownActionTypes = DEFAULT_KNOWN_ACTION_TYPES,
    deps = {},
  } = options;

  const now = (deps.now ?? (() => new Date()))();
  const rolledBackDeployedAt =
    options.rolledBackDeployedAt ?? new Date(now.getTime() - 60 * 60 * 1000);

  const countPendingMigrations = deps.countPendingMigrations ?? defaultCountPendingMigrations;
  const getLatestAppliedMigration =
    deps.getLatestAppliedMigration ?? defaultGetLatestAppliedMigration;
  const countUnrecognisedActionStatuses =
    deps.countUnrecognisedActionStatuses ?? defaultCountUnrecognisedActionStatuses;
  const countUnrecognisedActionTypes =
    deps.countUnrecognisedActionTypes ?? defaultCountUnrecognisedActionTypes;
  const countDerivedCacheEntriesAfter =
    deps.countDerivedCacheEntriesAfter ?? defaultCountDerivedCacheEntriesAfter;
  const flushDerivedCacheAfter = deps.flushDerivedCacheAfter ?? defaultFlushDerivedCacheAfter;
  const countDashboardAggregatesAfter =
    deps.countDashboardAggregatesAfter ?? defaultCountDashboardAggregatesAfter;
  const flushDashboardAggregatesAfter =
    deps.flushDashboardAggregatesAfter ?? defaultFlushDashboardAggregatesAfter;

  const checks: RollbackCheckResult[] = [];
  const repairSteps: string[] = [];

  // ── Check 1: Prisma migration history is readable ─────────────────────────
  let latestMigration: string | null = null;
  try {
    latestMigration = await getLatestAppliedMigration(prisma);
    checks.push({
      name: "migration_history_readable",
      status: "passed",
      detail: latestMigration
        ? `Latest applied migration: "${latestMigration}".`
        : "Migration history table exists but no migrations have been applied.",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "migration_history_readable",
      status: "failed",
      detail: `Cannot read Prisma migration history: ${msg}`,
      repairStep:
        "Verify the database is reachable and the _prisma_migrations table exists before proceeding.",
    });
    repairSteps.push(
      "Cannot read migration history — verify database connectivity and re-run rollback verification.",
    );
  }

  // ── Check 2: No pending unapplied migrations ──────────────────────────────
  try {
    const pending = await countPendingMigrations(prisma);
    if (pending === -1) {
      checks.push({
        name: "schema_migrations_applied",
        status: "failed",
        detail:
          "Cannot introspect pending migrations — _prisma_migrations table is unreadable. Schema state is unknown.",
        repairStep:
          "Re-run `prisma migrate status` against the live database; resolve any unreachable-database or missing-table errors before serving traffic.",
      });
      repairSteps.push(
        "Prisma migration table is unreadable. Run `prisma migrate status` to diagnose.",
      );
    } else if (pending > 0) {
      checks.push({
        name: "schema_migrations_applied",
        status: "failed",
        detail: `${pending} Prisma migration(s) are recorded but not yet applied to the live database. The rolled-back binary may issue queries that reference non-existent columns or tables.`,
        repairStep:
          "Run `prisma migrate deploy` against the live database, or restore a database snapshot that pre-dates these migrations, before starting the rolled-back binary.",
      });
      repairSteps.push(
        `Apply or revert ${pending} pending migration(s) before the rolled-back binary serves traffic.`,
      );
    } else {
      checks.push({
        name: "schema_migrations_applied",
        status: "passed",
        detail: "Database schema is fully in sync with the rolled-back binary's migration history.",
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "schema_migrations_applied",
      status: "failed",
      detail: `Migration status check failed: ${msg}`,
      repairStep: "Resolve the database error and re-run rollback verification.",
    });
    repairSteps.push(`Migration check error: ${msg}`);
  }

  // ── Check 3: Action statuses are all in the known set ────────────────────
  try {
    const unknown = await countUnrecognisedActionStatuses(prisma, knownActionStatuses);
    if (unknown > 0) {
      checks.push({
        name: "action_ledger_status_compatibility",
        status: "failed",
        detail: `${unknown} action_ledger row(s) carry status values the rolled-back binary does not recognise. Serving these actions may cause unhandled exceptions or silently incorrect behaviour.`,
        repairStep:
          "Inspect those rows and either revert them to a known status or keep the newer binary deployed. Known statuses: " +
          knownActionStatuses.join(", ") +
          ".",
      });
      repairSteps.push(
        `${unknown} action(s) have unrecognised status values. Review before rolling back.`,
      );
    } else {
      checks.push({
        name: "action_ledger_status_compatibility",
        status: "passed",
        detail: `All action_ledger rows use status values recognised by the rolled-back binary (${knownActionStatuses.join(", ")}).`,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "action_ledger_status_compatibility",
      status: "warning",
      detail: `Could not scan action_ledger for unrecognised statuses: ${msg}`,
      repairStep: "Manually verify action_ledger statuses before serving traffic.",
    });
    repairSteps.push(`Action status scan failed: ${msg}`);
  }

  // ── Check 4: Action types are all in the known set ────────────────────────
  try {
    const unknown = await countUnrecognisedActionTypes(prisma, knownActionTypes);
    if (unknown > 0) {
      checks.push({
        name: "action_ledger_type_compatibility",
        status: "failed",
        detail: `${unknown} action_ledger row(s) carry actionType values the rolled-back binary does not handle. Known types: ${knownActionTypes.join(", ")}.`,
        repairStep:
          "Review those action rows and confirm the rolled-back binary has code paths for every type currently in the ledger before allowing it to process a queue.",
      });
      repairSteps.push(
        `${unknown} action(s) have unrecognised actionType values. Do not process the action queue until these are resolved.`,
      );
    } else {
      checks.push({
        name: "action_ledger_type_compatibility",
        status: "passed",
        detail: `All action_ledger rows use actionType values handled by the rolled-back binary.`,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "action_ledger_type_compatibility",
      status: "warning",
      detail: `Could not scan action_ledger for unrecognised action types: ${msg}`,
      repairStep: "Manually verify action types in the ledger before serving traffic.",
    });
    repairSteps.push(`Action type scan failed: ${msg}`);
  }

  // ── Check 5: Derived-cache entries from the reverted binary ──────────────
  let derivedCacheFlushed = 0;
  try {
    const staleCount = await countDerivedCacheEntriesAfter(prisma, rolledBackDeployedAt);
    if (staleCount > 0) {
      if (!dryRun) {
        try {
          derivedCacheFlushed = await flushDerivedCacheAfter(prisma, rolledBackDeployedAt);
          checks.push({
            name: "derived_cache_staleness",
            status: "passed",
            detail: `Flushed ${derivedCacheFlushed} derived-cache entries written after ${rolledBackDeployedAt.toISOString()} (reverted binary window).`,
          });
        } catch (flushError) {
          const msg = flushError instanceof Error ? flushError.message : String(flushError);
          checks.push({
            name: "derived_cache_staleness",
            status: "failed",
            detail: `Found ${staleCount} stale derived-cache entries but flush failed: ${msg}`,
            repairStep:
              "Manually delete derived_cache rows with updatedAt after " +
              rolledBackDeployedAt.toISOString() +
              " and re-run rollback verification.",
          });
          repairSteps.push(`Derived-cache flush failed: ${msg}`);
        }
      } else {
        checks.push({
          name: "derived_cache_staleness",
          status: "warning",
          detail: `${staleCount} derived-cache entries were written after ${rolledBackDeployedAt.toISOString()} and may carry data from the reverted binary. (dry-run: not flushed)`,
          repairStep:
            "Re-run rollback verification with dryRun=false to flush these entries, or delete them manually.",
        });
        repairSteps.push(
          `Flush ${staleCount} derived-cache entries written after ${rolledBackDeployedAt.toISOString()} (re-run with dryRun=false or delete manually).`,
        );
      }
    } else {
      checks.push({
        name: "derived_cache_staleness",
        status: "passed",
        detail: `No derived-cache entries found from the reverted binary window (after ${rolledBackDeployedAt.toISOString()}).`,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "derived_cache_staleness",
      status: "warning",
      detail: `Could not check derived-cache staleness: ${msg}`,
      repairStep:
        "Manually inspect the derived_cache table for entries written during the reverted binary's deployment window.",
    });
    repairSteps.push(`Derived-cache staleness check failed: ${msg}`);
  }

  // ── Check 6: Dashboard aggregates from the reverted binary ───────────────
  try {
    const staleAggregates = await countDashboardAggregatesAfter(prisma, rolledBackDeployedAt);
    if (staleAggregates > 0) {
      if (!dryRun) {
        try {
          const flushed = await flushDashboardAggregatesAfter(prisma, rolledBackDeployedAt);
          checks.push({
            name: "dashboard_aggregate_staleness",
            status: "passed",
            detail: `Flushed ${flushed} dashboard_aggregate rows written after ${rolledBackDeployedAt.toISOString()}.`,
          });
        } catch (flushError) {
          const msg = flushError instanceof Error ? flushError.message : String(flushError);
          checks.push({
            name: "dashboard_aggregate_staleness",
            status: "failed",
            detail: `Found ${staleAggregates} stale dashboard_aggregate rows but flush failed: ${msg}`,
            repairStep:
              "Manually delete dashboard_aggregates rows with updatedAt after " +
              rolledBackDeployedAt.toISOString() +
              " and re-run rollback verification.",
          });
          repairSteps.push(`Dashboard aggregate flush failed: ${msg}`);
        }
      } else {
        checks.push({
          name: "dashboard_aggregate_staleness",
          status: "warning",
          detail: `${staleAggregates} dashboard_aggregate rows were written after ${rolledBackDeployedAt.toISOString()} and may carry data from the reverted binary. (dry-run: not flushed)`,
          repairStep:
            "Re-run rollback verification with dryRun=false to flush these aggregates, or delete them manually.",
        });
        repairSteps.push(
          `Flush ${staleAggregates} dashboard_aggregate rows written after ${rolledBackDeployedAt.toISOString()} (re-run with dryRun=false or delete manually).`,
        );
      }
    } else {
      checks.push({
        name: "dashboard_aggregate_staleness",
        status: "passed",
        detail: `No dashboard_aggregate rows found from the reverted binary window (after ${rolledBackDeployedAt.toISOString()}).`,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "dashboard_aggregate_staleness",
      status: "warning",
      detail: `Could not check dashboard_aggregate staleness: ${msg}`,
      repairStep:
        "Manually inspect dashboard_aggregates for rows written during the reverted binary's deployment window.",
    });
    repairSteps.push(`Dashboard aggregate check failed: ${msg}`);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────

  const failureCount = checks.filter(
    (c) => c.status === "failed" || c.status === "warning",
  ).length;

  const anyFailed = checks.some((c) => c.status === "failed");
  const anyWarning = checks.some((c) => c.status === "warning");

  const verdict: RollbackVerdictStatus = anyFailed
    ? "failed"
    : anyWarning
      ? "needs_review"
      : "passed";

  return {
    schema: ROLLBACK_VERIFICATION_SCHEMA,
    verifiedAt: now.toISOString(),
    targetVersion,
    dryRun,
    verdict,
    checks,
    repairSteps,
    failureCount,
  };
}
