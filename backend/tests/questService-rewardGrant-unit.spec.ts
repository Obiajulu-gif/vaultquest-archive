import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { QuestService } from "../src/services/questService.js";

function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test"
  });
}

function idempotencyKeyFor(walletAddress: string, questId: string): string {
  return createHash("sha256").update(`${walletAddress}:${questId}`).digest("hex");
}

/**
 * #505 — evaluateWallet now wraps the RewardGrant insert and UserQuest
 * write in `prisma.$transaction(async (tx) => ...)` so a crash between
 * the two writes can never leave one committed without the other. In
 * these mocked-Prisma unit tests, `$transaction` just invokes the
 * callback with the same mock client standing in for `tx` — this is the
 * standard way to unit-test Prisma's interactive-transaction API without
 * a real database, and still exercises the real code path (the
 * transaction callback itself), not a stubbed-out no-op.
 */
function withTransactionMock(mockPrisma: Record<string, unknown>) {
  mockPrisma.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
  return mockPrisma;
}

describe("QuestService reward-grant idempotency Unit Tests (No Database Required) (#505)", () => {
  it("evaluateWallet creates a RewardGrant with a deterministic idempotencyKey when a quest newly completes", async () => {
    const rewardGrantCreate = vi.fn(async () => ({}));
    const mockPrisma = withTransactionMock({
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        findMany: vi.fn(async () => []), // no prior rows — everything is a fresh evaluation
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: {
        create: rewardGrantCreate
      }
    }) as any;

    const svc = new QuestService(mockPrisma);
    await svc.evaluateWallet("GWALLET1");

    // first_win completes on a single confirmed claim (target: 1).
    expect(rewardGrantCreate).toHaveBeenCalledWith({
      data: {
        walletAddress: "GWALLET1",
        questId: "first_win",
        idempotencyKey: idempotencyKeyFor("GWALLET1", "first_win")
      }
    });
  });

  it("does not create a duplicate RewardGrant for a quest that was already completed", async () => {
    const rewardGrantCreate = vi.fn(async () => ({}));
    const mockPrisma = withTransactionMock({
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        // first_win was already completed in a prior sweep.
        findMany: vi.fn(async () => [
          {
            questId: "first_win",
            progress: 1,
            status: "completed",
            completedAt: new Date("2026-01-01T00:00:00Z")
          }
        ]),
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: { create: rewardGrantCreate }
    }) as any;

    const svc = new QuestService(mockPrisma);
    await svc.evaluateWallet("GWALLET1");

    expect(rewardGrantCreate).not.toHaveBeenCalled();
  });

  it("swallows a P2002 unique-violation when a grant for this wallet/quest already exists (idempotent insert)", async () => {
    const mockPrisma = withTransactionMock({
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: {
        create: vi.fn(async () => {
          throw makeP2002Error();
        })
      }
    }) as any;

    const svc = new QuestService(mockPrisma);
    // Must not throw — a concurrent/replayed grant-intent insert racing
    // us here is the expected, correct outcome of idempotency, not an error.
    await expect(svc.evaluateWallet("GWALLET1")).resolves.toBeDefined();
  });

  it("rethrows a non-P2002 error from grant creation", async () => {
    const mockPrisma = withTransactionMock({
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      userQuest: {
        findMany: vi.fn(async () => []),
        upsert: vi.fn(async () => ({})),
        update: vi.fn(async () => ({}))
      },
      rewardGrant: {
        create: vi.fn(async () => {
          throw new Error("connection reset");
        })
      }
    }) as any;

    const svc = new QuestService(mockPrisma);
    await expect(svc.evaluateWallet("GWALLET1")).rejects.toThrow("connection reset");
  });
});

