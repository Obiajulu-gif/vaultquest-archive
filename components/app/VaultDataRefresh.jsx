"use client";

import { useState } from "react";
import { RefreshCw, Clock, AlertCircle } from "lucide-react";

export default function VaultDataRefresh() {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [error, setError] = useState(null);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError(null);

    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      setLastUpdated(new Date());
    } catch (err) {
      setError("Unable to refresh vault data. Please try again.");
    } finally {
      setIsRefreshing(false);
    }
  };

  const formatTime = (date) => {
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);

    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="vq-glass-hover p-4 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <Clock size={16} className="text-vault-muted" />
        <div>
          <p className="text-sm font-medium text-vault-text">Last updated</p>
          <p className="text-xs text-vault-muted">{formatTime(lastUpdated)}</p>
        </div>
      </div>

      <button
        onClick={handleRefresh}
        disabled={isRefreshing}
        className="vq-btn-ghost flex items-center gap-2 disabled:opacity-50"
      >
        <RefreshCw size={16} className={isRefreshing ? "animate-spin" : ""} />
        {isRefreshing ? "Refreshing..." : "Refresh"}
      </button>

      {error && (
        <div className="absolute top-full left-0 right-0 mt-2 flex items-start gap-2 text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
