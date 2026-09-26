/**
 * Savings Service (#651)
 *
 * Orchestrates savings tracking and milestone updates for the frontend/quest
 * flows. This is a *mock* service powering local development, so it must
 * reproduce the contract's behavioral edge cases exactly (zero/negative
 * deposits rejected, claims that return a no-op rather than an error, lockup
 * windows). Its rules derive from `lib/conformance-spec.ts` — the same
 * fixtures the cross-stack conformance tests run — so divergence fails CI.
 *
 * Intentionally mocked behavior (documented in docs/VAULT_ENGAGEMENT_DATA.md):
 *  - In-memory state only (no persistence).
 *  - `blockchain` settlement is simulated synchronously; the real contract
 *    credits yield via `credit_yield`/`draw_winner` and transfers SAC tokens.
 */

import {
  validateDepositAmount,
  validateWithdrawLockup,
  validateClaimDeadline,
  claimableTotal,
  lockupMultiplierBps,
  type ContractBehaviorError,
} from "../lib/conformance-spec";

export interface QuestMilestone {
  id: string;
  description: string;
  targetAmount: number;
  deadline: number;
  isCompleted: boolean;
}

export interface Quest {
  id: string;
  title: string;
  description: string;
  sponsorAddress: string;
  rewardAmount: number;
  rewardToken: string;
  status: string;
  escrowId?: string;
  escrowStatus?: string;
  milestones: QuestMilestone[];
  createdAt: number;
  updatedAt: number;
}

export interface MilestoneProgress {
  completedAt: number | null;
}

export interface UserQuestParticipation {
  questId: string;
  userAddress: string;
  currentBalance: number;
  streakDays: number;
  lastDepositAt: number | null;
  yieldAccrued: number;
  prize: number;
  claimedReward: number;
  lockedUntilLedger: number;
  /** Unix ms after which no rewards may be claimed (mirrors pool deadline). */
  claimDeadline?: number | null;
  milestoneProgress: MilestoneProgress[];
  isEligibleForReward: boolean;
  updatedAt?: number | null;
}

/**
 * Contract-aligned deposit tracking.
 *
 * Mirrors `deposit` in the drip-pool contract: `amount <= 0` is rejected with
 * `InvalidAmount` before any state mutation.
 */
export const SavingsService = {
  /**
   * Validates a deposit against contract semantics.
   * @throws Error with message `InvalidAmount` when `amount <= 0`.
   */
  validateDeposit(amount: number): void {
    const err = validateDepositAmount(amount);
    if (err) throw new Error(err);
  },

  /**
   * Validates the lockup window before a principal withdrawal, mirroring
   * `withdraw`'s `LockupActive` guard.
   */
  validateWithdrawal(participation: UserQuestParticipation, currentLedger: number): void {
    const err = validateWithdrawLockup(participation.lockedUntilLedger, currentLedger);
    if (err) throw new Error(err);
  },

  /**
   * Computes the currently claimable amount, mirroring `claim_reward`: a value
   * `<= 0` is a no-op (the contract returns `Ok(0)`, never an error) unless
   * the claim deadline has already passed.
   */
  claimable(participation: UserQuestParticipation, now?: number): number {
    const deadlineErr = validateClaimDeadline(participation.claimDeadline, now ?? Date.now());
    if (deadlineErr) throw new Error(deadlineErr);
    const available = claimableTotal(
      participation.yieldAccrued,
      participation.prize,
      participation.claimedReward,
    );
    return available > 0 ? available : 0;
  },

  /**
   * Reward weight for a lockup tier. Mirrors `vault.rs::multiplier_for` and is
   * never applied to principal.
   */
  lockupWeightBps(lockupDays: number): number {
    return lockupMultiplierBps(lockupDays);
  },

  /**
   * Tracks a new deposit and updates participation state.
   * Rejects non-positive amounts with `InvalidAmount` before mutating anything.
   */
  async trackDeposit(
    quest: Quest,
    participation: UserQuestParticipation,
    amount: number,
  ): Promise<UserQuestParticipation> {
    const err = validateDepositAmount(amount);
    if (err) {
      throw new Error(err);
    }

    participation.currentBalance += amount;
    participation.streakDays += 1;
    participation.lastDepositAt = Date.now();

    quest.milestones.forEach((milestone, index) => {
      const progress = participation.milestoneProgress[index];
      if (!progress) return;
      if (participation.currentBalance >= milestone.targetAmount && progress.completedAt === null) {
        progress.completedAt = Date.now();
        milestone.isCompleted = true;
      }
    });

    participation.isEligibleForReward = participation.currentBalance > 0;
    participation.updatedAt = Date.now();

    return participation;
  },

  /**
   * Credits an earned reward. `claimedReward` stays monotonic — the contract
   * never allows double-claiming, mirroring `Ok(0)` no-op behavior when the
   * balance is already fully claimed.
   */
  async creditReward(participation: UserQuestParticipation, amount: number): Promise<number> {
    const err = validateDepositAmount(amount);
    if (err) throw new Error(err);
    participation.yieldAccrued += amount;
    return participation.yieldAccrued;
  },

  async claimReward(participation: UserQuestParticipation, now?: number): Promise<number> {
    const deadlineErr = validateClaimDeadline(participation.claimDeadline, now ?? Date.now());
    if (deadlineErr) throw new Error(deadlineErr);
    const available = claimableTotal(
      participation.yieldAccrued,
      participation.prize,
      participation.claimedReward,
    );
    if (available <= 0) return 0;
    participation.claimedReward += available;
    return available;
  },

  /**
   * Completes the next incomplete milestone slot. Idempotent: when every slot
   * is already completed it throws, mirroring "no milestone left to unlock".
   */
  unlockMilestone(participation: UserQuestParticipation, milestoneId: string): MilestoneProgress {
    const progress = participation.milestoneProgress.find((p) => p.completedAt === null);
    if (!progress) throw new Error(`milestone "${milestoneId}" not found or already completed`);
    progress.completedAt = Date.now();
    return progress;
  },
};

export function isContractBehaviorError(value: unknown): value is ContractBehaviorError {
  return (
    value === "InvalidAmount" ||
    value === "LockupActive" ||
    value === "InvalidAction" ||
    value === "ClaimDeadlinePassed"
  );
}