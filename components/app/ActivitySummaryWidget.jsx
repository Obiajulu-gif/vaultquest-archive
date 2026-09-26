"use client";

import { useEffect, useState } from "react";
import { Activity, ArrowUpRight, ArrowDownLeft, Clock } from "lucide-react";

const PLACEHOLDER_ACTIVITIES = [
  {
    id: 1,
    type: "deposit",
    label: "Deposited 100 USDC into Prize Vault",
    amount: "+100 USDC",
    time: "2 hours ago",
    icon: ArrowDownLeft,
    positive: true,
  },
  {
    id: 2,
    type: "withdraw",
    label: "Withdrew 50 USDC from Prize Vault",
    amount: "-50 USDC",
    time: "1 day ago",
    icon: ArrowUpRight,
    positive: false,
  },
  {
    id: 3,
    type: "prize",
    label: "Won 25 USDC in weekly draw",
    amount: "+25 USDC",
    time: "3 days ago",
    icon: ArrowDownLeft,
    positive: true,
  },
  {
    id: 4,
    type: "deposit",
    label: "Deposited 200 USDC into Savings Vault",
    amount: "+200 USDC",
    time: "5 days ago",
    icon: ArrowDownLeft,
    positive: true,
  },
];

export default function ActivitySummaryWidget() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="vq-glass p-6">
        <div className="h-5 w-32 bg-vault-border/30 rounded animate-pulse" />
        <div className="mt-4 space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-14 bg-vault-border/20 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="vq-glass p-6">
      <div className="flex items-center justify-between border-b border-vault-border/30 pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-vault-accent" aria-hidden="true" />
          <h3 className="text-sm font-bold text-vault-text">Recent Activity</h3>
        </div>
        <span className="text-xs text-vault-muted">
          <Clock className="inline h-3.5 w-3.5 mr-1" aria-hidden="true" />
          Last 7 days
        </span>
      </div>

      <ul className="mt-3 space-y-2">
        {PLACEHOLDER_ACTIVITIES.map((item) => {
          const Icon = item.icon;
          return (
            <li
              key={item.id}
              className="flex items-center gap-3 rounded-xl border border-vault-border/20 bg-vault-surface/40 px-4 py-3 transition-colors hover:bg-vault-surface/80"
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  item.positive
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-red-500/10 text-red-600 dark:text-red-400"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-vault-text truncate">
                  {item.label}
                </p>
                <p className="text-xs text-vault-muted">{item.time}</p>
              </div>
              <span
                className={`text-sm font-semibold shrink-0 ${
                  item.positive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                }`}
              >
                {item.amount}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
