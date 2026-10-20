"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import {
  ArrowDownRight, ArrowUpRight, Gift, RefreshCw, Wallet,
  ChevronLeft, ChevronRight, Filter, Clock, AlertCircle, EyeOff, Eye
} from "lucide-react";
import UserActivityTimeline from "@/components/app/UserActivityTimeline";

/**
 * Client-side-only "privacy mode" preference (#655). Hides identifying
 * pool/vault labels in the LOCAL activity feed on this device -- it has no
 * effect on-chain and does not touch amounts, dates, or status, which are
 * on-chain facts and stay visible either way. Persisted with the same
 * localStorage pattern other per-device settings in this app use (see
 * components/app/AppNav.jsx's high-contrast toggle).
 */
export const ACTIVITY_PRIVACY_MODE_KEY = "vaultquest-activity-privacy-mode";

/**
 * Resolve the label shown for one activity row, masking the identifying
 * pool/vault name with a generic placeholder when privacy mode is on.
 * Free-text messages (e.g. "System Upgrade Completed") are left unchanged
 * either way -- they don't name a specific vault the wallet participated
 * in, so there's nothing pool-identifying to hide.
 */
export function maskPoolLabel(tx, privacyMode) {
  if (tx.message) return tx.message;
  if (privacyMode && tx.pool) return "Vault activity";
  return tx.pool;
}

const ACTIVITY_TYPES = {
  deposit: { label: "Deposit", icon: ArrowDownRight, color: "text-emerald-600 dark:text-emerald-400" },
  withdraw: { label: "Withdrawal", icon: ArrowUpRight, color: "text-vault-muted" },
  reward: { label: "Prize Claimed", icon: Gift, color: "text-amber-600 dark:text-amber-400" },
  status: { label: "Status Change", icon: RefreshCw, color: "text-blue-600 dark:text-blue-400" },
  vault_action: { label: "Vault Action", icon: RefreshCw, color: "text-blue-600 dark:text-blue-400" },
  round_update: { label: "Round Update", icon: Clock, color: "text-vault-muted" },
  account_action: { label: "Account Action", icon: Wallet, color: "text-vault-muted" },
  system_message: { label: "System Message", icon: AlertCircle, color: "text-amber-600 dark:text-amber-400" },
};

const STATUS_LABELS = {
  confirmed: { label: "Confirmed", class: "text-emerald-600 dark:text-emerald-400" },
  pending: { label: "Pending", class: "text-amber-600 dark:text-amber-400" },
  failed: { label: "Failed", class: "text-red-600 dark:text-red-400" },
};

const PAGE_SIZE = 10;

export function ActivityFeed({ transactions, privacyMode = false }) {
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
        <div className="flex items-center gap-2 overflow-x-auto pb-2 sm:pb-0 hide-scrollbar max-w-full">
          <Filter className="h-4 w-4 text-vault-muted shrink-0 hidden sm:block" />
          <div className="flex gap-2">
            {[
              { id: "all", label: "All Activity" },
              { id: "deposit", label: "Deposits" },
              { id: "withdraw", label: "Withdrawals" },
              { id: "reward", label: "Claims" },
              { id: "vault_action", label: "Vault Actions" },
              { id: "round_update", label: "Round Updates" },
              { id: "account_action", label: "Account" },
              { id: "system_message", label: "System" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => { setFilter(tab.id); setPage(0); }}
                className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                  filter === tab.id
                    ? "bg-red-500/10 text-red-500 dark:text-red-400"
                    : "text-vault-muted hover:bg-vault-surface hover:text-vault-text"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
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
                  <p className="text-xs text-vault-muted">
                    {maskPoolLabel(tx, privacyMode)}
                  </p>
                  <p className="mt-0.5 text-xs text-vault-muted">
                    {new Date(tx.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
                {tx.amount !== undefined ? (
                  <div className="text-right shrink-0">
                    <p className={`font-semibold ${tx.type === "withdraw" ? "text-vault-muted" : "text-emerald-600 dark:text-emerald-400"}`}>
                      {tx.type === "withdraw" ? "\u2212" : "+"}${tx.amount.toLocaleString()}
                    </p>
                    <p className="text-xs text-vault-muted">{tx.asset || "USDC"}</p>
                  </div>
                ) : null}
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
  const [privacyMode, setPrivacyMode] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setPrivacyMode(window.localStorage.getItem(ACTIVITY_PRIVACY_MODE_KEY) === "true");
  }, []);

  const togglePrivacyMode = useCallback(() => {
    setPrivacyMode((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(ACTIVITY_PRIVACY_MODE_KEY, String(next));
      }
      return next;
    });
  }, []);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-vault-text">Account Activity</h1>
          <p className="mt-2 text-vault-muted">Track deposits, withdrawals, and prize claims from your wallet.</p>
        </div>
        {isConnected && (
          <button
            type="button"
            onClick={togglePrivacyMode}
            aria-pressed={privacyMode}
            title="Hide vault/pool names in your local activity view. On-chain data is still public and unaffected."
            className="vq-btn-ghost inline-flex items-center gap-2 text-sm"
          >
            {privacyMode ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
            {privacyMode ? "Privacy mode: On" : "Privacy mode: Off"}
          </button>
        )}
      </header>

      {isConnected ? (
        <UserActivityTimeline key={address} walletAddress={address ?? null} privacyMode={privacyMode} />
      ) : (
        <EmptyActivity />
      )}
    </div>
  );
}
