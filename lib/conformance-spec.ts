/**
 * Shared behavioral conformance spec (#651).
 *
 * Frontend service mocks and the wallet's in-memory contract mock power local
 * development, but they can silently diverge from the real Soroban contract.
 * This module is the single source of truth for the contract's *behavioral*
 * edge cases (as opposed to the static name/code mappings in the canonical
 * spec). Both the services in `services/` and the conformance tests in
 * `contracts/drip-pool/tests/` derive from it, so a mismatch anywhere fails CI.
 *
 * Edge cases mirrored from `contracts/drip-pool/src/lib.rs`:
 *  - `deposit`/`drip` reject `amount <= 0` with `InvalidAmount`
 *  - `withdraw` rejects before `locked_until` with `LockupActive`
 *  - `claim_reward` returns `Ok(0)` (a no-op, not an error) when nothing is
 *    claimable; after `deadline` it reverts with `ClaimDeadlinePassed`
 *  - `credit_yield` reverts with `InvalidAction` when it exceeds the
 *    distributable reserve
 *  - `draw_winner` rejects `prize <= 0` with `InvalidAmount`
 *  - lockup tiers map to reward-weight multipliers (never principal): 0d=100,
 *    1-7d=110, 8-14d=125, 15d+=150 bps
 */

export type ContractBehaviorError =
  | "InvalidAmount"
  | "LockupActive"
  | "InvalidAction"
  | "ClaimDeadlinePassed";

export type ConformanceStatus = "ok" | "noop" | "error";

export interface ConformanceCaseInputs {
  amount?: number | null;
  principal?: number | null;
  lockedUntil?: number | null;
  currentLedger?: number | null;
  yieldAccrued?: number | null;
  prize?: number | null;
  claimedReward?: number | null;
  distributableYield?: number | null;
  deadline?: number | null;
  now?: number | null;
  questReward?: number | null;
  lockupDays?: number | null;
}

export interface ConformanceCase {
  id: string;
  domain: "deposit" | "withdraw" | "claim" | "credit_yield" | "draw_winner" | "quest" | "lockup";
  label: string;
  /** Contract location the case mirrors (fn + file:line). */
  reference: string;
  inputs: ConformanceCaseInputs;
  expected: {
    status: ConformanceStatus;
    /** Canonical contract error name, only when `status === "error"`. */
    error?: ContractBehaviorError;
    /** Canonical numeric result, only for `ok`/`noop` when meaningful. */
    value?: number;
  };
}

// ── Semantic predicates (mirror the contract) ───────────────────────────────

export function validateDepositAmount(amount: number): ContractBehaviorError | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return "InvalidAmount";
  }
  return null;
}

export function validateWithdrawLockup(lockedUntil: number, currentLedger: number): ContractBehaviorError | null {
  return currentLedger < lockedUntil ? "LockupActive" : null;
}

export function validateClaimDeadline(deadline: number | null | undefined, now: number): ContractBehaviorError | null {
  if (deadline == null) return null;
  return now > deadline ? "ClaimDeadlinePassed" : null;
}

export function claimableTotal(yieldAccrued: number, prize: number, claimedReward: number): number {
  return yieldAccrued + prize - claimedReward;
}

export function validateCreditYield(amount: number, distributableYield: number): ContractBehaviorError | null {
  if (amount <= 0) return "InvalidAmount";
  if (amount > distributableYield) return "InvalidAction";
  return null;
}

export function validateDrawWinnerPrize(prize: number): ContractBehaviorError | null {
  return prize > 0 ? null : "InvalidAmount";
}

export function validateQuestReward(rewardAmount: number): ContractBehaviorError | null {
  return rewardAmount > 0 ? null : "InvalidAmount";
}

/**
 * Lockup tier / multipled-weights from `contracts/drip-pool/src/vault.rs`.
 * Multipliers are reward weights and are NEVER applied to principal.
 */
export function lockupMultiplierBps(lockupDays: number): number {
  if (lockupDays <= 0) return 100;
  if (lockupDays <= 7) return 110;
  if (lockupDays <= 14) return 125;
  return 150;
}

// ── Canonical evaluator ─────────────────────────────────────────────────────

export interface ConformanceEvaluation {
  status: ConformanceStatus;
  error?: ContractBehaviorError;
  value?: number;
}

function toNum(value: number | null | undefined): number {
  return typeof value === "number" ? value : 0;
}

/**
 * Executes a fixture against the canonical contract semantics. This is the
 * ground truth that every mock and service must reproduce.
 */
