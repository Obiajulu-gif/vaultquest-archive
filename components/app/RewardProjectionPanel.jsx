"use client";

import React, { useState, useMemo } from "react";
import { Info, AlertTriangle, CheckCircle2, TrendingUp, HelpCircle, RefreshCw } from "lucide-react";

export default function RewardProjectionPanel({ projection, onRefresh }) {
  const [showAssumptions, setShowAssumptions] = useState(false);

  const isStale = useMemo(() => {
    if (!projection?.updatedAt) return false;
    const updatedTime = new Date(projection.updatedAt).getTime();
    if (Number.isNaN(updatedTime)) return false;
    const thresholdMs = projection.staleThresholdMs || 24 * 60 * 60 * 1000;
    return Date.now() - updatedTime > thresholdMs;
  }, [projection]);

  if (!projection) {
    return (
      <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4 text-center text-sm text-vault-muted" data-testid="missing-projection">
        <div className="flex items-center justify-center gap-2 text-vault-muted">
          <HelpCircle className="h-4 w-4" />
          <span>Reward projection data is currently unavailable. Core pool actions remain active.</span>
        </div>
      </div>
    );
  }

  const {
    estimatedApy = "0%",
    estimatedReward = "0.00",
    confirmedReward = "0.00",
    poolDurationDays = 30,
    rateSource = "Protocol Yield Strategy",
    updatedAt,
    asset = "USDC",
  } = projection;

  const formattedDate = updatedAt ? new Date(updatedAt).toLocaleString() : "Unknown";

  return (
    <div className="vq-glass space-y-4 p-5" data-testid="reward-projection-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-vault-accent" />
          <h3 className="text-base font-bold text-vault-text">Reward Projection & Risk</h3>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="vq-btn-ghost p-1.5 text-xs text-vault-muted hover:text-vault-text"
            title="Refresh projection"
            data-testid="refresh-projection-btn"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {isStale && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-500" data-testid="stale-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Projection data may be stale (last updated {formattedDate}).</span>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Projected Value */}
        <div className="rounded-xl border border-dashed border-amber-400/40 bg-amber-400/5 p-4" data-testid="projected-card">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-amber-500">Projected Reward</span>
            <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-amber-400">Estimated</span>
          </div>
          <p className="mt-2 text-2xl font-extrabold text-vault-text">
            {estimatedReward} <span className="text-sm font-semibold text-vault-muted">{asset}</span>
          </p>
          <p className="mt-1 text-xs text-vault-muted">Based on {estimatedApy} APY</p>
        </div>

        {/* Confirmed Value */}
        <div className="rounded-xl border border-solid border-emerald-500/40 bg-emerald-500/5 p-4" data-testid="confirmed-card">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-emerald-500">Confirmed Reward</span>
            <span className="flex items-center gap-1 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Confirmed
            </span>
          </div>
          <p className="mt-2 text-2xl font-extrabold text-vault-text">
            {confirmedReward} <span className="text-sm font-semibold text-vault-muted">{asset}</span>
          </p>
          <p className="mt-1 text-xs text-vault-muted">Settled on-chain</p>
        </div>
      </div>

      <div className="border-t border-vault-border/40 pt-3">
        <button
          type="button"
          onClick={() => setShowAssumptions(!showAssumptions)}
          className="flex w-full items-center justify-between text-xs font-semibold text-vault-accent hover:underline"
          data-testid="toggle-assumptions-btn"
        >
          <span className="flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5" />
            Calculation Assumptions
          </span>
          <span>{showAssumptions ? "Hide" : "Inspect"}</span>
        </button>

        {showAssumptions && (
          <div className="mt-3 space-y-2 rounded-lg border border-vault-border bg-vault-surface/30 p-3 text-xs text-vault-muted" data-testid="assumptions-content">
            <div className="flex justify-between">
              <span>Pool Duration:</span>
              <span className="font-semibold text-vault-text">{poolDurationDays} Days</span>
            </div>
            <div className="flex justify-between">
              <span>Rate Assumption:</span>
              <span className="font-semibold text-vault-text">{rateSource} ({estimatedApy})</span>
            </div>
            <div className="flex justify-between">
              <span>Last Updated:</span>
              <span className="font-semibold text-vault-text">{formattedDate}</span>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg bg-vault-surface/40 p-3 text-[11px] leading-relaxed text-vault-muted" data-testid="risk-disclaimer">
        <span className="font-bold text-vault-text">Risk Guidance:</span> Reward projections are calculated estimates based on active pool parameters and protocol yield assumptions. Actual earnings fluctuate based on network conditions, total pool deposits, and cycle duration. Confirmed rewards represent finalized yield.
      </div>
    </div>
  );
}
