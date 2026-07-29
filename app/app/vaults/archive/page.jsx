"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Archive, CalendarDays, ChevronLeft, Trophy, Users } from "lucide-react";
import { VAULT_ROUND_ARCHIVE } from "@/lib/vault-mock-data";

const PAGE_SIZE = 3;

function formatDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatCurrency(value) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function SummaryMetric({ icon: Icon, label, value }) {
  return (
    <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-vault-muted">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {label}
      </div>
      <p className="mt-2 text-xl font-black text-vault-text">{value}</p>
    </div>
  );
}

export default function VaultRoundArchivePage() {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const completedRounds = useMemo(
    () =>
      [...VAULT_ROUND_ARCHIVE].sort(
        (a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime(),
      ),
    [],
  );

  const visibleRounds = completedRounds.slice(0, visibleCount);
  const hasMore = visibleCount < completedRounds.length;

  const totals = completedRounds.reduce(
    (acc, round) => ({
      participants: acc.participants + round.participants,
      deposits: acc.deposits + round.totalDeposits,
      prizes: acc.prizes + round.prizePayout,
      winners: acc.winners + round.winnerCount,
    }),
    { participants: 0, deposits: 0, prizes: 0, winners: 0 },
  );

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1 text-xs font-medium text-vault-muted">
            <Archive className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
            Completed vault rounds
          </div>
          <h1 className="mt-4 text-3xl font-bold text-vault-text">Round Archive</h1>
          <p className="mt-2 max-w-2xl text-vault-muted">
            Review closed vault rounds, dates, participation, deposits, and prize outcomes.
          </p>
        </div>
        <Link href="/app/vaults" className="vq-btn-ghost self-start">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back to vaults
        </Link>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Archive summary metrics">
        <SummaryMetric icon={Users} label="Participants" value={totals.participants.toLocaleString("en-US")} />
        <SummaryMetric icon={Archive} label="Deposits archived" value={formatCurrency(totals.deposits)} />
        <SummaryMetric icon={Trophy} label="Prizes paid" value={formatCurrency(totals.prizes)} />
        <SummaryMetric icon={Trophy} label="Winners" value={totals.winners.toLocaleString("en-US")} />
      </section>

      {completedRounds.length === 0 ? (
        <section className="vq-glass flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-vault-border bg-vault-surface text-vault-muted">
            <Archive className="h-8 w-8" aria-hidden="true" />
          </span>
          <h2 className="mt-6 text-xl font-semibold text-vault-text">No completed rounds yet</h2>
          <p className="mt-2 max-w-md text-sm text-vault-muted">
            Past vault rounds will appear here once the first round is completed.
          </p>
        </section>
      ) : (
        <section className="space-y-4" aria-label="Completed rounds">
          {visibleRounds.map((round) => (
            <article key={round.id} className="vq-glass-hover p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-bold text-vault-text">{round.vaultName}</h2>
                    <span className="rounded-full border border-vault-border bg-vault-surface px-2.5 py-1 text-xs font-semibold text-vault-muted">
                      {round.network} · {round.asset}
                    </span>
                  </div>
                  <p className="mt-2 flex items-center gap-2 text-sm text-vault-muted">
                    <CalendarDays className="h-4 w-4" aria-hidden="true" />
                    {formatDate(round.startDate)} to {formatDate(round.endDate)}
                  </p>
                </div>
                <Link href={`/app/vaults/${round.vaultId}`} className="vq-btn-ghost self-start py-1.5">
                  View vault
                </Link>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryMetric icon={Users} label="Participants" value={round.participants.toLocaleString("en-US")} />
                <SummaryMetric icon={Archive} label="Total deposits" value={formatCurrency(round.totalDeposits)} />
                <SummaryMetric icon={Trophy} label="Yield generated" value={formatCurrency(round.yieldGenerated)} />
                <SummaryMetric icon={Trophy} label="Prize payout" value={formatCurrency(round.prizePayout)} />
              </div>
            </article>
          ))}

          <div className="flex flex-col items-center gap-3 pt-2">
            {hasMore ? (
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                className="vq-btn-primary"
              >
                Load more rounds
              </button>
            ) : (
              <p className="rounded-full border border-vault-border bg-vault-surface px-4 py-2 text-sm text-vault-muted">
                All completed rounds loaded
              </p>
            )}
            <p className="text-xs text-vault-muted">
              Showing {visibleRounds.length} of {completedRounds.length} completed rounds
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
