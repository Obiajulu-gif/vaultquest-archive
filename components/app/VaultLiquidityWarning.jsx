"use client";

import { AlertTriangle, RefreshCw, Droplets } from "lucide-react";

/**
 * VaultLiquidityWarning — shown inline when liquidity data is missing or stale.
 *
 * Props:
 *   missing   boolean  — true when no liquidity data was returned at all
 *   stale     boolean  — true when data exists but hasn't refreshed recently
 *   onRefresh function — callback to re-fetch liquidity data
 *   loading   boolean  — true while a refresh is in flight
 */
export default function VaultLiquidityWarning({
  missing = false,
  stale = false,
  onRefresh,
  loading = false,
}) {
  if (!missing && !stale) return null;

  const title = missing
    ? "Liquidity data unavailable"
    : "Liquidity data may be outdated";

  const description = missing
    ? "We couldn't retrieve current liquidity information for this vault. Other vault details are still visible below."
    : "Liquidity figures were last updated a while ago and may not reflect the current state of the vault.";

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-5 py-4 backdrop-blur-md"
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-400">
        {missing ? (
          <Droplets className="h-5 w-5" aria-hidden="true" />
        ) : (
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        )}
      </span>

      <div className="flex-1 min-w-0">
        <p className="font-semibold text-vault-text">{title}</p>
        <p className="mt-1 text-sm text-vault-muted">{description}</p>
      </div>

      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh liquidity data"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-sm font-medium text-amber-400 transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      )}
    </div>
  );
}
