import type { BackgroundJob, PrismaClient } from "@prisma/client";
import type { ClaimOptions, FailOutcome, JobStore } from "./jobStore.js";
import type { EnqueueInput, JobFailure, JobRecord, JobStatus, ListJobsParams } from "./types.js";

function toRecord(row: BackgroundJob): JobRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: row.runAt,
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt,
    correlationId: row.correlationId,
    lastError: (row.lastError as unknown as JobFailure | null) ?? null,
    failures: (row.failures as unknown as JobFailure[]) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

/**
 * Postgres-backed store. Claiming uses optimistic compare-and-swap
 * (`updateMany` conditioned on the row still being in the state we read), so
 * concurrent workers never execute the same claim twice and no row-level
 * locks are held while a handler runs.
 */
export class PrismaJobStore implements JobStore {
  constructor(private readonly prisma: PrismaClient) {}

  async enqueue(input: EnqueueInput & { maxAttempts: number }, now: Date) {
    const existing = await this.prisma.backgroundJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { job: toRecord(existing), created: false };
    try {
      const row = await this.prisma.backgroundJob.create({
        data: {
          type: input.type,
          payload: input.payload as object,
          idempotencyKey: input.idempotencyKey,
          maxAttempts: input.maxAttempts,
          runAt: input.runAt ?? now,
          correlationId: input.correlationId ?? null
        }
      });
      return { job: toRecord(row), created: true };
    } catch (err) {
      // Lost the race with a concurrent enqueue of the same key.
      if ((err as { code?: string } | null)?.code === "P2002") {
        const row = await this.prisma.backgroundJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (row) return { job: toRecord(row), created: false };
      }
      throw err;
    }
  }

  async claim({ workerId, now, visibilityTimeoutMs, limit }: ClaimOptions) {
    const cutoff = new Date(now.getTime() - visibilityTimeoutMs);
    const candidates = await this.prisma.backgroundJob.findMany({
      where: {
        OR: [
          { status: "queued", runAt: { lte: now } },
          { status: "running", lockedAt: { lte: cutoff } }
        ]
      },
      orderBy: { runAt: "asc" },
      take: limit
    });
    const claimed: JobRecord[] = [];
    for (const c of candidates) {
      const res = await this.prisma.backgroundJob.updateMany({
        where: { id: c.id, status: c.status, lockedAt: c.lockedAt, attempts: c.attempts },
        data: { status: "running", attempts: c.attempts + 1, lockedBy: workerId, lockedAt: now }
      });
      if (res.count === 1) {
        claimed.push(toRecord({ ...c, status: "running", attempts: c.attempts + 1, lockedBy: workerId, lockedAt: now }));
      }
    }
    return claimed;
  }

  async complete(id: string, workerId: string, now: Date) {
    const res = await this.prisma.backgroundJob.updateMany({
      where: { id, status: "running", lockedBy: workerId },
      data: { status: "succeeded", lockedBy: null, lockedAt: null, completedAt: now }
    });
    return res.count === 1;
  }

  async fail(id: string, workerId: string, { failure, dead, retryAt }: FailOutcome, now: Date) {
    const row = await this.prisma.backgroundJob.findUnique({ where: { id } });
    if (!row || row.status !== "running" || row.lockedBy !== workerId) return false;
    const failures = [...((row.failures as unknown as JobFailure[]) ?? []), failure];
    const res = await this.prisma.backgroundJob.updateMany({
      where: { id, status: "running", lockedBy: workerId },
      data: {
        status: dead ? "dead" : "queued",
        runAt: dead ? row.runAt : (retryAt ?? now),
        lockedBy: null,
        lockedAt: null,
        lastError: failure as unknown as object,
        failures: failures as unknown as object,
        completedAt: dead ? now : null
      }
    });
    return res.count === 1;
  }

  async get(id: string) {
    const row = await this.prisma.backgroundJob.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async list({ status, type, limit = 50 }: ListJobsParams = {}) {
    const rows = await this.prisma.backgroundJob.findMany({
      where: { ...(status ? { status } : {}), ...(type ? { type } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.map(toRecord);
  }

  async requeueDead(id: string, now: Date) {
    const res = await this.prisma.backgroundJob.updateMany({
      where: { id, status: "dead" },
      data: { status: "queued", attempts: 0, runAt: now, completedAt: null }
    });
    if (res.count !== 1) return null;
    return this.get(id);
  }
}
