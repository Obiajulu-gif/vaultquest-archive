import { describe, expect, it } from "vitest";
import type { PoolSummary } from "../contract/types";
import {
  calculateDepositPreview,
  DEFAULT_MAX_STRATEGY_EXPOSURE_BPS,
  DEFAULT_MIN_IDLE_RATIO_BPS,
} from "./depositPreview";

const mockBasePool: PoolSummary = {
  id: "pool_1",
  name: "USDC Yield Vault",
  status: "open",
  tvl: "10000",
  asset: "USDC",
  participantCount: 25,
  expectedYield: "5.2% APY",
  opensAt: null,
  locksAt: null,
  drawsAt: null,
  strategyExposureBps: 8000, // 80.00%
  idleLiquidity: "2000",
  queuedWithdrawals: "0",
  maxStrategyExposureBps: 8500, // 85.00%
  minIdleRatioBps: 1500, // 15.00%
};

describe("calculateDepositPreview", () => {
  it("calculates accurate post-deposit TVL, strategy exposure, and idle liquidity", () => {
    const preview = calculateDepositPreview(mockBasePool, "1000");

    expect(preview.depositAmount).toBe(1000);
    expect(preview.currentTvl).toBe(10000);
    expect(preview.postDepositTvl).toBe(11000);

    // Current strategy amount is 8000 USDC (80%), idle is 2000 USDC (20%)
    expect(preview.currentStrategyAmount).toBe(8000);
    expect(preview.currentIdleLiquidity).toBe(2000);

    // After 1000 deposit into idle: idle becomes 3000 USDC
    expect(preview.postDepositIdleLiquidity).toBe(3000);
    expect(preview.postDepositStrategyAmount).toBe(8000);

    // Strategy exposure drops to 8000 / 11000 = ~72.73% (7273 bps)
    expect(preview.postDepositStrategyExposureBps).toBe(7273);
    // Idle ratio becomes 3000 / 11000 = ~27.27% (2727 bps)
    expect(preview.postDepositIdleRatioBps).toBe(2727);

    expect(preview.warnings).toHaveLength(0);
    expect(preview.exceedsRiskThreshold).toBe(false);
  });

  it("triggers HIGH_STRATEGY_EXPOSURE warning when strategy exposure exceeds max threshold", () => {
    const highExposurePool: PoolSummary = {
      ...mockBasePool,
      tvl: "10000",
      strategyExposureBps: 9000, // 90.00%
      maxStrategyExposureBps: 8500, // 85.00%
      idleLiquidity: "1000",
    };

    const preview = calculateDepositPreview(highExposurePool, "100");

    expect(preview.postDepositStrategyExposureBps).toBe(8911); // 9000 / 10100
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "HIGH_STRATEGY_EXPOSURE",
          severity: "warning",
        }),
      ]),
    );
    expect(preview.exceedsRiskThreshold).toBe(true);
  });

  it("triggers LOW_IDLE_LIQUIDITY warning when idle liquidity ratio drops below min threshold", () => {
    const lowIdlePool: PoolSummary = {
      ...mockBasePool,
      tvl: "10000",
      strategyExposureBps: 9500, // 95.00%
      idleLiquidity: "500", // 5.00%
      minIdleRatioBps: 1500, // 15.00% minimum
    };

    // A small deposit of 100 makes idle 600 out of 10100 TVL = ~5.94% (< 15%)
    const preview = calculateDepositPreview(lowIdlePool, "100");

    expect(preview.postDepositIdleRatioBps).toBe(594);
    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "LOW_IDLE_LIQUIDITY",
        }),
      ]),
    );
  });

  it("simulates queued withdrawal impact and deficit accurately", () => {
    const poolWithQueue: PoolSummary = {
      ...mockBasePool,
      tvl: "10000",
      idleLiquidity: "500",
      queuedWithdrawals: "2000", // 2000 USDC queued
    };

    // Depositing 500 increases idle liquidity from 500 to 1000 USDC
    const preview = calculateDepositPreview(poolWithQueue, "500");

    expect(preview.queuedWithdrawals).toBe(2000);
    expect(preview.postDepositIdleLiquidity).toBe(1000);
    expect(preview.queueCoverageRatio).toBe(0.5); // 1000 / 2000
    expect(preview.queueDeficit).toBe(1000); // 2000 - 1000
    expect(preview.queuePressureLevel).toBe("high");

    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "QUEUED_WITHDRAWAL_PRESSURE",
          message: expect.stringContaining("leaves 1000.00 USDC in queued withdrawals unfulfilled"),
        }),
      ]),
    );
  });

  it("clears queue pressure when deposit fully covers queued withdrawals", () => {
    const poolWithQueue: PoolSummary = {
      ...mockBasePool,
      tvl: "10000",
      idleLiquidity: "500",
      queuedWithdrawals: "2000",
    };

    // Depositing 2000 increases idle liquidity to 2500, covering the 2000 queue
    const preview = calculateDepositPreview(poolWithQueue, "2000");

    expect(preview.postDepositIdleLiquidity).toBe(2500);
    expect(preview.queueCoverageRatio).toBe(1.25);
    expect(preview.queueDeficit).toBe(0);
    expect(preview.queuePressureLevel).toBe("moderate");

    const queueWarnings = preview.warnings.filter((w) => w.code === "QUEUED_WITHDRAWAL_PRESSURE");
    expect(queueWarnings).toHaveLength(0);
  });

  it("handles edge cases gracefully (zero TVL, zero deposit, missing optional fields)", () => {
    const emptyPool: PoolSummary = {
      id: "pool_empty",
      name: "New Vault",
      status: "open",
      tvl: "0",
      asset: "USDC",
      participantCount: 0,
      expectedYield: "0%",
      opensAt: null,
      locksAt: null,
      drawsAt: null,
    };

    const preview = calculateDepositPreview(emptyPool, "500");

    expect(preview.depositAmount).toBe(500);
    expect(preview.currentTvl).toBe(0);
    expect(preview.postDepositTvl).toBe(500);
    expect(preview.postDepositIdleLiquidity).toBe(500);
    expect(preview.postDepositIdleRatioBps).toBe(10000); // 100% idle
    expect(preview.warnings).toHaveLength(0);
  });
});
