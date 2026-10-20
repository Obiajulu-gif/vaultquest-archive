import { randomUUID } from "node:crypto";
import type { EnqueueInput, JobFailure, JobRecord, ListJobsParams } from "./types.js";

export interface ClaimOptions {
  workerId: string;
  now: Date;
  /** A `running` job locked longer ago than this is presumed orphaned and reclaimable. */
  visibilityTimeoutMs: number;
  limit: number;
}

export interface FailOutcome {
  failure: JobFailure;
  /** Move to the dead-letter state instead of rescheduling. */
  dead: boolean;
  /** Next run time when not dead. */
  retryAt?: Date;
}

/**
 * Persistence for jobs. `complete` and `fail` are fenced by `workerId`: if
 * another worker reclaimed the job in the meantime they return false and the
 * caller must not assume its result was recorded.
 */
export interface JobStore {
  enqueue(input: Required<Pick<EnqueueInput, "maxAttempts">> & EnqueueInput, now: Date): Promise<{ job: JobRecord; created: boolean }>;
  claim(opts: ClaimOptions): Promise<JobRecord[]>;
  complete(id: string, workerId: string, now: Date): Promise<boolean>;
  fail(id: string, workerId: string, outcome: FailOutcome, now: Date): Promise<boolean>;
  get(id: string): Promise<JobRecord | null>;
  list(params?: ListJobsParams): Promise<JobRecord[]>;
  /** Puts a dead job back in the queue with a fresh attempt budget. */
  requeueDead(id: string, now: Date): Promise<JobRecord | null>;
}

/** Reference implementation; used by tests and single-process development. */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  async enqueue(input: EnqueueInput & { maxAttempts: number }, now: Date) {
    for (const j of this.jobs.values()) {
      if (j.idempotencyKey === input.idempotencyKey) return { job: clone(j), created: false };
    }
    const job: JobRecord = {
      id: randomUUID(),
      type: input.type,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts,
      runAt: input.runAt ?? now,
      lockedBy: null,
      lockedAt: null,
      correlationId: input.correlationId ?? null,
      lastError: null,
      failures: [],
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    this.jobs.set(job.id, job);
    return { job: clone(job), created: true };
  }

  async claim({ workerId, now, visibilityTimeoutMs, limit }: ClaimOptions) {
    const cutoff = now.getTime() - visibilityTimeoutMs;
    const due = [...this.jobs.values()]
      .filter(
        (j) =>
          (j.status === "queued" && j.runAt <= now) ||
          (j.status === "running" && j.lockedAt !== null && j.lockedAt.getTime() <= cutoff)
      )
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, limit);
    for (const j of due) {
      j.status = "running";
      j.attempts += 1;
      j.lockedBy = workerId;
      j.lockedAt = now;
      j.updatedAt = now;
    }
    return due.map(clone);
  }

  async complete(id: string, workerId: string, now: Date) {
    const j = this.jobs.get(id);
    if (!j || j.status !== "running" || j.lockedBy !== workerId) return false;
    j.status = "succeeded";
    j.lockedBy = null;
    j.lockedAt = null;
    j.completedAt = now;
    j.updatedAt = now;
    return true;
  }

  async fail(id: string, workerId: string, { failure, dead, retryAt }: FailOutcome, now: Date) {
    const j = this.jobs.get(id);
    if (!j || j.status !== "running" || j.lockedBy !== workerId) return false;
    j.failures.push(failure);
    j.lastError = failure;
    j.lockedBy = null;
    j.lockedAt = null;
    j.updatedAt = now;
    if (dead) {
      j.status = "dead";
      j.completedAt = now;
    } else {
      j.status = "queued";
      j.runAt = retryAt ?? now;
    }
    return true;
  }

  async get(id: string) {
    const j = this.jobs.get(id);
    return j ? clone(j) : null;
  }

  async list({ status, type, limit = 50 }: ListJobsParams = {}) {
    return [...this.jobs.values()]
      .filter((j) => (!status || j.status === status) && (!type || j.type === type))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async requeueDead(id: string, now: Date) {
    const j = this.jobs.get(id);
    if (!j || j.status !== "dead") return null;
    j.status = "queued";
    j.attempts = 0;
    j.runAt = now;
    j.completedAt = null;
    j.updatedAt = now;
    return clone(j);
  }
}

function clone(j: JobRecord): JobRecord {
  return { ...j, failures: [...j.failures] };
}
