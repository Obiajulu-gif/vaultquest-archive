"use client";

import React, { useState, useMemo } from "react";
import { Lock, Unlock, AlertCircle, RefreshCw, ArrowRight, ShieldAlert, CheckCircle2 } from "lucide-react";

export default function WithdrawalEligibilityPanel({ position, onRefresh, onWithdraw }) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const analysis = useMemo(() => {
    if (!position) {
      return {
        eligible: false,
        reason: "No active deposit position found for this wallet.",
        withdrawablePrincipal: "0.00",
        withdrawableRewards: "0.00",
        totalWithdrawable: "0.00",
        lockPeriodRemaining: null,
      };
    }

    const {
      principal = "0.00",
      rewards = "0.00",
      lockEndsAt = null,
      poolStatus = "open",
      pendingActions = false,
      alreadyWithdrawn = false,
      asset = "USDC",
    } = position;

    const numPrincipal = parseFloat(principal) || 0;
    const numRewards = parseFloat(rewards) || 0;

    if (alreadyWithdrawn || (numPrincipal === 0 && numRewards === 0)) {
      return {
        eligible: false,
        reason: "Position has already been fully withdrawn.",
        withdrawablePrincipal: "0.00",
        withdrawableRewards: "0.00",
        totalWithdrawable: "0.00",
        lockPeriodRemaining: null,
        asset,
      };
    }

    if (poolStatus === "paused") {
      return {
        eligible: false,
        reason: "Vault pool operations are currently paused.",
        withdrawablePrincipal: "0.00",
        withdrawableRewards: "0.00",
        totalWithdrawable: "0.00",
        lockPeriodRemaining: null,
        asset,
      };
    }

    if (pendingActions && (Array.isArray(pendingActions) ? pendingActions.length > 0 : Boolean(pendingActions))) {
      return {
        eligible: false,
        reason: "Pending transactions exist for this position. Please wait for confirmation.",
        withdrawablePrincipal: "0.00",
        withdrawableRewards: "0.00",
        totalWithdrawable: "0.00",
        lockPeriodRemaining: null,
        asset,
      };
    }

    const now = Date.now();
    const lockTime = lockEndsAt ? new Date(lockEndsAt).getTime() : 0;
    const isLocked = lockTime > now && poolStatus !== "matured";

    if (isLocked) {
      const remainingMs = lockTime - now;
      const days = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));
      return {
        eligible: false,
        reason: `Position locked for ${days} more day(s) until ${new Date(lockEndsAt).toLocaleDateString()}.`,
        withdrawablePrincipal: "0.00",
        withdrawableRewards: "0.00",
        totalWithdrawable: "0.00",
        lockPeriodRemaining: `${days}d`,
        asset,
      };
    }

    const total = (numPrincipal + numRewards).toFixed(2);
    return {
      eligible: true,
      reason: null,
      withdrawablePrincipal: numPrincipal.toFixed(2),
      withdrawableRewards: numRewards.toFixed(2),
      totalWithdrawable: total,
      lockPeriodRemaining: null,
      asset,
    };
  }, [position]);

  const handleRefreshClick = async () => {
    if (!onRefresh) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const assetLabel = position?.asset || "USDC";

  return (
    <div className="vq-glass space-y-5 p-5" data-testid="withdrawal-eligibility-panel">
      <div className="flex items-center justify-between border-b border-vault-border/40 pb-3">
        <div className="flex items-center gap-2">
          {analysis.eligible ? (
            <Unlock className="h-5 w-5 text-emerald-500" />
          ) : (
            <Lock className="h-5 w-5 text-amber-500" />
          )}
          <h3 className="text-base font-bold text-vault-text">Withdrawal Eligibility Calculator</h3>
        </div>

        <button
          type="button"
          onClick={handleRefreshClick}
          disabled={isRefreshing}
          className="vq-btn-ghost flex items-center gap-1.5 py-1 px-2.5 text-xs text-vault-muted hover:text-vault-text"
          data-testid="refresh-eligibility-btn"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* State Banner */}
      {!analysis.eligible ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs font-semibold text-amber-400" data-testid="ineligible-banner">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-amber-400">Withdrawal Currently Unavailable</p>
            <p className="mt-1 font-normal text-amber-300/90">{analysis.reason}</p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs font-semibold text-emerald-400" data-testid="eligible-banner">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Position is fully eligible for immediate withdrawal.</span>
        </div>
      )}

      {/* Breakdown */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-3.5" data-testid="principal-breakdown">
          <span className="text-xs font-bold uppercase tracking-wide text-vault-muted">Withdrawable Principal</span>
          <p className="mt-1 text-xl font-extrabold text-vault-text">
            {analysis.withdrawablePrincipal} <span className="text-xs font-semibold text-vault-muted">{assetLabel}</span>
          </p>
          <p className="mt-1 text-[11px] text-vault-muted">Initial deposit amount</p>
        </div>

        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-3.5" data-testid="rewards-breakdown">
          <span className="text-xs font-bold uppercase tracking-wide text-vault-muted">Withdrawable Rewards</span>
          <p className="mt-1 text-xl font-extrabold text-emerald-400">
            {analysis.withdrawableRewards} <span className="text-xs font-semibold text-vault-muted">{assetLabel}</span>
          </p>
          <p className="mt-1 text-[11px] text-vault-muted">Accumulated pool yield</p>
        </div>
      </div>

      {/* Total Available */}
      <div className="flex items-center justify-between rounded-xl border border-vault-border bg-vault-surface/60 p-4" data-testid="total-withdrawable">
        <div>
          <span className="text-xs font-bold uppercase tracking-wide text-vault-muted">Total Available Now</span>
          <p className="text-2xl font-black text-vault-text">
            {analysis.totalWithdrawable} <span className="text-sm font-semibold text-vault-muted">{assetLabel}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={onWithdraw}
          disabled={!analysis.eligible}
          className="vq-btn-primary flex items-center gap-1.5 px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="withdraw-submit-btn"
        >
          <span>Withdraw</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
