/**
 * Consumer-driven contract tests — CONFORMANCE consumer (#742).
 *
 * The cross-stack conformance suite in `contracts/drip-pool` consumes the shared
 * `services/` helpers (it imports `SavingsService` and the quest helpers in
 * `mock-conformance.test.ts`). These tests pin the specific semantic guarantees
 * that the contract ↔ frontend conformance layer depends on, by the stable IDs
 * in `services/CONTRACT.md`, so a semantically breaking change to `services/`
 * fails this consumer's suite.
 *
 * Runs via `pnpm test:conformance` and `.github/workflows/conformance.yml`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SavingsService } from "../../../services/savingsService";
import {
  createChallenge,
  joinChallenge,
  updateProgress,
  getAllChallenges,
  __resetQuestDb,
} from "../../../services/questService";

function participation() {
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
  };
}

describe("SavingsService guarantees the conformance layer depends on", () => {
  it("SAV-3: claim_reward is Ok(0) — a no-op, not an error — when nothing is claimable", async () => {
    const p = participation();
    expect(SavingsService.claimable(p)).toBe(0);
    await expect(SavingsService.claimReward(p)).resolves.toBe(0);
  });

  it("SAV-5: claimable equals yield + prize - claimed and never double-claims", async () => {
    const p = { ...participation(), yieldAccrued: 100, prize: 50, claimedReward: 30 };
    expect(SavingsService.claimable(p)).toBe(120);
    await expect(SavingsService.claimReward(p)).resolves.toBe(120);
    await expect(SavingsService.claimReward(p)).resolves.toBe(0);
  });

  it("SAV-6: lockup reward-weight tiers match the canonical spec (0/110/125/150 bps)", () => {
    expect(SavingsService.lockupWeightBps(0)).toBe(100);
    expect(SavingsService.lockupWeightBps(7)).toBe(110);
    expect(SavingsService.lockupWeightBps(14)).toBe(125);
    expect(SavingsService.lockupWeightBps(30)).toBe(150);
  });

  it("SAV-1/SAV-2: non-positive deposit and active lockup revert with the contract error codes", () => {
    expect(() => SavingsService.validateDeposit(0)).toThrow("InvalidAmount");
    expect(() =>
      SavingsService.validateWithdrawal({ ...participation(), lockedUntilLedger: 10 }, 5),
    ).toThrow("LockupActive");
  });
});

describe("questService guarantees the conformance layer depends on", () => {
  beforeEach(() => __resetQuestDb());

  it("QST-1: an unfunded quest reward pool is rejected", async () => {
    await expect(createChallenge("t", "d", "GB", 0, "USDC", [10])).rejects.toThrow(
      "InvalidAmount",
    );
  });

  it("QST-5: progress is monotonic (a regression reverts with InvalidAmount)", async () => {
    const active = getAllChallenges().find((q) => q.status === "ACTIVE")!;
    await joinChallenge(active.id, "GUSER");
    await updateProgress(active.id, "GUSER", 200);
    await expect(updateProgress(active.id, "GUSER", 100)).rejects.toThrow(
      "InvalidAmount",
    );
  });
});
