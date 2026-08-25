"use client";

import { useEffect, useState } from "react";
import { Shield, CheckCircle, AlertTriangle, TrendingUp, DollarSign } from "lucide-react";

const PLACEHOLDER_STATUS = {
  totalDeposits: 1250,
  totalWithdrawn: 50,
  netEarnings: 25,
  status: "active" as const,
  memberSince: "January 2025",
};

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

export default function AccountStatusWidget() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="vq-glass p-6">
        <div className="h-5 w-32 bg-vault-border/30 rounded animate-pulse" />
        <div className="mt-4 space-y-3">
          <div className="h-16 bg-vault-border/20 rounded-lg animate-pulse" />
          <div className="h-16 bg-vault-border/20 rounded-lg animate-pulse" />
        </div>
      </div>
    );
  }

  const { totalDeposits, netEarnings, status, memberSince } = PLACEHOLDER_STATUS;

  return (
    <div className="vq-glass p-6">
      <div className="flex items-center justify-between border-b border-vault-border/30 pb-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-vault-accent" aria-hidden="true" />
          <h3 className="text-sm font-bold text-vault-text">Account Status</h3>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            status === "active"
              ? "bg-green-500/10 text-green-600 dark:text-green-400"
              : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          }`}
        >
          {status === "active" ? (
            <CheckCircle className="h-3 w-3" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          )}
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-vault-border/20 bg-vault-surface/40 p-4">
          <div className="flex items-center gap-2 text-xs text-vault-muted">
            <DollarSign className="h-3.5 w-3.5" aria-hidden="true" />
            Total Deposits
          </div>
          <p className="mt-1 text-lg font-bold text-vault-text">
            {formatCurrency(totalDeposits)}
          </p>
        </div>
        <div className="rounded-xl border border-vault-border/20 bg-vault-surface/40 p-4">
          <div className="flex items-center gap-2 text-xs text-vault-muted">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            Net Earnings
          </div>
          <p className="mt-1 text-lg font-bold text-green-600 dark:text-green-400">
            +{formatCurrency(netEarnings)}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-vault-border/20 bg-vault-surface/40 px-4 py-3">
        <p className="text-xs text-vault-muted">
          Member since <span className="font-medium text-vault-text">{memberSince}</span>
        </p>
      </div>
    </div>
  );
}
