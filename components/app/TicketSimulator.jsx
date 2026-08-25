"use client";

import { useMemo, useState } from "react";
import { Calculator, Ticket, Trophy, Users, Wallet } from "lucide-react";
import { PUBLIC_STATS } from "@/lib/demo-portfolio";

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function formatUsd(value) {
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function TicketSimulator() {
  const [ticketCount, setTicketCount] = useState(12);
  const [ticketValue, setTicketValue] = useState(25);

  const metrics = useMemo(() => {
    const impliedPoolEntries = Math.max(1, Math.round(PUBLIC_STATS.tvl / Math.max(1, ticketValue * 120)));
    const totalEntries = impliedPoolEntries + PUBLIC_STATS.activeSavers;
    const winningChance = Math.min(99.99, (ticketCount / (ticketCount + totalEntries)) * 100);
    const prizeCoverage = (ticketCount * ticketValue) / Math.max(1, PUBLIC_STATS.prizePool);
    const expectedPayout = (PUBLIC_STATS.prizePool * (ticketCount / (ticketCount + totalEntries))) / Math.max(1, ticketCount);

    return {
      impliedPoolEntries,
      totalEntries,
      winningChance,
      prizeCoverage,
      expectedPayout,
    };
  }, [ticketCount, ticketValue]);

  return (
    <section className="vq-glass-hover p-5 sm:p-6">
      <div className="flex flex-col gap-3 border-b border-vault-border/40 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            <Ticket className="h-4 w-4 text-red-500" aria-hidden="true" />
            Prize simulator
          </div>
          <h2 className="mt-1 text-xl font-semibold text-vault-text">
            Estimate winning odds before you deposit
          </h2>
        </div>
        <div className="rounded-full border border-vault-border/50 bg-vault-surface/30 px-3 py-1 text-xs font-semibold text-vault-muted">
          Pool volume: {formatUsd(PUBLIC_STATS.tvl)}
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-5 rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-5">
          <div className="space-y-3">
            <label htmlFor="ticket-count" className="flex items-center gap-2 text-sm font-medium text-vault-text">
              <Ticket className="h-4 w-4 text-red-500" aria-hidden="true" />
              Ticket count
            </label>
            <input
              id="ticket-count"
              type="range"
              min="1"
              max="120"
              step="1"
              value={ticketCount}
              onChange={(event) => setTicketCount(Number(event.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-vault-border accent-red-500"
            />
            <div className="flex items-center justify-between text-xs text-vault-muted">
              <span>1 ticket</span>
              <span>{ticketCount} tickets</span>
              <span>120 tickets</span>
            </div>
          </div>

          <div className="space-y-3">
            <label htmlFor="ticket-value" className="flex items-center gap-2 text-sm font-medium text-vault-text">
              <Wallet className="h-4 w-4 text-red-500" aria-hidden="true" />
              Ticket value
            </label>
            <input
              id="ticket-value"
              type="range"
              min="5"
              max="100"
              step="5"
              value={ticketValue}
              onChange={(event) => setTicketValue(Number(event.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-vault-border accent-red-500"
            />
            <div className="flex items-center justify-between text-xs text-vault-muted">
              <span>$5 stake</span>
              <span>${ticketValue} stake</span>
              <span>$100 stake</span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-vault-border/40 bg-vault-surface/35 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">Active savers</p>
              <p className="mt-1 text-2xl font-bold text-vault-text">{PUBLIC_STATS.activeSavers.toLocaleString()}</p>
            </div>
            <div className="rounded-2xl border border-vault-border/40 bg-vault-surface/35 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">Prize pool</p>
              <p className="mt-1 text-2xl font-bold text-amber-500 dark:text-amber-400">{formatUsd(PUBLIC_STATS.prizePool)}</p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <article className="vq-glass p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
              <Calculator className="h-4 w-4 text-red-500" aria-hidden="true" />
              Win chance
            </div>
            <p className="mt-2 text-3xl font-black text-vault-text">{formatPercent(metrics.winningChance)}</p>
            <p className="mt-1 text-sm text-vault-muted">Estimated with current pool volume and saver count.</p>
          </article>

          <article className="vq-glass p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
              <Users className="h-4 w-4 text-red-500" aria-hidden="true" />
              Pool pressure
            </div>
            <p className="mt-2 text-3xl font-black text-vault-text">{metrics.totalEntries.toLocaleString()}</p>
            <p className="mt-1 text-sm text-vault-muted">Implied entries across the current round.</p>
          </article>

          <article className="vq-glass p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
              <Trophy className="h-4 w-4 text-red-500" aria-hidden="true" />
              Expected payout
            </div>
            <p className="mt-2 text-3xl font-black text-emerald-500 dark:text-emerald-400">{formatUsd(metrics.expectedPayout)}</p>
            <p className="mt-1 text-sm text-vault-muted">Per-ticket value based on the active pool metrics.</p>
          </article>

          <article className="vq-glass p-4">
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-vault-muted">
              <Wallet className="h-4 w-4 text-red-500" aria-hidden="true" />
              Contribution coverage
            </div>
            <p className="mt-2 text-3xl font-black text-vault-text">{formatPercent(metrics.prizeCoverage * 100)}</p>
            <p className="mt-1 text-sm text-vault-muted">Share of the prize pool implied by the selected stake.</p>
          </article>
        </div>
      </div>
    </section>
  );
}