"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Globe,
  Inbox,
  Layers,
  MailOpen,
  ShieldAlert,
  User,
} from "lucide-react";
import {
  NotificationProvider,
  useNotificationCenter,
} from "@/src/providers/NotificationProvider";
import type { NotificationScope, NotificationType } from "@/lib/notification-dedup";

/**
 * Demo/seed alerts for the notification center (#652).
 *
 * Two pairs deliberately look like duplicates:
 *  - the repeated vault APY alert (same `vault` scope + subject) collapses into
 *    one *current* notification, keeping the latest APY message;
 *  - the protocol pause is emitted once at `global` scope and once at `vault`
 *    scope — different identities, so neither is swallowed by the other.
 */
const SEED_ALERTS = [
  {
    type: "apy_change" as NotificationType,
    scope: "vault" as NotificationScope,
    subject: "XLM Drip Vault",
    title: "Vault APY updated",
    message: "Projected APY changed to 4.1% after strategy rebalance.",
    date: "2026-06-21T09:20:00.000Z",
    expiresAt: "2026-07-05T00:00:00.000Z",
  },
  {
    type: "apy_change" as NotificationType,
    scope: "vault" as NotificationScope,
    subject: "XLM Drip Vault",
    title: "Vault APY updated",
    message: "Projected APY changed to 4.6% after the latest strategy rebalance.",
    date: "2026-06-22T09:10:00.000Z",
    expiresAt: "2026-07-05T00:00:00.000Z",
  },
  {
    type: "vault_pause" as NotificationType,
    scope: "global" as NotificationScope,
    title: "Protocol pause lifted",
    message: "Settlement resumed across all vaults and reward drafting.",
    date: "2026-06-20T12:00:00.000Z",
    expiresAt: "2026-07-01T00:00:00.000Z",
  },
  {
    type: "vault_pause" as NotificationType,
    scope: "vault" as NotificationScope,
    subject: "USDC Stable Pool",
    title: "Vault pause lifted",
    message: "Deposits reopened for the USDC Stable Pool after review.",
    date: "2026-06-20T12:05:00.000Z",
    expiresAt: "2026-07-01T00:00:00.000Z",
  },
  {
    type: "reward_event" as NotificationType,
    scope: "wallet" as NotificationScope,
    subject: "GBBD...FLA5",
    title: "Weekly draw completed",
    message: "Prize winners were selected and the next round is now open.",
    date: "2026-06-24T18:30:00.000Z",
  },
  {
    type: "deposit" as NotificationType,
    scope: "wallet" as NotificationScope,
    subject: "GBBD...FLA5",
    title: "Deposit confirmed",
    message: "Your 0.42 ETH deposit was confirmed and tickets were updated.",
    date: "2026-06-24T15:10:00.000Z",
  },
  {
    type: "pending_transaction" as NotificationType,
    scope: "vault" as NotificationScope,
    subject: "BTC Reserve",
    title: "Withdrawal window opened",
    message: "Your lockup period ended and principal is available to withdraw.",
    date: "2026-06-18T12:00:00.000Z",
  },
  {
    type: "round_update" as NotificationType,
    scope: "global" as NotificationScope,
    title: "Round cadence updated",
    message: "The protocol round cadence changed to a weekly draw.",
    date: "2026-06-25T08:00:00.000Z",
    expiresAt: "2026-06-28T00:00:00.000Z",
  },
  // Expired alert — pruned on load by the provider.
  {
    type: "protocol_alert" as NotificationType,
    scope: "global" as NotificationScope,
    title: "Indexer lag spike",
    message: "Indexer temporarily lagged 12 ledgers.",
    date: "2026-06-01T04:00:00.000Z",
    expiresAt: "2026-06-10T00:00:00.000Z",
  },
];

const TYPE_LABELS = {
  apy_change: "APY update",
  pending_transaction: "Transaction",
  vault_pause: "Vault pause",
  reward_event: "Prize draw",
  protocol_alert: "Protocol",
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  round_update: "Round update",
  account: "Account",
};

const SCOPE_META = {
  global: { label: "Global", icon: Globe, className: "border-sky-400/30 bg-sky-500/10 text-sky-300" },
  vault: { label: "Vault", icon: Layers, className: "border-amber-400/30 bg-amber-500/10 text-amber-300" },
  wallet: { label: "Wallet", icon: User, className: "border-violet-400/30 bg-violet-500/10 text-violet-300" },
};

