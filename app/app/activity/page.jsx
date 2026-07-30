"use client";

import { useState, useMemo } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  ArrowDownRight, ArrowUpRight, Gift, RefreshCw, Wallet,
  ChevronLeft, ChevronRight, Filter, Clock, History
} from "lucide-react";
import { DEMO_TRANSACTIONS } from "@/lib/demo-portfolio";
import { ActivityExport } from "@vaultquest/stellar-wallet-connect/src/vault/components/ActivityExport";
import TransactionHistoryModal from "@/components/app/TransactionHistoryModal";

const ACTIVITY_TYPES = {
  deposit: { label: "Deposit", icon: ArrowDownRight, color: "text-emerald-600 dark:text-emerald-400" },
  withdraw: { label: "Withdrawal", icon: ArrowUpRight, color: "text-vault-muted" },
  reward: { label: "Prize Claimed", icon: Gift, color: "text-amber-600 dark:text-amber-400" },
  status: { label: "Status Change", icon: RefreshCw, color: "text-blue-600 dark:text-blue-400" },
};

const STATUS_LABELS = {
  confirmed: { label: "Confirmed", class: "text-emerald-600 dark:text-emerald-400" },
  pending: { label: "Pending", class: "text-amber-600 dark:text-amber-400" },
  failed: { label: "Failed", class: "text-red-600 dark:text-red-400" },
};

const PAGE_SIZE = 10;

