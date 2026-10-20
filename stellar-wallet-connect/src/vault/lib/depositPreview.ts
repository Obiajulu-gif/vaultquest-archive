/**
 * Vault deposit preview simulation engine (#685).
 *
 * Simulates post-deposit pool state including:
 * - Strategy exposure ratio & amount
 * - Idle pool liquidity & reserve ratio
 * - Withdrawal queue pressure, coverage ratio, and deficit
 * - Deterministic risk threshold warnings
 *
 * Complexity:
 * - Time Complexity: O(1)
 * - Space Complexity: O(1)
 */

import type { PoolSummary } from "../contract/types";

export const DEFAULT_MAX_STRATEGY_EXPOSURE_BPS = 8500; // 85.00%
export const DEFAULT_MIN_IDLE_RATIO_BPS = 1500; // 15.00%

export type WarningCode = "HIGH_STRATEGY_EXPOSURE" | "LOW_IDLE_LIQUIDITY" | "QUEUED_WITHDRAWAL_PRESSURE";

export interface RiskWarning {
  code: WarningCode;
  message: string;
  severity: "warning" | "danger";
}

export type QueuePressureLevel = "none" | "moderate" | "high" | "critical";

export interface DepositPreviewResult {
  depositAmount: number;
  currentTvl: number;
  postDepositTvl: number;

  currentStrategyExposureBps: number;
  postDepositStrategyExposureBps: number;
  currentStrategyAmount: number;
  postDepositStrategyAmount: number;

  currentIdleLiquidity: number;
  postDepositIdleLiquidity: number;
  currentIdleRatioBps: number;
  postDepositIdleRatioBps: number;

  queuedWithdrawals: number;
  queueCoverageRatio: number;
  queueDeficit: number;
  queuePressureLevel: QueuePressureLevel;

  warnings: RiskWarning[];
  exceedsRiskThreshold: boolean;
}

/**
 * Calculates post-deposit pool state preview given the current pool summary and deposit amount.
 *
 * @param pool Current vault pool summary
 * @param depositAmount Raw deposit amount (string or number)
 * @returns Complete post-deposit preview and risk warnings
 */
export function calculateDepositPreview(
  pool: PoolSummary,
  depositAmount: string | number,
): DepositPreviewResult {
  const deposit = typeof depositAmount === "number" ? depositAmount : parseFloat(depositAmount) || 0;
  const clampedDeposit = Math.max(0, deposit);

  const currentTvl = Math.max(0, parseFloat(pool.tvl) || 0);
  const postDepositTvl = currentTvl + clampedDeposit;

  // Default strategy exposure is 80% (8000 bps) if not explicitly set on pool summary
  const currentStrategyExposureBps = pool.strategyExposureBps ?? 8000;
  const currentStrategyAmount = (currentTvl * currentStrategyExposureBps) / 10000;

  // Default idle liquidity is TVL - strategy amount if unconfigured
  const currentIdleLiquidity =
    pool.idleLiquidity !== undefined
      ? Math.max(0, parseFloat(pool.idleLiquidity) || 0)
      : Math.max(0, currentTvl - currentStrategyAmount);

  // New deposits initially enter as idle liquidity before pool rebalancing
  const postDepositIdleLiquidity = currentIdleLiquidity + clampedDeposit;
  const postDepositStrategyAmount = currentStrategyAmount;

  const postDepositStrategyExposureBps =
    postDepositTvl > 0
      ? Math.round((postDepositStrategyAmount / postDepositTvl) * 10000)
      : currentStrategyExposureBps;

  const currentIdleRatioBps =
    currentTvl > 0 ? Math.round((currentIdleLiquidity / currentTvl) * 10000) : 2000;

  const postDepositIdleRatioBps =
    postDepositTvl > 0
      ? Math.round((postDepositIdleLiquidity / postDepositTvl) * 10000)
      : 10000;

  // Queued withdrawals
  const queuedWithdrawals = Math.max(0, parseFloat(pool.queuedWithdrawals ?? "0") || 0);

  let queueCoverageRatio = Number.POSITIVE_INFINITY;
  let queueDeficit = 0;
  let queuePressureLevel: QueuePressureLevel = "none";

  if (queuedWithdrawals > 0) {
    queueCoverageRatio = postDepositIdleLiquidity / queuedWithdrawals;
    queueDeficit = Math.max(0, queuedWithdrawals - postDepositIdleLiquidity);

    if (queueCoverageRatio >= 1.5) {
      queuePressureLevel = "none";
    } else if (queueCoverageRatio >= 1.0) {
      queuePressureLevel = "moderate";
    } else if (queueCoverageRatio >= 0.5) {
      queuePressureLevel = "high";
    } else {
      queuePressureLevel = "critical";
    }
  }

  // Thresholds
  const maxStrategyExposureBps = pool.maxStrategyExposureBps ?? DEFAULT_MAX_STRATEGY_EXPOSURE_BPS;
  const minIdleRatioBps = pool.minIdleRatioBps ?? DEFAULT_MIN_IDLE_RATIO_BPS;

  const warnings: RiskWarning[] = [];

  // Warning 1: High strategy exposure
  if (postDepositStrategyExposureBps > maxStrategyExposureBps) {
    const currentPct = (postDepositStrategyExposureBps / 100).toFixed(1);
    const maxPct = (maxStrategyExposureBps / 100).toFixed(1);
    warnings.push({
      code: "HIGH_STRATEGY_EXPOSURE",
      message: `Strategy exposure (${currentPct}%) exceeds maximum target threshold of ${maxPct}%.`,
      severity: postDepositStrategyExposureBps > maxStrategyExposureBps + 500 ? "danger" : "warning",
    });
  }

  // Warning 2: Low idle liquidity reserve
  if (postDepositIdleRatioBps < minIdleRatioBps && postDepositTvl > 0) {
    const currentIdlePct = (postDepositIdleRatioBps / 100).toFixed(1);
    const minIdlePct = (minIdleRatioBps / 100).toFixed(1);
    warnings.push({
      code: "LOW_IDLE_LIQUIDITY",
      message: `Post-deposit idle reserve ratio (${currentIdlePct}%) is below minimum threshold of ${minIdlePct}%.`,
      severity: postDepositIdleRatioBps < minIdleRatioBps / 2 ? "danger" : "warning",
    });
  }

  // Warning 3: Withdrawal queue pressure
  if (queuedWithdrawals > 0 && queueDeficit > 0) {
    warnings.push({
      code: "QUEUED_WITHDRAWAL_PRESSURE",
      message: `High queue pressure: Post-deposit idle liquidity leaves ${queueDeficit.toFixed(2)} ${pool.asset} in queued withdrawals unfulfilled.`,
      severity: queueCoverageRatio < 0.5 ? "danger" : "warning",
    });
  }

  return {
    depositAmount: clampedDeposit,
    currentTvl,
    postDepositTvl,

    currentStrategyExposureBps,
    postDepositStrategyExposureBps,
    currentStrategyAmount,
    postDepositStrategyAmount,

    currentIdleLiquidity,
    postDepositIdleLiquidity,
    currentIdleRatioBps,
    postDepositIdleRatioBps,

    queuedWithdrawals,
    queueCoverageRatio,
    queueDeficit,
    queuePressureLevel,

    warnings,
    exceedsRiskThreshold: warnings.length > 0,
  };
}
