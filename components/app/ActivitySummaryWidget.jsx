"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { Activity, ArrowDownRight, ArrowUpRight, ChevronRight, Clock, Gift } from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_VAULTQUEST_API_BASE_URL || "/api";

const EVENT_LABELS = {
  deposit: "Deposit",
  withdrawal: "Withdrawal",
  prize_claim: "Prize claimed",
};

const EVENT_ICONS = {
  deposit: ArrowDownRight,
  withdrawal: ArrowUpRight,
  prize_claim: Gift,
};

export default function ActivitySummaryWidget() {
  const { address, isConnected } = useAccount();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isConnected || !address) {
      setEvents([]);
      setLoading(false);
      setError(false);
      return undefined;
    }

    const controller = new AbortController();
    const token = window.sessionStorage.getItem("vaultquest.walletSessionToken");
    if (!token) {
      setEvents([]);
      setLoading(false);
      setError(true);
      return () => controller.abort();
    }

    const query = new URLSearchParams({ wallet: address, limit: "4" });
    setLoading(true);
    setError(false);
    fetch(`${API_BASE}/activity?${query.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("activity unavailable");
        return response.json();
      })
      .then((body) => setEvents(Array.isArray(body?.data) ? body.data : []))
      .catch((fetchError) => {
        if (fetchError.name !== "AbortError") {
          setEvents([]);
          setError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [address, isConnected]);

  return (
    <div className="vq-glass p-6">
      <div className="flex items-center justify-between border-b border-vault-border/30 pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-vault-accent" aria-hidden="true" />
          <h3 className="text-sm font-bold text-vault-text">Recent Activity</h3>
        </div>
        <Link href="/app/activity" title="View all account activity" aria-label="View all account activity" className="rounded p-2 text-vault-muted hover:bg-vault-surface hover:text-vault-text">
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      {!isConnected ? (
        <p className="py-8 text-center text-sm text-vault-muted">Connect your wallet to view activity.</p>
      ) : loading ? (
        <div className="mt-4 space-y-3" role="status" aria-label="Loading activity">
          {[...Array(3)].map((_, index) => <div key={index} className="h-12 animate-pulse rounded bg-vault-border/20" />)}
        </div>
      ) : error ? (
        <p className="py-8 text-center text-sm text-vault-muted">Authenticate your wallet session to view activity.</p>
      ) : events.length === 0 ? (
        <p className="py-8 text-center text-sm text-vault-muted">No recent activity.</p>
      ) : (
        <ul className="mt-3 divide-y divide-vault-border/40">
          {events.map((event) => {
            const Icon = EVENT_ICONS[event.type] ?? Activity;
            const label = EVENT_LABELS[event.type] ?? "Activity";
            const amountPrefix = event.type === "withdrawal" ? "−" : "+";
            return (
              <li key={event.id} className="flex items-center gap-3 py-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-vault-border bg-vault-surface text-vault-muted">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-vault-text">{label}</p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-vault-muted">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {new Date(event.occurred_at).toLocaleDateString()}
                  </p>
                </div>
                {event.amount !== null && (
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-vault-text">
                    {amountPrefix}{event.amount} {event.asset ?? ""}
                  </span>
                )}
                <Link href={event.href} aria-label={`View ${label.toLowerCase()} activity`} className="text-vault-muted hover:text-vault-text">
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
