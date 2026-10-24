"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Clock, Gift, RefreshCw } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_VAULTQUEST_API_BASE_URL || "/api";
const PAGE_SIZE = 20;

const FILTERS = [
  { value: "", label: "All activity" },
  { value: "deposit", label: "Deposits" },
  { value: "withdrawal", label: "Withdrawals" },
  { value: "prize_claim", label: "Prize claims" }
];

const EVENT_PRESENTATION = {
  deposit: { label: "Deposit", icon: ArrowDownRight, tone: "text-emerald-600 dark:text-emerald-400" },
  withdrawal: { label: "Withdrawal", icon: ArrowUpRight, tone: "text-vault-muted" },
  prize_claim: { label: "Prize claimed", icon: Gift, tone: "text-amber-600 dark:text-amber-400" }
};

const STATUS_PRESENTATION = {
  pending: { label: "Pending", tone: "text-amber-600 dark:text-amber-400" },
  submitted: { label: "Submitted", tone: "text-blue-600 dark:text-blue-400" },
  confirmed: { label: "Confirmed", tone: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Not completed", tone: "text-red-600 dark:text-red-400" },
  reverted: { label: "Reverted", tone: "text-red-600 dark:text-red-400" },
  orphaned: { label: "Needs review", tone: "text-amber-600 dark:text-amber-400" }
};

function formatOccurredAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function UserActivityTimeline({ walletAddress, privacyMode }) {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(null);
  const [cursorHistory, setCursorHistory] = useState([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [events, setEvents] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!walletAddress) {
      setEvents([]);
      setNextCursor(null);
      return undefined;
    }

    const controller = new AbortController();
    const sessionToken = window.sessionStorage.getItem("vaultquest.walletSessionToken");
    if (!sessionToken) {
      setEvents([]);
      setNextCursor(null);
      setError("Authenticate this wallet session to view private account activity.");
      setLoading(false);
      return () => controller.abort();
    }

    const params = new URLSearchParams({ wallet: walletAddress, limit: String(PAGE_SIZE) });
    if (filter) params.set("type", filter);
    if (cursor) params.set("cursor", cursor);

    setLoading(true);
    setError("");
    fetch(`${API_BASE}/activity?${params.toString()}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(response.status === 401 || response.status === 403
            ? "Your wallet session does not match this account. Authenticate again to view activity."
            : "Activity could not be loaded. Try again.");
        }
        return response.json();
      })
      .then((body) => {
        setEvents(Array.isArray(body?.data) ? body.data : []);
        setNextCursor(body?.meta?.pagination?.next_cursor ?? null);
      })
      .catch((fetchError) => {
        if (fetchError.name !== "AbortError") {
          setEvents([]);
          setNextCursor(null);
          setError(fetchError.message || "Activity could not be loaded. Try again.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [walletAddress, filter, cursor]);

  function changeFilter(value) {
    setFilter(value);
    setCursor(null);
    setCursorHistory([]);
    setPageNumber(1);
  }

  function goNext() {
    if (!nextCursor || loading) return;
    setCursorHistory((history) => [...history, cursor]);
    setCursor(nextCursor);
    setPageNumber((page) => page + 1);
  }

  function goPrevious() {
    if (cursorHistory.length === 0 || loading) return;
    setCursor(cursorHistory[cursorHistory.length - 1]);
    setCursorHistory((history) => history.slice(0, -1));
    setPageNumber((page) => Math.max(1, page - 1));
  }

  return (
    <section className="vq-glass p-4 sm:p-6" aria-labelledby="activity-timeline-title" aria-busy={loading}>
      <div className="flex flex-col gap-4 border-b border-vault-border pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="activity-timeline-title" className="text-lg font-semibold text-vault-text">Activity timeline</h2>
          <p className="text-sm text-vault-muted">Your deposits, withdrawals, and prize claims</p>
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto" aria-label="Filter activity by type" role="group">
          {FILTERS.map((option) => (
            <button
              key={option.value || "all"}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => changeFilter(option.value)}
              className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                filter === option.value
                  ? "border-red-500 text-vault-text"
                  : "border-transparent text-vault-muted hover:text-vault-text"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="py-10 text-center text-sm text-red-500" role="alert">{error}</p>
      ) : loading && events.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-vault-muted" role="status">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading activity
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center">
          <Clock className="h-7 w-7 text-vault-muted" aria-hidden="true" />
          <p className="text-sm text-vault-muted">No activity in this view.</p>
        </div>
      ) : (
        <ol className="divide-y divide-vault-border" aria-label="Account activity">
          {events.map((event) => {
            const presentation = EVENT_PRESENTATION[event.type];
            if (!presentation) return null;
            const Icon = presentation.icon;
            const status = STATUS_PRESENTATION[event.status] ?? STATUS_PRESENTATION.pending;
            const amountPrefix = event.type === "withdrawal" ? "−" : "+";
            return (
              <li id={`activity-${event.id}`} key={event.id} className="flex items-center gap-3 py-4 sm:gap-4">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-vault-border bg-vault-surface ${presentation.tone}`}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="font-medium text-vault-text">{presentation.label}</p>
                    <span className={`text-xs font-medium ${status.tone}`}>{status.label}</span>
                  </div>
                  <p className="mt-1 text-xs text-vault-muted">{formatOccurredAt(event.occurred_at)}</p>
                  {event.resource_href && (
                    <Link href={event.resource_href} className="mt-1 inline-block text-xs text-vault-muted underline decoration-vault-border underline-offset-2 hover:text-vault-text">
                      {privacyMode ? "Open vault" : "View vault"}
                    </Link>
                  )}
                </div>
                {event.amount !== null && (
                  <div className="shrink-0 text-right">
                    <p className={`font-semibold tabular-nums ${event.type === "withdrawal" ? "text-vault-muted" : "text-emerald-600 dark:text-emerald-400"}`}>
                      {amountPrefix}{event.amount}
                    </p>
                    {event.asset && <p className="text-xs text-vault-muted">{event.asset}</p>}
                  </div>
                )}
                <Link href={event.href} aria-label={`Link to ${presentation.label.toLowerCase()} activity`} className="shrink-0 rounded p-2 text-vault-muted hover:bg-vault-surface hover:text-vault-text">
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex items-center justify-between border-t border-vault-border pt-4">
        <span className="text-xs text-vault-muted">Page {pageNumber}</span>
        <div className="flex gap-2">
          <button type="button" onClick={goPrevious} disabled={cursorHistory.length === 0 || loading} aria-label="Previous activity page" className="rounded border border-vault-border p-2 text-vault-muted hover:text-vault-text disabled:opacity-40">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={goNext} disabled={!nextCursor || loading} aria-label="Next activity page" className="rounded border border-vault-border p-2 text-vault-muted hover:text-vault-text disabled:opacity-40">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}