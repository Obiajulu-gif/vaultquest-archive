"use client";

import { Activity, DollarSign, Hash, Trophy, Users } from "lucide-react";
import { PUBLIC_STATS, DEMO_TRANSACTIONS } from "@/lib/demo-portfolio";
import { formatUsd } from "@/lib/yield-counter";

function MetricCardSkeleton() {
  return (
    <div className="animate-pulse vq-glass p-5">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-vault-border/40" />
        <div className="space-y-1.5 flex-1">
          <div className="h-3 w-24 rounded bg-vault-border/30" />
          <div className="h-6 w-16 rounded bg-vault-border/40" />
        </div>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, accent }) {
  return (
    <div className="vq-glass-hover p-5">
      <div className="flex items-start gap-3">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface"
          style={{ color: accent }}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">{label}</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-vault-text">{value}</p>
        </div>
      </div>
    </div>
  );
}

export default function VaultMetricsCards({ loading = false }) {
  const locale = typeof navigator !== "undefined" ? navigator.language : "en";
  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  const recentCount = PUBLIC_STATS.recentActivityCount ?? DEMO_TRANSACTIONS.length;

  const metrics = [
    {
      icon: DollarSign,
      label: "Total Value Locked",
      value: formatUsd(PUBLIC_STATS.tvl, locale),
      accent: "#22c55e",
    },
    {
      icon: Users,
      label: "Active Participants",
      value: PUBLIC_STATS.activeSavers.toLocaleString(locale),
      accent: "#6366f1",
    },
    {
      icon: Hash,
      label: "Current Round",
      value: `#${PUBLIC_STATS.currentRound}`,
      accent: "#3b82f6",
    },
    {
      icon: Trophy,
      label: "Prize Estimate",
      value: formatUsd(PUBLIC_STATS.prizeEstimate ?? PUBLIC_STATS.prizePool, locale),
      accent: "#f59e0b",
    },
    {
      icon: Activity,
      label: "Recent Activity",
      value: `${recentCount} txns`,
      accent: "#ef4444",
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {metrics.map((m) => (
        <MetricCard key={m.label} {...m} />
      ))}
    </div>
  );
}
