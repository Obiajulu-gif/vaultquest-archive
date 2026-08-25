"use client";

import { Activity, Users, Info } from "lucide-react";

function InsightSkeleton() {
  return (
    <section className="vq-glass space-y-4 p-4 sm:p-6" aria-label="Loading participant insights">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 animate-pulse rounded-xl bg-vault-border/30" />
        <div className="space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-vault-border/40" />
          <div className="h-3 w-56 animate-pulse rounded bg-vault-border/25" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="h-20 animate-pulse rounded-xl bg-vault-border/20" />
        <div className="h-20 animate-pulse rounded-xl bg-vault-border/20" />
      </div>
    </section>
  );
}

function EmptyInsights() {
  return (
    <section className="vq-glass p-4 sm:p-6" aria-label="Participant insights">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-muted">
          <Info className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-lg font-bold text-vault-text">Participant Insights</h2>
          <p className="mt-1 text-sm text-vault-muted">
            Participant data is not available for this vault yet.
          </p>
        </div>
      </div>
    </section>
  );
}

export default function VaultParticipantInsights({ vault, isLoading = false }) {
  if (isLoading) return <InsightSkeleton />;

  const hasParticipantCount = Number.isFinite(vault?.participantCount);
  const trend = vault?.activityTrend;

  if (!hasParticipantCount && !trend) {
    return <EmptyInsights />;
  }

  return (
    <section className="vq-glass space-y-5 p-4 sm:p-6" aria-labelledby="participant-insights-title">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-red-500">
          <Users className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id="participant-insights-title" className="text-lg font-bold text-vault-text">
            Participant Insights
          </h2>
          <p className="mt-1 text-sm text-vault-muted">
            Simple participation signals for this vault round.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-vault-muted">
            <Users className="h-4 w-4" aria-hidden="true" />
            Participant count
          </div>
          <p className="mt-2 text-2xl font-black text-vault-text">
            {hasParticipantCount ? vault.participantCount.toLocaleString("en-US") : "Pending"}
          </p>
        </div>

        <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-vault-muted">
            <Activity className="h-4 w-4" aria-hidden="true" />
            Activity trend
          </div>
          <p className="mt-2 text-sm font-medium leading-relaxed text-vault-text">
            {trend || "Trend placeholder pending"}
          </p>
        </div>
      </div>
    </section>
  );
}