describe("QuestService.processGrants Unit Tests (No Database Required) (#505)", () => {
  it("marks pending grants as granted (placeholder payout, pending #505 clarification)", async () => {
    const grant = { id: "g1", attempts: 0, status: "pending" };
    const mockPrisma = {
      rewardGrant: {
        findMany: vi.fn(async () => [grant]),
        update: vi.fn(async () => ({}))
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.processGrants();

    expect(result).toEqual({ granted: 1, failed: 0 });
    expect(mockPrisma.rewardGrant.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: expect.objectContaining({ status: "granted", attempts: 1 })
    });
  });

  it("only fetches grants below maxAttempts, so exhausted grants are excluded from the query", async () => {
    const findMany = vi.fn(async () => []);
    const mockPrisma = { rewardGrant: { findMany, update: vi.fn() } } as any;

    const svc = new QuestService(mockPrisma);
    await svc.processGrants(5);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "pending", attempts: { lt: 5 } }
      })
    );
  });

  it("increments attempts and stays pending on failure below maxAttempts", async () => {
    const grant = { id: "g1", attempts: 1, status: "pending" };
    const mockPrisma = {
      rewardGrant: {
        findMany: vi.fn(async () => [grant]),
        update: vi
          .fn()
          .mockRejectedValueOnce(new Error("payout failed"))
          .mockResolvedValueOnce({})
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.processGrants(5);

    expect(result).toEqual({ granted: 0, failed: 1 });
    expect(mockPrisma.rewardGrant.update).toHaveBeenNthCalledWith(2, {
      where: { id: "g1" },
      data: {
        attempts: 2,
        lastError: "payout failed",
        status: "pending" // 2 < 5, stays pending for another retry
      }
    });
  });

  it("flips to failed (dead-letter) once attempts reaches maxAttempts", async () => {
    const grant = { id: "g1", attempts: 4, status: "pending" }; // one more failure hits maxAttempts=5
    const mockPrisma = {
      rewardGrant: {
        findMany: vi.fn(async () => [grant]),
        update: vi
          .fn()
          .mockRejectedValueOnce(new Error("payout failed"))
          .mockResolvedValueOnce({})
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.processGrants(5);

    expect(result).toEqual({ granted: 0, failed: 1 });
    expect(mockPrisma.rewardGrant.update).toHaveBeenNthCalledWith(2, {
      where: { id: "g1" },
      data: {
        attempts: 5,
        lastError: "payout failed",
        status: "failed" // 5 >= 5 maxAttempts — dead-lettered, not retried again
      }
    });
  });
});

describe("QuestService.flagGrantsForReorgedActions Unit Tests (No Database Required) (#505)", () => {
  it("flags a granted reward as needs_review when its quest no longer meets its target after a reversion", async () => {
    // Wallet had a single confirmed claim funding first_win (target 1);
    // that action has since reverted (reorg/refund), so no confirmed
    // actions remain and first_win no longer computes as completed.
    const mockPrisma = {
      actionLedger: { findMany: vi.fn(async () => []) }, // reverted action excluded — nothing confirmed remains
      rewardGrant: {
        findMany: vi.fn(async () => [
          { id: "g1", walletAddress: "GWALLET1", questId: "first_win", status: "granted" }
        ]),
        update: vi.fn(async () => ({}))
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.flagGrantsForReorgedActions(["GWALLET1"]);

    expect(result).toEqual({ flagged: 1 });
    expect(mockPrisma.rewardGrant.update).toHaveBeenCalledWith({
      where: { id: "g1" },
      data: {
        status: "needs_review",
        lastError: expect.stringContaining("reverted/refunded")
      }
    });
  });

  it("does not flag a granted reward whose quest still meets its target", async () => {
    const mockPrisma = {
      actionLedger: {
        findMany: vi.fn(async () => [
          { actionType: "claim", actionPayload: { vault_id: "p" }, createdAt: new Date() }
        ])
      },
      rewardGrant: {
        findMany: vi.fn(async () => [
          { id: "g1", walletAddress: "GWALLET1", questId: "first_win", status: "granted" }
        ]),
        update: vi.fn(async () => ({}))
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    const result = await svc.flagGrantsForReorgedActions(["GWALLET1"]);

    expect(result).toEqual({ flagged: 0 });
    expect(mockPrisma.rewardGrant.update).not.toHaveBeenCalled();
  });

  it("only inspects grants with status=granted, ignoring pending/failed/needs_review rows", async () => {
    const mockPrisma = {
      actionLedger: { findMany: vi.fn(async () => []) },
      rewardGrant: {
        findMany: vi.fn(async (args: any) => {
          expect(args.where).toEqual({ walletAddress: "GWALLET1", status: "granted" });
          return [];
        }),
        update: vi.fn(async () => ({}))
      }
    } as any;

    const svc = new QuestService(mockPrisma);
    await svc.flagGrantsForReorgedActions(["GWALLET1"]);

    expect(mockPrisma.rewardGrant.findMany).toHaveBeenCalled();
  });
});
