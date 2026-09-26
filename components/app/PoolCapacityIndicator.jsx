"use client";

import { useMemo } from "react";
import { AlertTriangle, Infinity, CheckCircle2 } from "lucide-react";

const UNLIMITED_THRESHOLD = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");

/**
 * PoolCapacityIndicator
 *
 * Displays a visual progress bar showing how much of a pool's total capacity
 * has been filled. Handles unlimited-capacity pools and near-full / full states.
 *
 * @param {Object} props
 * @param {bigint|string} props.currentTotal - Current deposited amount (in smallest unit)
 * @param {bigint|string} props.maxCapacity - Maximum capacity (in smallest unit, 0 or very large = unlimited)
 * @param {number} [props.decimals=7] - Asset decimal places
 * @param {string} [props.asset="USDC"] - Asset label
 * @param {string} [props.size="default"] - "compact" | "default" | "large"
 */
export default function PoolCapacityIndicator({
  currentTotal,
  maxCapacity,
  decimals = 7,
  asset = "USDC",
  size = "default",
}) {
  const analysis = useMemo(() => {
    const current = BigInt(currentTotal ?? 0);
    const max = BigInt(maxCapacity ?? 0);
    const isUnlimited = max === 0n || max >= UNLIMITED_THRESHOLD;

    if (isUnlimited) {
      return {
        isUnlimited: true,
        isFull: false,
        isNearFull: false,
        percentage: 0,
        currentFormatted: formatUnits(current, decimals),
        maxFormatted: null,
        remainingFormatted: null,
      };
    }

    const percentage = max > 0n ? Number((current * 10000n) / max) / 100 : 0;
    const clampedPct = Math.min(100, Math.max(0, percentage));
    const remaining = max > current ? max - current : 0n;

    return {
      isUnlimited: false,
      isFull: clampedPct >= 100,
      isNearFull: clampedPct >= 80 && clampedPct < 100,
      percentage: clampedPct,
      currentFormatted: formatUnits(current, decimals),
      maxFormatted: formatUnits(max, decimals),
      remainingFormatted: formatUnits(remaining, decimals),
    };
  }, [currentTotal, maxCapacity, decimals]);

  if (analysis.isUnlimited) {
    return (
      <div className="vq-glass-hover p-4" data-testid="pool-capacity-indicator">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wide text-vault-muted">
            Pool Capacity
          </span>
          <div className="flex items-center gap-1.5 text-xs text-vault-muted">
            <Infinity className="h-3.5 w-3.5" />
            <span>Unlimited</span>
          </div>
        </div>
        <p className="mt-2 text-sm text-vault-muted">
          Deposited: {analysis.currentFormatted} {asset}
        </p>
      </div>
    );
  }

  const barColor = analysis.isFull
    ? "bg-emerald-500"
    : analysis.isNearFull
      ? "bg-amber-500"
      : "bg-gradient-to-r from-red-500 to-red-400";

  const textColor = analysis.isFull
    ? "text-emerald-500"
    : analysis.isNearFull
      ? "text-amber-500"
      : "text-vault-accent";

  const sizeClasses = {
    compact: "p-3",
    default: "p-4",
    large: "p-5 sm:p-6",
  };

  const barHeight = {
    compact: "h-1.5",
    default: "h-2.5",
    large: "h-3.5",
  };

  return (
    <div
      className={`vq-glass-hover ${sizeClasses[size] || sizeClasses.default}`}
      data-testid="pool-capacity-indicator"
      role="group"
      aria-label="Pool capacity"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wide text-vault-muted">
          Pool Capacity
        </span>
        {analysis.isFull ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-emerald-500">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Full
          </span>
        ) : analysis.isNearFull ? (
          <span className="flex items-center gap-1 text-xs font-semibold text-amber-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            Near Full
          </span>
        ) : (
          <span className={`text-xs font-semibold ${textColor}`}>
            {analysis.percentage.toFixed(1)}%
          </span>
        )}
      </div>

      <div
        className={`relative mt-3 w-full overflow-hidden rounded-full bg-vault-border/30 ${barHeight[size] || barHeight.default}`}
        role="progressbar"
        aria-valuenow={Math.round(analysis.percentage)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${analysis.percentage.toFixed(1)}% pool capacity used`}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${barColor}`}
          style={{ width: `${Math.min(100, analysis.percentage)}%` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between text-xs">
        <span className="text-vault-muted">
          {analysis.currentFormatted} {asset}
        </span>
        <span className="text-vault-muted">
          {analysis.maxFormatted} {asset}
        </span>
      </div>

      {analysis.isFull && (
        <p className="mt-2 text-xs font-medium text-emerald-500">
          This pool has reached its maximum capacity. New deposits are disabled.
        </p>
      )}

      {!analysis.isFull && analysis.remainingFormatted && (
        <p className="mt-2 text-xs text-vault-muted">
          {analysis.remainingFormatted} {asset} remaining
        </p>
      )}
    </div>
  );
}

function formatUnits(value, decimals) {
  const str = value.toString();
  if (decimals === 0 || str.length <= decimals) {
    const padded = str.padStart(decimals + 1, "0");
    return Number(padded).toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }
  const intPart = str.slice(0, str.length - decimals);
  const decPart = str.slice(str.length - decimals);
  const num = parseFloat(`${intPart}.${decPart}`);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