export function runCanonicalCase(cs: ConformanceCase): ConformanceEvaluation {
  const i = cs.inputs;
  switch (cs.domain) {
    case "deposit": {
      const err = validateDepositAmount(toNum(i.amount));
      return err ? { status: "error", error: err } : { status: "ok" };
    }
    case "withdraw": {
      const err = validateWithdrawLockup(toNum(i.lockedUntil), toNum(i.currentLedger));
      return err ? { status: "error", error: err } : { status: "ok", value: toNum(i.principal) };
    }
    case "claim": {
      const err = validateClaimDeadline(i.deadline, toNum(i.now));
      if (err) return { status: "error", error: err };
      const available = claimableTotal(toNum(i.yieldAccrued), toNum(i.prize), toNum(i.claimedReward));
      return available <= 0 ? { status: "noop", value: 0 } : { status: "ok", value: available };
    }
    case "credit_yield": {
      const err = validateCreditYield(toNum(i.amount), toNum(i.distributableYield));
      return err ? { status: "error", error: err } : { status: "ok" };
    }
    case "draw_winner": {
      const err = validateDrawWinnerPrize(toNum(i.prize));
      return err ? { status: "error", error: err } : { status: "ok" };
    }
    case "quest": {
      const err = validateQuestReward(toNum(i.questReward));
      return err ? { status: "error", error: err } : { status: "ok" };
    }
    case "lockup": {
      return { status: "ok", value: lockupMultiplierBps(toNum(i.lockupDays)) };
    }
    default: {
      const exhaustive: never = cs.domain;
      throw new Error(`Unknown conformance domain: ${String(exhaustive)}`);
    }
  }
}

// ── Behavioral fixtures ─────────────────────────────────────────────────────

/**
 * Canonical edge-case fixtures shared by the service mocks and the cross-stack
 * conformance tests. Adding a case here is how contract behavior is pinned:
 * both the frontend mocks and the tests must reproduce it.
 */
