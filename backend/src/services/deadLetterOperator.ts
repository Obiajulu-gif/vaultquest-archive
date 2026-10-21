/**
 * Operator tooling to inspect and retry dead-letter background jobs (#980).
 *
 * When a job exhausts its retry budget (or fails non-retryably) the worker
 * moves it to the `dead` state (see `worker/jobWorker.ts`). Operators need to
 * answer two questions without touching the database by hand:
 *
 *   - what is sitting in the dead-letter state right now (volume, by type, why
 *     it died)?  -> {@link summarizeDeadLetters}
 *   - which of them should we requeue, optionally filtered by type and bounded
 *     so a single command can't requeue the world? -> {@link planDeadLetterRetries}
 *
 * Both functions are pure over a list of {@link JobRecord}s so they are
 * trivially testable and the actual requeue stays a thin caller over
 * `JobQueue.retryDeadJob`. Retrying is always operator-initiated and reversible
 * (a requeued job that fails again simply dead-letters once more).
 */

import type { JobRecord } from "../worker/types.js";

export interface DeadLetterSummary {
  total: number;
  byType: Record<string, number>;
  byLastErrorCode: Record<string, number>;
  /** Sum of recorded failed attempts across the dead jobs. */
  totalFailedAttempts: number;
  /** Jobs whose last failure was flagged retryable — safe to requeue as-is. */
  retryable: number;
  /** Jobs whose last failure was non-retryable — requeue only after a fix. */
  nonRetryable: number;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

export function isDeadLetter(job: JobRecord): boolean {
  return job.status === "dead";
}

/** Aggregates the dead-letter backlog for an operator dashboard or CLI. */
export function summarizeDeadLetters(jobs: readonly JobRecord[]): DeadLetterSummary {
  const byType: Record<string, number> = {};
  const byLastErrorCode: Record<string, number> = {};
  let total = 0;
  let totalFailedAttempts = 0;
  let retryable = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const job of jobs) {
    if (!isDeadLetter(job)) continue;
    total += 1;
    byType[job.type] = (byType[job.type] ?? 0) + 1;
    const code = job.lastError?.code ?? "UNKNOWN";
    byLastErrorCode[code] = (byLastErrorCode[code] ?? 0) + 1;
    totalFailedAttempts += job.failures.length;
    if (job.lastError?.retryable) retryable += 1;
    const t = new Date(job.createdAt).getTime();
    if (oldest === null || t < oldest) oldest = t;
    if (newest === null || t > newest) newest = t;
  }

  return {
    total,
    byType,
    byLastErrorCode,
    totalFailedAttempts,
    retryable,
    nonRetryable: total - retryable,
    oldestCreatedAt: oldest === null ? null : new Date(oldest).toISOString(),
    newestCreatedAt: newest === null ? null : new Date(newest).toISOString()
  };
}

export interface DeadLetterRetryPlan {
  /** Ids to requeue, oldest first so the backlog drains in arrival order. */
  candidates: string[];
  /** Jobs considered but not selected, with the reason they were left alone. */
  skipped: Array<{ id: string; reason: "not_dead" | "type_filtered" | "limit_reached" }>;
}

/**
 * Selects dead jobs to requeue. Only `dead` jobs are ever candidates; the
 * `type` filter and `limit` keep an operator retry bounded and intentional.
 */
export function planDeadLetterRetries(
  jobs: readonly JobRecord[],
  options: { limit?: number; type?: string } = {}
): DeadLetterRetryPlan {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const candidates: string[] = [];
  const skipped: DeadLetterRetryPlan["skipped"] = [];
  const ordered = [...jobs].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  for (const job of ordered) {
    if (!isDeadLetter(job)) {
      skipped.push({ id: job.id, reason: "not_dead" });
      continue;
    }
    if (options.type && job.type !== options.type) {
      skipped.push({ id: job.id, reason: "type_filtered" });
      continue;
    }
    if (candidates.length >= limit) {
      skipped.push({ id: job.id, reason: "limit_reached" });
      continue;
    }
    candidates.push(job.id);
  }

  return { candidates, skipped };
}
