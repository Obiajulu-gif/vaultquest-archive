/**
 * Consumer-driven contract tests — FRONTEND consumer (#742).
 *
 * The frontend/dashboard consumes the shared `services/` helpers. These tests
 * assert the semantic guarantees the frontend relies on, by the stable IDs in
 * `services/CONTRACT.md`, so a semantically breaking change to `services/`
 * (even a type-compatible one) fails here rather than in production.
 *
 * Runs on every PR via `pnpm test` (`.github/workflows/validation.yml`).
 */

import { describe, it, expect, beforeEach } from "vitest";

// NOTE: `EscrowService` (escrowService.ts) is documented in CONTRACT.md (ESC-1,
// ESC-2) but is intentionally NOT exercised here: it imports `@/lib/escrow/*`
// modules that do not yet exist in the repo, so it is not importable/consumed by
// any build today. Its executable contract test lands with those modules.

import { SavingsService, type UserQuestParticipation } from "../savingsService";
import {
  createChallenge,
  joinChallenge,
  updateProgress,
  getAllChallenges,
  __resetQuestDb,
} from "../questService";

function participation(
  overrides: Partial<UserQuestParticipation> = {},
): UserQuestParticipation {
  return {
    questId: "q_1",
    userAddress: "GUSER",
    currentBalance: 0,
    streakDays: 0,
    lastDepositAt: null,
    yieldAccrued: 0,
    prize: 0,
    claimedReward: 0,
    lockedUntilLedger: 0,
    claimDeadline: null,
    milestoneProgress: [],
    isEligibleForReward: false,
    ...overrides,
  };
}

describe("SavingsService contract (frontend consumer)", () => {
  it("SAV-1: rejects non-positive / non-finite deposits before mutating", async () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => SavingsService.validateDeposit(bad)).toThrow("InvalidAmount");
    }
    const p = participation({ currentBalance: 10 });
    await expect(
      SavingsService.trackDeposit(
        { milestones: [] } as never,
        p,
        -5,
      ),
    ).rejects.toThrow("InvalidAmount");
    expect(p.currentBalance).toBe(10); // unchanged
  });

  it("SAV-2: enforces the lockup window", () => {
    const p = participation({ lockedUntilLedger: 100 });
    expect(() => SavingsService.validateWithdrawal(p, 99)).toThrow("LockupActive");
    expect(() => SavingsService.validateWithdrawal(p, 100)).not.toThrow();
  });

  it("SAV-3: claim is a no-op (returns 0), never an error, when nothing is claimable", async () => {
    const p = participation({ yieldAccrued: 0, prize: 0, claimedReward: 0 });
    expect(SavingsService.claimable(p)).toBe(0);
    await expect(SavingsService.claimReward(p)).resolves.toBe(0);
  });

  it("SAV-4: claim reverts after the deadline; null deadline never expires", async () => {
    const expired = participation({ yieldAccrued: 5, claimDeadline: 1_000 });
    expect(() => SavingsService.claimable(expired, 2_000)).toThrow("ClaimDeadlinePassed");
    await expect(SavingsService.claimReward(expired, 2_000)).rejects.toThrow(
      "ClaimDeadlinePassed",
    );
    const noDeadline = participation({ yieldAccrued: 5, claimDeadline: null });
    expect(SavingsService.claimable(noDeadline, 9_999)).toBe(5);
  });

  it("SAV-5: claimable = yield + prize - claimed, and a second claim yields 0", async () => {
    const p = participation({ yieldAccrued: 30, prize: 20, claimedReward: 5 });
    expect(SavingsService.claimable(p)).toBe(45);
    await expect(SavingsService.claimReward(p)).resolves.toBe(45);
    expect(p.claimedReward).toBe(50);
    await expect(SavingsService.claimReward(p)).resolves.toBe(0); // no double-claim
  });

  it("SAV-6: lockup reward-weight tiers (bps)", () => {
    expect(SavingsService.lockupWeightBps(0)).toBe(100);
    expect(SavingsService.lockupWeightBps(-3)).toBe(100);
    expect(SavingsService.lockupWeightBps(1)).toBe(110);
    expect(SavingsService.lockupWeightBps(7)).toBe(110);
    expect(SavingsService.lockupWeightBps(8)).toBe(125);
    expect(SavingsService.lockupWeightBps(14)).toBe(125);
    expect(SavingsService.lockupWeightBps(15)).toBe(150);
    expect(SavingsService.lockupWeightBps(365)).toBe(150);
  });

  it("SAV-7: valid deposit updates balance, streak, milestones, and eligibility", async () => {
    const quest = {
      milestones: [
        { id: "m1", description: "", targetAmount: 50, deadline: 0, isCompleted: false },
      ],
    };
    const p = participation({ milestoneProgress: [{ completedAt: null }] });
    await SavingsService.trackDeposit(quest as never, p, 50);
    expect(p.currentBalance).toBe(50);
    expect(p.streakDays).toBe(1);
    expect(p.isEligibleForReward).toBe(true);
    expect(quest.milestones[0].isCompleted).toBe(true);
    expect(p.milestoneProgress[0].completedAt).not.toBeNull();
  });
});

describe("questService contract (frontend consumer)", () => {
  beforeEach(() => __resetQuestDb());

  it("QST-1: rejects unfunded quests (reward <= 0)", async () => {
    await expect(
      createChallenge("t", "d", "GB", 0, "USDC", [10]),
    ).rejects.toThrow("InvalidAmount");
  });

  it("QST-2: escrow presence drives ACTIVE/FUNDED vs DRAFT/PENDING", async () => {
    const funded = await createChallenge("t", "d", "GB", 100, "USDC", [10], "tw_1");
    expect(funded.status).toBe("ACTIVE");
    expect(funded.escrowStatus).toBe("FUNDED");
    const draft = await createChallenge("t", "d", "GB", 100, "USDC", [10]);
    expect(draft.status).toBe("DRAFT");
    expect(draft.escrowStatus).toBe("PENDING");
  });

  it("QST-3: only funded, active quests are joinable", async () => {
    await expect(joinChallenge("does_not_exist", "GUSER")).rejects.toThrow(
      "Quest not found",
    );
    const draft = await createChallenge("t", "d", "GB", 100, "USDC", [10]); // DRAFT
    await expect(joinChallenge(draft.id, "GUSER")).rejects.toThrow(
      "not joinable",
    );
  });

  it("QST-4: join is idempotent and seeds one progress slot per milestone", async () => {
    const active = getAllChallenges().find((q) => q.status === "ACTIVE")!;
    const first = await joinChallenge(active.id, "GUSER");
    const second = await joinChallenge(active.id, "GUSER");
    expect(second).toBe(first); // same participation, no duplicate
    expect(first.milestoneProgress).toHaveLength(active.milestones.length);
  });

  it("QST-5: progress is monotonic and requires an existing participant", async () => {
    const active = getAllChallenges().find((q) => q.status === "ACTIVE")!;
    await joinChallenge(active.id, "GUSER");
    await updateProgress(active.id, "GUSER", 100);
    await expect(updateProgress(active.id, "GUSER", 50)).rejects.toThrow(
      "InvalidAmount",
    );
    await expect(updateProgress(active.id, "GHOST", 10)).rejects.toThrow(
      "Participation not found",
    );
  });
});
