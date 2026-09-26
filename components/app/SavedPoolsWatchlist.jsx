"use client";

import { useState } from "react";
import Link from "next/link";
import { Star, AlertCircle, RefreshCw, Trash2, Info } from "lucide-react";
import { useSavedPools } from "@/components/hooks/useSavedPools";
import RoundStatusBadge from "@/components/app/RoundStatusBadge";

export default function SavedPoolsWatchlist() {
  const { savedPools, loading, error, unsavePool, refetch } = useSavedPools();
  const [removingId, setRemovingId] = useState(null);

  const handleRemove = async (poolId) => {
    setRemovingId(poolId);
    await unsavePool(poolId);
    setRemovingId(null);
  };

  if (loading && savedPools.length === 0) {
    return (
      <div className="vq-glass p-6">
        <div className="flex items-center gap-3">
          <RefreshCw className="h-5 w-5 animate-spin text-vault-accent" aria-hidden="true" />
          <p className="text-vault-muted">Loading watchlist...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="vq-glass p-6">
        <div className="flex items-center gap-3 text-red-500">
          <AlertCircle className="h-5 w-5" aria-hidden="true" />
          <p>{error}</p>
        </div>
        <button
          onClick={refetch}
          className="vq-btn-ghost mt-4"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }

  if (savedPools.length === 0) {
    return (
      <div className="vq-glass p-8 text-center">
        <div className="mb-4 flex h-16 w-16 mx-auto items-center justify-center rounded-full bg-vault-surface text-vault-muted border border-vault-border">
          <Star size={32} />
        </div>
        <h3 className="text-xl font-semibold text-vault-text">No saved pools</h3>
        <p className="text-vault-muted mt-2">
          Add pools to your watchlist to monitor them easily
        </p>
        <Link href="/app/vaults" className="vq-btn-primary mt-6 inline-flex">
          Browse Pools
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 text-yellow-500" fill="currentColor" aria-hidden="true" />
          <h3 className="text-lg font-semibold text-vault-text">
            Saved Pools ({savedPools.length})
          </h3>
        </div>
        <button
          onClick={refetch}
          className="p-2 rounded-lg hover:bg-vault-surface transition-colors text-vault-muted hover:text-vault-text"
          aria-label="Refresh watchlist"
        >
          <RefreshCw size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {savedPools.map((pool) => {
          const poolUnavailable = pool.status === "closed" || pool.status === "cancelled";
          
          return (
            <div
              key={pool.id}
              className={`vq-glass-hover p-4 ${poolUnavailable ? "opacity-60" : ""}`}
            >
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex-1">
                  <h4 className="font-semibold text-vault-text">{pool.pool_name}</h4>
                  <p className="text-xs text-vault-muted mt-0.5">{pool.asset}</p>
                </div>
                <div className="flex items-center gap-2">
                  <RoundStatusBadge status={pool.status} />
                  <button
                    onClick={() => handleRemove(pool.pool_id)}
                    disabled={removingId === pool.pool_id}
                    className="p-1.5 rounded-lg hover:bg-red-500/20 text-vault-muted hover:text-red-500 transition-colors disabled:opacity-50"
                    aria-label="Remove from watchlist"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>

              {poolUnavailable && (
                <div className="mb-3 flex items-center gap-2 rounded-lg bg-yellow-500/10 p-2 text-xs text-yellow-600 dark:text-yellow-400">
                  <Info size={14} aria-hidden="true" />
                  <span>This pool is no longer available</span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-vault-muted font-bold">TVL</p>
                  <p className="font-medium text-vault-text">
                    ${(parseFloat(pool.tvl) / 1000000).toFixed(1)}M
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-vault-muted font-bold">Yield</p>
                  <p className="font-medium text-emerald-500">{pool.expected_yield}%</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-vault-muted font-bold">Users</p>
                  <p className="font-medium text-vault-text">{pool.participant_count}</p>
                </div>
              </div>

              {!poolUnavailable && (
                <Link
                  href={`/app/vaults/${pool.pool_id}`}
                  className="vq-btn-ghost mt-4 w-full text-center text-sm"
                >
                  View Pool
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
