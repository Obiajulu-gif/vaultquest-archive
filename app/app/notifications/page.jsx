"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Bell, Check, CheckCircle2, Clock, Inbox, MailOpen } from "lucide-react";

const NOTIFICATIONS = [
  {
    id: "notif-001",
    title: "Weekly draw completed",
    vault: "USDC Stable Pool",
    date: "2026-06-24T18:30:00.000Z",
    status: "unread",
    type: "Prize draw",
    message: "Prize winners were selected and the next round is now open.",
  },
  {
    id: "notif-002",
    title: "Deposit confirmed",
    vault: "ETH Growth Pool",
    date: "2026-06-24T15:10:00.000Z",
    status: "read",
    type: "Deposit",
    message: "Your 0.42 ETH deposit was confirmed and tickets were updated.",
  },
  {
    id: "notif-003",
    title: "Vault APY updated",
    vault: "XLM Drip Vault",
    date: "2026-06-21T09:20:00.000Z",
    status: "unread",
    type: "Vault update",
    message: "Projected APY changed after the latest strategy rebalance.",
  },
  {
    id: "notif-004",
    title: "Withdrawal window opened",
    vault: "BTC Reserve",
    date: "2026-06-18T12:00:00.000Z",
    status: "read",
    type: "Account",
    message: "Your lockup period ended and principal is available to withdraw.",
  },
];

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

export default function VaultNotificationsPage() {
  const [readIds, setReadIds] = useState(() =>
    new Set(NOTIFICATIONS.filter((notification) => notification.status === "read").map((notification) => notification.id))
  );
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);

  const notifications = useMemo(() => {
    return NOTIFICATIONS.map((notification) => ({
      ...notification,
      status: readIds.has(notification.id) ? "read" : "unread",
    }));
  }, [readIds]);

  const visibleNotifications = useMemo(() => {
    if (!showUnreadOnly) return notifications;
    return notifications.filter((notification) => notification.status === "unread");
  }, [notifications, showUnreadOnly]);

  const groupedNotifications = useMemo(() => {
    return visibleNotifications.reduce((groups, notification) => {
      const label = formatDateLabel(notification.date);
      if (!groups[label]) groups[label] = [];
      groups[label].push(notification);
      return groups;
    }, {});
  }, [visibleNotifications]);

  const unreadCount = notifications.filter((notification) => notification.status === "unread").length;

  const markRead = (id) => {
    setReadIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3 text-red-500">
            <Bell className="h-7 w-7" aria-hidden="true" />
            <h1 className="text-3xl font-bold text-vault-text">Vault Notifications</h1>
          </div>
          <p className="mt-2 max-w-2xl text-vault-muted">
            Review past vault notices, status changes, deposits, draw updates, and account reminders.
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
          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-vault-muted">Read</p>
          <p className="mt-1 text-2xl font-bold text-vault-text">{notifications.length - unreadCount}</p>
        </div>
      </section>

      <section className="vq-glass p-4 sm:p-6" aria-labelledby="notification-history-title">
        <div className="flex flex-col gap-4 border-b border-vault-border pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 id="notification-history-title" className="text-lg font-semibold text-vault-text">
              Notification History
            </h2>
            <p className="text-sm text-vault-muted">Grouped by date with current read status.</p>
          </div>
          <button
            type="button"
            onClick={() => setShowUnreadOnly((current) => !current)}
            className="vq-btn-ghost self-start sm:self-auto"
          >
            {showUnreadOnly ? "Show all" : "Unread only"}
          </button>
        </div>

        {visibleNotifications.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-16 text-center">
            <CheckCircle2 className="h-10 w-10 text-vault-muted" aria-hidden="true" />
            <h3 className="mt-4 text-lg font-semibold text-vault-text">No notifications to show</h3>
            <p className="mt-2 max-w-md text-sm text-vault-muted">
              Empty states will appear when a user has no history or when filters hide every notification.
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
                              <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${isRead ? "border-vault-border text-vault-muted" : "border-red-400/30 bg-red-500/10 text-red-500"}`}>
                                {isRead ? "Read" : "Unread"}
                              </span>
                            </div>
                            <p className="mt-1 text-sm text-vault-muted">{notification.message}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-vault-muted">
                              <span>{notification.type}</span>
                              <span aria-hidden="true">·</span>
                              <span>{notification.vault}</span>
                              <span aria-hidden="true">·</span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                                {formatTime(notification.date)}
                              </span>
                            </div>
                          </div>
                        </div>
                        {!isRead && (
                          <button
                            type="button"
                            onClick={() => markRead(notification.id)}
                            className="vq-btn-primary w-full sm:w-auto"
                          >
                            <Check className="h-4 w-4" aria-hidden="true" />
                            Mark read
                          </button>
                        )}
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
