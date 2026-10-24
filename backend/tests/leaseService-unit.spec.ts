import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { LeaseService } from "../src/services/leaseService.js";

function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test"
  });
}

describe("LeaseService.acquireJobLease Unit Tests (No Database Required) (#506)", () => {
  it("acquires a fresh lease when no row exists, with fencingToken 1", async () => {
    const created = { jobName: "quest-evaluation", workerId: "w1", fencingToken: 1n };
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => created)
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    const handle = await svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w1", ttlMs: 60_000 });

    expect(handle).toEqual({ jobName: "quest-evaluation", workerId: "w1", fencingToken: 1n });
  });

  it("takes over an expired lease and bumps the fencing token", async () => {
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => {
          throw makeP2002Error();
        })
      },
      $queryRaw: vi.fn(async () => [{ fencing_token: 5n }])
    } as any;

    const svc = new LeaseService(mockPrisma);
    const handle = await svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w2", ttlMs: 60_000 });

    expect(handle).toEqual({ jobName: "quest-evaluation", workerId: "w2", fencingToken: 5n });
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("returns null when an unexpired lease is held by another worker", async () => {
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => {
          throw makeP2002Error();
        })
      },
      // No rows updated => the conditional UPDATE's WHERE clause excluded
      // the row because expires_at is still in the future.
      $queryRaw: vi.fn(async () => [])
    } as any;

    const svc = new LeaseService(mockPrisma);
    const handle = await svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w2", ttlMs: 60_000 });

    expect(handle).toBeNull();
  });

  it("rethrows non-P2002 errors instead of treating them as a lock conflict", async () => {
    const mockPrisma = {
      jobLease: {
        create: vi.fn(async () => {
          throw new Error("connection reset");
        })
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    await expect(
      svc.acquireJobLease({ jobName: "quest-evaluation", workerId: "w1", ttlMs: 60_000 })
    ).rejects.toThrow("connection reset");
  });
});

describe("LeaseService.renewJobLease Unit Tests (#506)", () => {
  it("renews when the caller still holds an unexpired lease with a matching fencing token", async () => {
    const updateMany = vi.fn(async (_args: { where: Record<string, unknown>; data: unknown }) => ({
      count: 1
    }));
    const mockPrisma = { jobLease: { updateMany } } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.renewJobLease("quest-evaluation", "w1", 3n, 60_000)).toBe(true);

    // The WHERE clause must guard on workerId, fencingToken, AND
    // expiresAt > now — matching workerId alone is not a sufficient
    // renewal guard (see the doc comment on renewJobLease).
    const whereArg = updateMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(whereArg.jobName).toBe("quest-evaluation");
    expect(whereArg.workerId).toBe("w1");
    expect(whereArg.fencingToken).toBe(3n);
    expect(whereArg.expiresAt).toHaveProperty("gt");
  });

  it("fails to renew once another worker has taken over (workerId no longer matches)", async () => {
    const mockPrisma = {
      jobLease: { updateMany: vi.fn(async () => ({ count: 0 })) }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.renewJobLease("quest-evaluation", "w1", 3n, 60_000)).toBe(false);
  });

  it("fails to renew once the fencing token is stale, even if workerId still matches", async () => {
    // Simulates: this worker's own lease already lapsed and was taken
    // over, then handed right back (e.g. a retry loop) before this
    // worker's heartbeat runs — the fencingToken from the ORIGINAL
    // acquisition is now stale even though workerId happens to match
    // again. The WHERE clause's fencingToken check must reject this.
    const mockPrisma = {
      jobLease: { updateMany: vi.fn(async () => ({ count: 0 })) }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.renewJobLease("quest-evaluation", "w1", 1n /* stale */, 60_000)).toBe(false);
  });

  it("fails to renew a lease that has already expired, even under the original holder's own workerId", async () => {
    // This is the core bug this guard exists to close: a lapsed lease
    // must never be silently resurrected by its own former holder just
    // because no other worker has taken over YET. Real Postgres would
    // exclude the row via `expiresAt > now()` in the WHERE clause; here
    // we assert the query was actually built with that guard rather than
    // trusting workerId alone.
    const updateMany = vi.fn(async (_args: { where: Record<string, unknown>; data: unknown }) => ({
      count: 0
    }));
    const mockPrisma = { jobLease: { updateMany } } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.renewJobLease("quest-evaluation", "w1", 1n, 60_000)).toBe(false);
    expect(updateMany.mock.calls[0]![0].where).toHaveProperty("expiresAt");
  });
});

describe("LeaseService.isFencingTokenCurrent Unit Tests (#506)", () => {
  it("returns true when the token matches the current lease row", async () => {
    const mockPrisma = {
      jobLease: {
        findUnique: vi.fn(async () => ({ jobName: "quest-evaluation", workerId: "w1", fencingToken: 3n }))
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.isFencingTokenCurrent("quest-evaluation", 3n)).toBe(true);
  });

  it("returns false once the token has been superseded by a takeover", async () => {
    const mockPrisma = {
      jobLease: {
        findUnique: vi.fn(async () => ({ jobName: "quest-evaluation", workerId: "w2", fencingToken: 4n }))
      }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.isFencingTokenCurrent("quest-evaluation", 3n)).toBe(false);
  });

  it("returns false when the lease row no longer exists", async () => {
    const mockPrisma = {
      jobLease: { findUnique: vi.fn(async () => null) }
    } as any;

    const svc = new LeaseService(mockPrisma);
    expect(await svc.isFencingTokenCurrent("quest-evaluation", 1n)).toBe(false);
  });
});
