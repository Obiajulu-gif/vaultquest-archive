"use client";

import Link from "next/link";
import { useTranslation } from "next-i18next";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Gauge,
  Server,
  Shield,
  Settings,
  SquareStack,
} from "lucide-react";
import { motion } from "framer-motion";

const PROTOCOL_PARAMETERS = [
  {
    label: "Round duration",
    value: "7 days",
    note: "New rounds auto-open on a weekly cadence.",
  },
  {
    label: "Minimum deposit",
    value: "100 XLM",
    note: "Keeps operational churn low for small deposits.",
  },
  {
    label: "Maximum deposit per vault",
    value: "250,000 XLM",
    note: "Prevents single-wallet concentration risk.",
  },
  {
    label: "Treasury fee",
    value: "0.75%",
    note: "Applied to routed yield before prize allocation.",
  },
  {
    label: "Settlement quorum",
    value: "3 of 5",
    note: "Requires multisig approval for admin writes.",
  },
  {
    label: "Emergency pause threshold",
    value: "2 failed attempts",
    note: "Triggers manual review before retrying settlement.",
  },
];

const ACTIVE_ROUNDS = [
  {
    name: "XLM Community Drip",
    status: "drawing",
    pool: "18.4M XLM",
    participants: "8,412 savers",
    deadline: "Draw closes in 31 minutes",
    progress: 92,
    nextAction: "Finalize winner selection and publish receipt.",
  },
  {
    name: "USDC Growth Vault",
    status: "open",
    pool: "4.2M USDC",
    participants: "2,108 savers",
    deadline: "Opens for lock-in tomorrow at 09:00 UTC",
    progress: 58,
    nextAction: "Monitor deposit velocity before the next lock window.",
  },
  {
    name: "BTC Reserve Round",
    status: "locking",
    pool: "980 BTC",
    participants: "1,240 savers",
    deadline: "Locks in 2 days and 4 hours",
    progress: 84,
    nextAction: "Confirm settlement checks before freeze.",
  },
];

const SERVICE_STATUS = [
  {
    name: "Smart contract",
    status: "operational",
    detail: "Latest contract hash matches the published release.",
  },
  {
    name: "Backend API",
    status: "operational",
    detail: "All critical routes responding under target latency.",
  },
  {
    name: "Indexer",
    status: "degraded",
    detail: "Lagging by 2 ledgers. Background catch-up is running.",
  },
  {
    name: "Notification relay",
    status: "watch",
    detail: "Healthy but queue depth is above the normal threshold.",
  },
];

const OPERATIONAL_NOTES = [
  {
    title: "Settlement window",
    body: "Avoid manual writes between 14:00 and 15:00 UTC while the payout job is active.",
  },
  {
    title: "Escalation rule",
    body: "Page the protocol owner if the indexer stays more than 5 ledgers behind for 10 minutes.",
  },
  {
    title: "Change hygiene",
    body: "Attach screenshots or transaction receipts for every admin parameter update.",
  },
  {
    title: "Release check",
    body: "Clear any draft governance actions after execution so the dashboard stays current.",
  },
];

const STATUS_STYLE = {
  operational: {
    label: "Operational",
    className: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    dot: "bg-emerald-400",
    icon: CheckCircle2,
  },
  degraded: {
    label: "Degraded",
    className: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
    dot: "bg-amber-400",
    icon: AlertTriangle,
  },
  watch: {
    label: "Watch",
    className: "bg-sky-500/15 text-sky-300 ring-sky-400/30",
    dot: "bg-sky-400",
    icon: Clock3,
  },
  drawing: {
    label: "Drawing",
    className: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-400/30",
    dot: "bg-fuchsia-400",
    icon: Gauge,
  },
  open: {
    label: "Open",
    className: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
    dot: "bg-emerald-400",
    icon: CheckCircle2,
  },
  locking: {
    label: "Locking",
    className: "bg-amber-500/15 text-amber-300 ring-amber-400/30",
    dot: "bg-amber-400",
    icon: Clock3,
  },
};

function StatusBadge({ status }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.watch;
  const Icon = style.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${style.className}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {style.label}
    </span>
  );
}