function formatDateLabel(dateValue) {
  return new Date(dateValue).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(dateValue) {
  return new Date(dateValue).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function ScopeBadge({ scope }) {
  const meta = SCOPE_META[scope] ?? SCOPE_META.global;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function NotificationsCenter() {
  const {
    notifications,
    unreadCount,
    markRead,
    markAllRead,
    dismiss,
    dismissAll,
    clearExpired,
  } = useNotificationCenter();
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [showDismissed, setShowDismissed] = useState(true);

  const visibleNotifications = useMemo(() => {
    let list = notifications;
    if (!showDismissed) list = list.filter((n) => !n.dismissed);
    if (showUnreadOnly) list = list.filter((n) => n.status === "unread");
    return list;
  }, [notifications, showUnreadOnly, showDismissed]);

  const groupedNotifications = useMemo(() => {
    return visibleNotifications.reduce((groups, notification) => {
      const label = formatDateLabel(notification.date);
      if (!groups[label]) groups[label] = [];
      groups[label].push(notification);
      return groups;
    }, {});
  }, [visibleNotifications]);

  const dismissedCount = notifications.filter((n) => n.dismissed).length;

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3 text-red-500">
            <Bell className="h-7 w-7" aria-hidden="true" />
            <h1 className="text-3xl font-bold text-vault-text">Vault Notifications</h1>
          </div>
          <p className="mt-2 max-w-2xl text-vault-muted">
            Protocol alerts are deduplicated by identity and scope — repeated APY changes, pauses,
            reward events and transaction updates collapse into one current notification.
          </p>
        </div>
        <Link href="/app/activity" className="vq-btn-ghost self-start sm:self-auto">
          View activity
        </Link>
      </header>

      <section className="grid gap-4 sm:grid-cols-3" aria-label="Notification summary">
        <div className="vq-glass-hover p-5">
          <Inbox className="h-5 w-5 text-red-500" aria-hidden="true" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-vault-muted">Total notifications</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{notifications.length}</p>
        </div>
        <div className="vq-glass-hover p-5">
          <MailOpen className="h-5 w-5 text-amber-500" aria-hidden="true" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-vault-muted">Unread</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{unreadCount}</p>
        </div>
        <div className="vq-glass-hover p-5">
          <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden="true" />
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-vault-muted">Dismissed</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{dismissedCount}</p>
        </div>
      </section>

      <section className="vq-glass p-4 sm:p-6" aria-labelledby="notification-history-title">
        <div className="flex flex-col gap-4 border-b border-vault-border pb-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 id="notification-history-title" className="text-lg font-semibold text-vault-text">
              Notification History
            </h2>
            <p className="text-sm text-vault-muted">Grouped by date; alerts are collapsed by identity and scope.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowUnreadOnly((current) => !current)}
              className="vq-btn-ghost"
            >
              {showUnreadOnly ? "Show all" : "Unread only"}
            </button>
            <button
              type="button"
              onClick={() => setShowDismissed((current) => !current)}
              className="vq-btn-ghost"
            >
              {showDismissed ? (
                <>
                  <EyeOff className="h-4 w-4" aria-hidden="true" /> Hide dismissed
                </>
              ) : (
                <>
                  <Eye className="h-4 w-4" aria-hidden="true" /> Show dismissed
                </>
              )}
            </button>
            <button type="button" onClick={markAllRead} className="vq-btn-ghost">
              <Check className="h-4 w-4" aria-hidden="true" /> Mark all read
            </button>
            <button type="button" onClick={() => dismissAll()} className="vq-btn-ghost">
              <ShieldAlert className="h-4 w-4" aria-hidden="true" /> Dismiss all
            </button>
            <button type="button" onClick={clearExpired} className="vq-btn-ghost">
              Clear expired
            </button>
          </div>
        </div>

        {visibleNotifications.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-16 text-center">
            <CheckCircle2 className="h-10 w-10 text-vault-muted" aria-hidden="true" />
            <h3 className="mt-4 text-lg font-semibold text-vault-text">No notifications to show</h3>
            <p className="mt-2 max-w-md text-sm text-vault-muted">
              Empty states appear when the current filters hide every notification.
            </p>
          </div>
        ) : (
          <div className="space-y-6 pt-5">
            {Object.entries(groupedNotifications).map(([dateLabel, items]) => (
              <div key={dateLabel}>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-vault-muted">{dateLabel}</h3>
                <ul className="mt-3 divide-y divide-vault-border rounded-xl border border-vault-border bg-vault-surface/30" role="list">
                  {items.map((notification) => {
                    const isRead = notification.status === "read";
                    return (
                      <li key={notification.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="flex gap-3">
                          <span className={`mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-vault-border ${isRead ? "bg-vault-surface text-vault-muted" : "bg-red-500/10 text-red-500"}`}>
                            {isRead ? <Check className="h-4 w-4" aria-hidden="true" /> : <Bell className="h-4 w-4" aria-hidden="true" />}
                          </span>
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="font-semibold text-vault-text">{notification.title}</p>
                              <ScopeBadge scope={notification.scope} />
                              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${isRead ? "border-vault-border text-vault-muted" : "border-red-400/30 bg-red-500/10 text-red-500"}`}>
                                {isRead ? "Read" : "Unread"}
                              </span>
                              {notification.dismissed && (
                                <span className="rounded-full border border-vault-border px-2 py-0.5 text-xs font-semibold text-vault-muted">
                                  Dismissed
                                </span>
                              )}
                              {notification.version > 1 && (
                                <span className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                                  Updated ×{notification.version}
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-sm text-vault-muted">{notification.message}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-vault-muted">
                              <span>{TYPE_LABELS[notification.type] ?? notification.type}</span>
                              <span aria-hidden="true">·</span>
                              <span>{notification.vault ?? notification.subject ?? "Protocol"}</span>
                              <span aria-hidden="true">·</span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                                {formatTime(notification.date)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {!isRead && (
                            <button
                              type="button"
                              onClick={() => markRead(notification.id)}
                              className="vq-btn-primary px-3 py-1.5 text-xs"
                            >
                              <Check className="h-4 w-4" aria-hidden="true" />
                              Mark read
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => dismiss(notification.id)}
                            className="vq-btn-ghost px-3 py-1.5 text-xs"
                          >
                            <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                            Dismiss
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default function VaultNotificationsPage() {
  return (
    <NotificationProvider scopeKey="account@default" initialAlerts={SEED_ALERTS}>
      <NotificationsCenter />
    </NotificationProvider>
  );
}