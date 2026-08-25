"use client";

import Link from "next/link";
import { Vault, Search, Clock, TrendingUp, ArrowRight, PlusCircle, RefreshCw } from "lucide-react";

/**
 * Reusable empty-state component for vault pages.
 *
 * variant options:
 *   "dashboard"  – connected wallet, no active vault positions
 *   "vaultList"  – filter/search returned zero results
 *   "activity"   – connected wallet, no transaction history yet
 */

const VARIANTS = {
  dashboard: {
    Icon: Vault,
    iconBg: "bg-red-500/10",
    iconColor: "text-red-500",
    title: "No active positions yet",
    description:
      "You haven't joined any prize savings vaults. Deposit to start earning yield tickets and enter weekly prize draws — your principal is always withdrawable.",
    actions: [
      { label: "Browse vaults", href: "/app/vaults", primary: true, Icon: ArrowRight },
      { label: "Learn how it works", href: "/docs", primary: false, Icon: TrendingUp },
    ],
  },
  vaultList: {
    Icon: Search,
    iconBg: "bg-blue-500/10",
    iconColor: "text-blue-400",
    title: "No vaults match your filters",
    description:
      "Try clearing some filters or broadening your search. There are active vaults available — adjust the criteria to find them.",
    actions: [
      { label: "Clear filters", onClick: true, primary: true, Icon: RefreshCw },
      { label: "View all vaults", href: "/app/vaults", primary: false, Icon: ArrowRight },
    ],
  },
  activity: {
    Icon: Clock,
    iconBg: "bg-amber-500/10",
    iconColor: "text-amber-400",
    title: "No activity yet",
    description:
      "Your deposits, withdrawals, and prize claims will appear here once you start saving. Make your first deposit to get started.",
    actions: [
      { label: "Make a deposit", href: "/app/vaults", primary: true, Icon: PlusCircle },
      { label: "View vaults", href: "/app/vaults", primary: false, Icon: Vault },
    ],
  },
};

export default function VaultEmptyState({ variant = "dashboard", onClearFilters }) {
  const config = VARIANTS[variant] ?? VARIANTS.dashboard;
  const { Icon, iconBg, iconColor, title, description, actions } = config;

  return (
    <div className="vq-glass flex flex-col items-center px-6 py-16 text-center sm:px-12">
      {/* Icon */}
      <span
        className={`flex h-16 w-16 items-center justify-center rounded-full border border-vault-border ring-2 ring-vault-border/30 ${iconBg} ${iconColor}`}
      >
        <Icon className="h-8 w-8" aria-hidden="true" />
      </span>

      {/* Copy */}
      <h2 className="mt-6 text-xl font-semibold text-vault-text">{title}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-vault-muted">{description}</p>

      {/* Actions */}
      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
        {actions.map((action) => {
          const ActionIcon = action.Icon;
          const cls = action.primary
            ? "vq-btn-primary inline-flex items-center gap-2"
            : "vq-btn-ghost inline-flex items-center gap-2";

          if (action.onClick) {
            return (
              <button key={action.label} type="button" onClick={onClearFilters} className={cls}>
                <ActionIcon className="h-4 w-4" aria-hidden="true" />
                {action.label}
              </button>
            );
          }

          return (
            <Link key={action.label} href={action.href} className={cls}>
              <ActionIcon className="h-4 w-4" aria-hidden="true" />
              {action.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