export const BEHAVIORAL_FIXTURES: ConformanceCase[] = [
  // Deposits (#651 — drip-pool deposit/drip reject amount <= 0)
  {
    id: "deposit-zero-rejected",
    domain: "deposit",
    label: "zero deposits are rejected with InvalidAmount",
    reference: "contracts/drip-pool/src/lib.rs:1057 (deposit)",
    inputs: { amount: 0 },
    expected: { status: "error", error: "InvalidAmount" },
  },
  {
    id: "deposit-negative-rejected",
    domain: "deposit",
    label: "negative deposits are rejected with InvalidAmount",
    reference: "contracts/drip-pool/src/lib.rs:1057 (deposit)",
    inputs: { amount: -10 },
    expected: { status: "error", error: "InvalidAmount" },
  },
  {
    id: "deposit-positive-accepted",
    domain: "deposit",
    label: "positive deposits are accepted",
    reference: "contracts/drip-pool/src/lib.rs:1057 (deposit)",
    inputs: { amount: 100 },
    expected: { status: "ok" },
  },
  // Withdrawals (time-locked principal)
  {
    id: "withdraw-before-lockup-rejected",
    domain: "withdraw",
    label: "withdraw before lockup end is rejected with LockupActive",
    reference: "contracts/drip-pool/src/lib.rs:1345 (withdraw)",
    inputs: { principal: 500, lockedUntil: 1000, currentLedger: 999 },
    expected: { status: "error", error: "LockupActive" },
  },
  {
    id: "withdraw-after-lockup-succeeds",
    domain: "withdraw",
    label: "withdraw after lockup end returns principal",
    reference: "contracts/drip-pool/src/lib.rs:1345 (withdraw)",
    inputs: { principal: 500, lockedUntil: 1000, currentLedger: 1000 },
    expected: { status: "ok", value: 500 },
  },
  // Claims (Ok(0) no-op unlike an error)
  {
    id: "claim-nothing-available-is-noop",
    domain: "claim",
    label: "claim with nothing available returns Ok(0), not an error",
    reference: "contracts/drip-pool/src/lib.rs:1211 (claim_reward)",
    inputs: { yieldAccrued: 0, prize: 0, claimedReward: 0, deadline: null, now: 5 },
    expected: { status: "noop", value: 0 },
  },
  {
    id: "claim-fully-claimed-is-noop",
    domain: "claim",
    label: "claim after rewards already claimed returns Ok(0)",
    reference: "contracts/drip-pool/src/lib.rs:1211 (claim_reward)",
    inputs: { yieldAccrued: 100, prize: 0, claimedReward: 100, deadline: null, now: 5 },
    expected: { status: "noop", value: 0 },
  },
  {
    id: "claim-available-succeeds",
    domain: "claim",
    label: "claim with a positive balance succeeds and pays the delta",
    reference: "contracts/drip-pool/src/lib.rs:1211 (claim_reward)",
    inputs: { yieldAccrued: 100, prize: 25, claimedReward: 50, deadline: null, now: 5 },
    expected: { status: "ok", value: 75 },
  },
  {
    id: "claim-after-deadline-rejected",
    domain: "claim",
    label: "claim after the deadline is rejected with ClaimDeadlinePassed",
    reference: "contracts/drip-pool/src/lib.rs:1211 (claim_reward)",
    inputs: { yieldAccrued: 100, prize: 0, claimedReward: 0, deadline: 1000, now: 1001 },
    expected: { status: "error", error: "ClaimDeadlinePassed" },
  },
  {
    id: "claim-at-deadline-allowed",
    domain: "claim",
    label: "claim at the exact deadline instant is still allowed",
    reference: "contracts/drip-pool/src/lib.rs:1211 (claim_reward)",
    inputs: { yieldAccrued: 100, prize: 0, claimedReward: 0, deadline: 1000, now: 1000 },
    expected: { status: "ok", value: 100 },
  },
  // Yield crediting (reserve cap)
  {
    id: "credit-yield-over-cap-rejected",
    domain: "credit_yield",
    label: "yield credit above the distributable reserve is rejected",
    reference: "contracts/drip-pool/src/lib.rs:1669 (credit_yield)",
    inputs: { amount: 200, distributableYield: 100 },
    expected: { status: "error", error: "InvalidAction" },
  },
  {
    id: "credit-yield-within-cap-succeeds",
    domain: "credit_yield",
    label: "yield credit within the reserve is accepted",
    reference: "contracts/drip-pool/src/lib.rs:1669 (credit_yield)",
    inputs: { amount: 100, distributableYield: 100 },
    expected: { status: "ok" },
  },
  // Prize draws
  {
    id: "draw-zero-prize-rejected",
    domain: "draw_winner",
    label: "a zero prize draw is rejected with InvalidAmount",
    reference: "contracts/drip-pool/src/lib.rs:1866 (draw_winner)",
    inputs: { prize: 0 },
    expected: { status: "error", error: "InvalidAmount" },
  },
  {
    id: "draw-positive-prize-succeeds",
    domain: "draw_winner",
    label: "a positive prize draw is accepted",
    reference: "contracts/drip-pool/src/lib.rs:1866 (draw_winner)",
    inputs: { prize: 1000 },
    expected: { status: "ok" },
  },
  // Quest rewards
  {
    id: "quest-zero-reward-rejected",
    domain: "quest",
    label: "quest reward pools must be funded (reward > 0)",
    reference: "services/questService.ts (createChallenge)",
    inputs: { questReward: 0 },
    expected: { status: "error", error: "InvalidAmount" },
  },
  {
    id: "quest-positive-reward-succeeds",
    domain: "quest",
    label: "a funded quest is accepted",
    reference: "services/questService.ts (createChallenge)",
    inputs: { questReward: 500 },
    expected: { status: "ok" },
  },
  // Lockup weight tiers (vault.rs)
  {
    id: "lockup-flexible-weight",
    domain: "lockup",
    label: "flexible (0d) lockup has 100 bps weight",
    reference: "contracts/drip-pool/src/vault.rs:21 (multiplier_for)",
    inputs: { lockupDays: 0 },
    expected: { status: "ok", value: 100 },
  },
  {
    id: "lockup-short-weight",
    domain: "lockup",
    label: "short (1-7d) lockup has 110 bps weight",
    reference: "contracts/drip-pool/src/vault.rs:21 (multiplier_for)",
    inputs: { lockupDays: 7 },
    expected: { status: "ok", value: 110 },
  },
  {
    id: "lockup-medium-weight",
    domain: "lockup",
    label: "medium (8-14d) lockup has 125 bps weight",
    reference: "contracts/drip-pool/src/vault.rs:21 (multiplier_for)",
    inputs: { lockupDays: 14 },
    expected: { status: "ok", value: 125 },
  },
  {
    id: "lockup-long-weight",
    domain: "lockup",
    label: "long (15d+) lockup has 150 bps weight",
    reference: "contracts/drip-pool/src/vault.rs:21 (multiplier_for)",
    inputs: { lockupDays: 15 },
    expected: { status: "ok", value: 150 },
  },
];