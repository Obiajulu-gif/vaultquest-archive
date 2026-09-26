"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Clock3, Compass, Layers, Wallet } from "lucide-react";
import { formatUsd } from "@/lib/yield-counter";
import { DEMO_TRANSACTIONS, summarizeAccountPositions } from "@/lib/demo-portfolio";

function SummaryCardSkeleton() {
  return (
    <div className="vq-glass p-5 animate-pulse">
      <div className="h-10 w-10 rounded-xl bg-vault-border/40" />
      <div className="mt-4 h-3 w-24 rounded bg-vault-border/30" />
      <div className="mt-2 h-6 w-16 rounded bg-vault-border/40" />
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, sub }) {
  return (
    <div className="vq-glass-hover p-5">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-accent">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <p className="mt-4 text-xs font-medium uppercase tracking-wide text-vault-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-vault-text">{value}</p>
      {sub && <p className="mt-1 text-sm text-vault-muted">{sub}</p>}
    </div>
  );
}

function EmptyPositions() {
  return (
    <div className="vq-glass flex flex-col items-center px-6 py-12 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full border border-vault-border bg-vault-surface text-vault-muted">
        <Compass className="h-7 w-7" aria-hidden="true" />
      </span>
      <h3 className="mt-4 text-lg font-semibold text-vault-text">No vault positions yet</h3>
      <p className="mt-2 max-w-md text-sm text-vault-muted">
        Join a vault to start earning yield and entering prize rounds. Your positions will show up
        here once you do.
      </p>
      <Link href="/app/vaults" className="vq-btn-primary mt-6">
        Browse vaults
      </Link>
    </div>
  );
}

export default function AccountPositionSummary({ transactions = DEMO_TRANSACTIONS }) {
  const locale = typeof navigator !== "undefined" ? navigator.language : "en";
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const { positions, totalJoinedVaults, totalBalance, pendingActionsCount } = useMemo(
    () => summarizeAccountPositions(transactions),
    [transactions],
  );

  if (!mounted) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCardSkeleton />
        <SummaryCardSkeleton />
        <SummaryCardSkeleton />
      </div>
    );
  }

  if (totalJoinedVaults === 0) {
    return <EmptyPositions />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          icon={Layers}
          label="Joined vaults"
          value={totalJoinedVaults}
          sub="Pools you currently hold a position in"
        />
        <SummaryCard
          icon={Wallet}
          label="Current balance"
          value={formatUsd(totalBalance, locale)}
          sub="Across all joined vaults"
        />
        <SummaryCard
          icon={Clock3}
          label="Pending actions"
          value={pendingActionsCount}
          sub={
            pendingActionsCount === 1
              ? "Transaction awaiting confirmation"
              : "Transactions awaiting confirmation"
          }
        />
      </div>

      <div className="vq-glass divide-y divide-vault-border/40">
        {positions.map((position) => (
          <div key={position.pool} className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="font-medium text-vault-text">{position.pool}</p>
              <p className="text-xs text-vault-muted">{position.asset}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold text-vault-text">{formatUsd(position.balance, locale)}</p>
              {position.pendingCount > 0 && (
                <p className="text-xs text-amber-500">
                  {position.pendingCount} pending
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