function MetricCard({ label, value, detail, icon: Icon }) {
  return (
    <div className="vq-glass p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
            {label}
          </p>
          <p className="mt-2 text-2xl font-bold text-vault-text">{value}</p>
          <p className="mt-1 text-sm text-vault-muted">{detail}</p>
        </div>
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/10 text-red-400">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

export default function AdminSettingsPage() {
  const { t } = useTranslation("common");
  const totals = {
    parameters: PROTOCOL_PARAMETERS.length,
    rounds: ACTIVE_ROUNDS.length,
    services: SERVICE_STATUS.length,
    notes: OPERATIONAL_NOTES.length,
  };

  return (
    <div className="space-y-6">
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="flex flex-col gap-4 rounded-3xl border border-vault-border bg-gradient-to-br from-[#2B0B0B] via-vault-surface to-vault-bg p-6 shadow-glass sm:flex-row sm:items-end sm:justify-between"
      >
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-red-300">
            {t("routes.admin.settings.kicker")}
          </p>
          <h1 className="text-3xl font-bold text-vault-text">{t("routes.admin.settings.title")}</h1>
          <p className="max-w-2xl text-sm text-vault-muted">
            {t("routes.admin.settings.subtitle")}
          </p>
          <div className="flex flex-wrap gap-2 pt-1 text-xs text-vault-muted">
            <span className="rounded-full border border-vault-border bg-vault-surface px-3 py-1.5">
              Read-only overview
            </span>
            <span className="rounded-full border border-vault-border bg-vault-surface px-3 py-1.5">
              Changes flow through governance proposals
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/app/admin/proposals" className="vq-btn-ghost inline-flex items-center gap-2">
            <Shield className="h-4 w-4" aria-hidden="true" />
            {t("routes.admin.settings.viewProposals")}
          </Link>
          <Link href="/app/admin/pools/create" className="vq-btn-primary inline-flex items-center gap-2">
            <Plus className="h-4 w-4" aria-hidden="true" />
            Create pool
          </Link>
          <Link href="/app/prizes" className="vq-btn-ghost inline-flex items-center gap-2">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
            {t("routes.admin.settings.reviewRounds")}
          </Link>
        </div>
      </motion.header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Protocol parameters"
          value={String(totals.parameters)}
          detail="Core settings currently enforced on chain and in the backend."
          icon={Settings}
        />
        <MetricCard
          label="Active rounds"
          value={String(totals.rounds)}
          detail="Open, locking, and drawing rounds currently under management."
          icon={SquareStack}
        />
        <MetricCard
          label="Service status"
          value={`${SERVICE_STATUS.filter((s) => s.status === "operational").length}/${totals.services}`}
          detail="Services currently in an operational state."
          icon={Server}
        />
        <MetricCard
          label="Operational notes"
          value={String(totals.notes)}
          detail="Current reminders, escalation rules, and release hygiene."
          icon={Shield}
        />
      </div>

      <section className="vq-glass p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-vault-text">Protocol parameters</h2>
            <p className="mt-1 text-sm text-vault-muted">
              The most important configuration knobs that define how the protocol behaves.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1.5 text-xs font-medium text-vault-muted">
            <Gauge className="h-3.5 w-3.5" aria-hidden="true" />
            Governance-controlled
          </span>
        </div>

        <div className="mt-5 overflow-hidden rounded-2xl border border-vault-border">
          <table className="min-w-full divide-y divide-vault-border text-left text-sm">
            <thead className="bg-vault-surface/60 text-xs uppercase tracking-wide text-vault-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Parameter</th>
                <th scope="col" className="px-4 py-3 font-medium">Current value</th>
                <th scope="col" className="px-4 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-vault-border bg-vault-bg/40">
              {PROTOCOL_PARAMETERS.map((item) => (
                <tr key={item.label} className="align-top">
                  <th scope="row" className="px-4 py-4 font-medium text-vault-text">
                    {item.label}
                  </th>
                  <td className="px-4 py-4 text-vault-text">{item.value}</td>
                  <td className="px-4 py-4 text-vault-muted">{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <section className="vq-glass p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-vault-text">Active rounds</h2>
              <p className="mt-1 text-sm text-vault-muted">
                Operational snapshot for the rounds currently being managed.
              </p>
            </div>
            <Clock3 className="h-5 w-5 text-red-400" aria-hidden="true" />
          </div>

          <div className="mt-5 space-y-4">
            {ACTIVE_ROUNDS.map((round) => (
              <article
                key={round.name}
                className="rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold text-vault-text">{round.name}</h3>
                      <StatusBadge status={round.status} />
                    </div>
                    <p className="mt-1 text-sm text-vault-muted">{round.deadline}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-vault-text">{round.pool}</p>
                    <p className="text-xs uppercase tracking-[0.24em] text-vault-muted">
                      Pool size
                    </p>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-vault-border bg-vault-bg/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-vault-muted">
                      Participants
                    </p>
                    <p className="mt-1 text-sm font-medium text-vault-text">{round.participants}</p>
                  </div>
                  <div className="rounded-xl border border-vault-border bg-vault-bg/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-vault-muted">
                      Next action
                    </p>
                    <p className="mt-1 text-sm font-medium text-vault-text">{round.nextAction}</p>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="mb-2 flex items-center justify-between text-xs text-vault-muted">
                    <span>Round progress</span>
                    <span>{round.progress}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-vault-border/40">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-red-500 to-amber-400"
                      style={{ width: `${round.progress}%` }}
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="space-y-6">
          <section className="vq-glass p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-vault-text">Service status</h2>
                <p className="mt-1 text-sm text-vault-muted">
                  Monitored services that affect protocol visibility and execution.
                </p>
              </div>
              <Server className="h-5 w-5 text-red-400" aria-hidden="true" />
            </div>

            <div className="mt-5 space-y-3">
              {SERVICE_STATUS.map((service) => (
                <div
                  key={service.name}
                  className="flex items-start justify-between gap-3 rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-1 h-2.5 w-2.5 rounded-full ${STATUS_STYLE[service.status].dot}`} />
                    <div>
                      <p className="font-medium text-vault-text">{service.name}</p>
                      <p className="mt-1 text-sm text-vault-muted">{service.detail}</p>
                    </div>
                  </div>
                  <StatusBadge status={service.status} />
                </div>
              ))}
            </div>
          </section>

          <section className="vq-glass p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-vault-text">Operational notes</h2>
                <p className="mt-1 text-sm text-vault-muted">
                  A lightweight runbook for the current protocol cycle.
                </p>
              </div>
              <CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            </div>

            <div className="mt-5 space-y-3">
              {OPERATIONAL_NOTES.map((note, index) => (
                <div
                  key={note.title}
                  className="flex items-start gap-3 rounded-2xl border border-vault-border bg-vault-surface/40 p-4"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-xs font-semibold text-red-300">
                    {index + 1}
                  </span>
                  <div>
                    <p className="font-medium text-vault-text">{note.title}</p>
                    <p className="mt-1 text-sm text-vault-muted">{note.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