function ActivityFeed({ transactions }) {
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (filter === "all") return transactions;
    return transactions.filter((tx) => tx.type === filter);
  }, [transactions, filter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  return (
    <section className="vq-glass p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-vault-text">Activity History</h2>
          <p className="text-sm text-vault-muted">Deposits, withdrawals, claims, and status changes</p>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-vault-muted" />
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }}
            className="rounded-xl border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-400"
            aria-label="Filter activity type">
            <option value="all">All Activity</option>
            <option value="deposit">Deposits</option>
            <option value="withdraw">Withdrawals</option>
            <option value="reward">Claims</option>
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 py-12 text-center">
          <Clock className="h-8 w-8 text-vault-muted" />
          <p className="text-sm text-vault-muted">No activity found.</p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-vault-border" role="list">
          {slice.map((tx) => {
            const typeInfo = ACTIVITY_TYPES[tx.type] || ACTIVITY_TYPES.deposit;
            const Icon = typeInfo.icon;
            const statusInfo = STATUS_LABELS[tx.status] || STATUS_LABELS.pending;
            return (
              <li key={tx.id} className="flex items-center gap-4 py-4">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface ${typeInfo.color}`}>
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-vault-text">{typeInfo.label}</p>
                    <span className={`text-xs font-medium ${statusInfo.class}`}>{statusInfo.label}</span>
                  </div>
                  <p className="text-xs text-vault-muted">{tx.pool}</p>
                  <p className="mt-0.5 text-xs text-vault-muted">
                    {new Date(tx.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={`font-semibold ${tx.type === "withdraw" ? "text-vault-muted" : "text-emerald-600 dark:text-emerald-400"}`}>
                    {tx.type === "withdraw" ? "−" : "+"}${tx.amount.toLocaleString()}
                  </p>
                  <p className="text-xs text-vault-muted">{tx.asset || "USDC"}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {filtered.length > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between border-t border-vault-border pt-4">
          <button type="button" disabled={safePage === 0} onClick={() => setPage((p) => Math.max(0, p - 1))} className="vq-btn-ghost disabled:opacity-40">
            <ChevronLeft className="h-4 w-4" /> Prev
          </button>
          <span className="text-sm text-vault-muted">Page {safePage + 1} of {pageCount}</span>
          <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} className="vq-btn-ghost disabled:opacity-40">
            Next <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </section>
  );
}

function ActivitySummary({ transactions }) {
  const stats = useMemo(() => {
    const deposits = transactions.filter((t) => t.type === "deposit" && t.status === "confirmed");
    const withdrawals = transactions.filter((t) => t.type === "withdraw" && t.status === "confirmed");
    const claims = transactions.filter((t) => t.type === "reward" && t.status === "confirmed");
    return {
      totalDeposits: deposits.reduce((s, t) => s + t.amount, 0),
      totalWithdrawals: withdrawals.reduce((s, t) => s + t.amount, 0),
      totalClaims: claims.reduce((s, t) => s + t.amount, 0),
      depositCount: deposits.length,
      withdrawCount: withdrawals.length,
      claimCount: claims.length,
    };
  }, [transactions]);

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="vq-glass-hover p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-emerald-500"><ArrowDownRight className="h-5 w-5" /></span>
        <p className="mt-4 text-xs font-medium uppercase tracking-wide text-vault-muted">Total Deposits</p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-vault-text">${stats.totalDeposits.toLocaleString()}</p>
        <p className="text-sm text-vault-muted">{stats.depositCount} deposits</p>
      </div>
      <div className="vq-glass-hover p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-muted"><ArrowUpRight className="h-5 w-5" /></span>
        <p className="mt-4 text-xs font-medium uppercase tracking-wide text-vault-muted">Total Withdrawals</p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-vault-text">${stats.totalWithdrawals.toLocaleString()}</p>
        <p className="text-sm text-vault-muted">{stats.withdrawCount} withdrawals</p>
      </div>
      <div className="vq-glass-hover p-5">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-amber-500"><Gift className="h-5 w-5" /></span>
        <p className="mt-4 text-xs font-medium uppercase tracking-wide text-vault-muted">Total Claims</p>
        <p className="mt-1 text-2xl font-bold tabular-nums text-vault-text">${stats.totalClaims.toLocaleString()}</p>
        <p className="text-sm text-vault-muted">{stats.claimCount} prizes</p>
      </div>
    </div>
  );
}

function EmptyActivity() {
  const { openConnectModal } = useConnectModal();
  return (
    <div className="vq-glass flex flex-col items-center px-6 py-16 text-center sm:px-10">
      <span className="flex h-16 w-16 items-center justify-center rounded-full border border-vault-border bg-red-500/10 text-red-500 ring-2 ring-red-400/20">
        <Wallet className="h-8 w-8" />
      </span>
      <h2 className="mt-6 text-xl font-semibold text-vault-text">Wallet not connected</h2>
      <p className="mt-2 max-w-md text-sm text-vault-muted">Connect your wallet to view your account activity, deposits, withdrawals, and prize claims.</p>
      <button type="button" onClick={() => openConnectModal?.()} className="vq-btn-primary mt-8">
        <Wallet className="h-4 w-4" /> Connect wallet
      </button>
    </div>
  );
}

export default function ActivityPage() {
  const { isConnected, address } = useAccount();
  const [historyOpen, setHistoryOpen] = useState(false);
  const enrichedTx = useMemo(() => DEMO_TRANSACTIONS.map((tx) => ({ ...tx })), []);

  const summary = useMemo(() => {
    if (!isConnected) return null;
    return {
      deposits: enrichedTx.filter((t) => t.type === "deposit" && t.status === "confirmed").length,
      withdrawals: enrichedTx.filter((t) => t.type === "withdraw" && t.status === "confirmed").length,
      rewards: enrichedTx.filter((t) => t.type === "reward" && t.status === "confirmed").length,
    };
  }, [isConnected, enrichedTx]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-bold text-vault-text">Account Activity</h1>
        <p className="mt-2 text-vault-muted">Track all deposits, withdrawals, prize claims, and status changes.</p>
      </header>

      {isConnected ? (
        <>
          <ActivitySummary transactions={enrichedTx} />
          <ActivityFeed transactions={enrichedTx} />
          <ActivityExport
            walletAddress={null}
            walletConnected={isConnected}
            summary={summary}
          />
          <div className="vq-glass flex items-center justify-between p-4 sm:p-6">
            <div>
              <h3 className="text-base font-semibold text-vault-text">Full transaction history</h3>
              <p className="text-sm text-vault-muted">View paginated deposits, withdrawals, and claims from the backend.</p>
            </div>
            <button type="button" onClick={() => setHistoryOpen(true)} className="vq-btn-primary">
              <History className="h-4 w-4" /> View history
            </button>
          </div>
          <TransactionHistoryModal
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            walletAddress={address ?? null}
          />
        </>
      ) : (
        <EmptyActivity />
      )}
    </div>
  );
}
