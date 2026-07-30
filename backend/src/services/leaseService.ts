/**
 * Distributed job leases with fencing tokens (#506).
 *
 * Coordinates cron/indexer/reconciler workers across replicas so at most
 * one worker runs a given named job at a time, and a worker that resumes
 * after its lease has already expired and been taken over can detect that
 * via a stale fencing token rather than silently continuing to act as if
 * it still holds the job.
 *
 * Mirrors LedgerService.acquireLease/renewLease/releaseLease's existing
 * CAS (compare-and-swap) pattern — a unique-constraint insert, with
 * takeover only permitted once the existing row's expiresAt has passed —
 * but keyed by a stable jobName instead of a per-action id, and adds a
 * fencingToken that increments on every successful acquisition (including
 * takeovers).
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

export interface AcquireJobLeaseInput {
  jobName: string;
  workerId: string;
  ttlMs: number;
}

export interface JobLeaseHandle {
  jobName: string;
  workerId: string;
  fencingToken: bigint;
}

export class LeaseService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Attempts to acquire (or take over an expired) lease for `jobName`.
   * Returns the lease handle (including the fencing token to use for
   * guarded writes) on success, or null if another worker currently holds
   * an unexpired lease.
   */
  async acquireJobLease(input: AcquireJobLeaseInput): Promise<JobLeaseHandle | null> {
    const { jobName, workerId, ttlMs } = input;
    const expiresAt = new Date(Date.now() + ttlMs);

    try {
      const created = await this.prisma.jobLease.create({
        data: { jobName, workerId, expiresAt, fencingToken: 1n }
      });
      return { jobName, workerId, fencingToken: created.fencingToken };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") {
        throw err;
      }
      // Lease row already exists — only take over if it has expired, and
      // bump the fencing token as part of the same conditional update so
      // a concurrent taker can't win the race and silently produce two
      // holders with the same token.
      const now = new Date();
      const result = await this.prisma.$queryRaw<Array<{ fencing_token: bigint }>>(
        Prisma.sql`
          UPDATE job_leases
          SET worker_id = ${workerId},
              acquired_at = ${now},
              expires_at = ${expiresAt},
              fencing_token = fencing_token + 1
          WHERE job_name = ${jobName} AND expires_at <= ${now}
          RETURNING fencing_token
        `
      );

      if (result.length === 0) {
        return null; // Active lease held by a different worker.
      }
      return { jobName, workerId, fencingToken: result[0]!.fencing_token };
    }
  }

  /**
   * Extends an already-held lease's expiry. Only succeeds if `workerId`
   * still matches the current holder AND `fencingToken` still matches the
   * lease's current token AND the lease has not already expired.
   *
   * All three checks matter: matching `workerId` alone is not enough — if
   * this worker's lease already lapsed (e.g. a GC pause stalled the
   * process past its TTL) but no other worker has taken over *yet*, a
   * naive `WHERE jobName AND workerId` update would silently "renew" an
   * already-dead lease, defeating the entire point of expiry-based
   * takeover safety: a lease that expired must never be resurrected by
   * its own former holder, only re-acquired via acquireJobLease's
   * explicit takeover path (which bumps the fencing token). Checking
   * `fencingToken` too closes the narrower race where a takeover commits
   * between this worker's own expiry and its renewal attempt — the
   * fencing token will already have moved, so the conditional update's
   * WHERE clause excludes the row even if `expiresAt` and `workerId`
   * checks alone would have raced.
   */
  async renewJobLease(
    jobName: string,
    workerId: string,
    fencingToken: bigint,
    ttlMs: number
  ): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(Date.now() + ttlMs);
    const result = await this.prisma.jobLease.updateMany({
      where: { jobName, workerId, fencingToken, expiresAt: { gt: now } },
      data: { expiresAt }
    });
    return result.count > 0;
  }

  /**
   * Releases a held lease. Deliberately NOT called on job failure —
   * letting the lease expire naturally forces a cooldown before another
   * worker (or the same one, after a crash) can re-acquire, rather than
   * an immediate retry loop hammering a job that just failed.
   */
  async releaseJobLease(jobName: string, workerId: string): Promise<void> {
    await this.prisma.jobLease.deleteMany({ where: { jobName, workerId } });
  }

  /**
   * Verifies a fencing token is still current for `jobName` — i.e. no
   * other worker has taken over since `fencingToken` was issued. Callers
   * doing a guarded write should check this (or fold the check directly
   * into their own WHERE clause) immediately before committing, since the
   * token can go stale at any point during a long-running tick.
   */
  async isFencingTokenCurrent(jobName: string, fencingToken: bigint): Promise<boolean> {
    const lease = await this.prisma.jobLease.findUnique({ where: { jobName } });
    return lease !== null && lease.fencingToken === fencingToken;
  }
}
