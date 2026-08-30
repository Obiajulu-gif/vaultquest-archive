"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Archive,
  CalendarDays,
  ChevronLeft,
  Download,
  FileJson,
  FileSpreadsheet,
  ShieldCheck,
  Trophy,
  Users,
} from "lucide-react";
import { VAULT_ROUND_ARCHIVE } from "@/lib/vault-mock-data";
import {
  archiveToCSV,
  archiveToJSON,
  createArchiveExport,
  filterArchiveRecords,
  summarizeArchive,
} from "@/lib/archive-export";
import type { ArchiveRecord } from "@/lib/archive-export";

const PAGE_SIZE = 3;
const NETWORKS = [...new Set(VAULT_ROUND_ARCHIVE.map((round) => round.network))];

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

function ClaimStatusBadge({ status, claimStatus }) {
  const meta = {
    claimed: { label: "Claims settled", className: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" },
    partially_claimed: { label: "Partially claimed", className: "border-amber-400/30 bg-amber-500/10 text-amber-300" },
    expired: { label: "Claims expired", className: "border-vault-border bg-vault-surface text-vault-muted" },
  }[claimStatus] ?? { label: status, className: "border-vault-border bg-vault-surface text-vault-muted" };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.className}`}>
      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function VaultRoundArchivePage() {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [format, setFormat] = useState("csv");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [network, setNetwork] = useState("all");
  const [exportNote, setExportNote] = useState("");

  const completedRounds = useMemo(
    () =>
      [...VAULT_ROUND_ARCHIVE].sort(
        (a, b) => new Date(b.endDate).getTime() - new Date(a.endDate).getTime(),
      ),
    [],
  );

  const filters = useMemo(
    () => ({
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      network: network === "all" ? undefined : network,
    }),
    [fromDate, toDate, network],
  );

  const exportedDocument = useMemo(
    () => createArchiveExport(completedRounds, { source: "vaultquest.archive.mock" }),
    [completedRounds],
  );

  const filteredRecords = useMemo(
    () => filterArchiveRecords(exportedDocument.records, filters),
    [exportedDocument.records, filters],
  );

  const visibleRounds = filteredRecords.slice(0, visibleCount);
  const hasMore = visibleCount < filteredRecords.length;

  const totals = useMemo(() => summarizeArchive(filteredRecords), [filteredRecords]);

  const handleExport = () => {
    const content =
      format === "json" ? archiveToJSON(exportedDocument) : archiveToCSV(exportedDocument.records);
    const extension = format === "json" ? "json" : "csv";
    downloadFile(
      `vaultquest-round-archive-${new Date().toISOString().slice(0, 10)}.${extension}`,
      content,
      format === "json" ? "application/json" : "text/csv",
    );
    setExportNote(
      format === "json"
        ? `Exported ${exportedDocument.records.length} rounds as JSON · proof ${exportedDocument.proofHash}`
        : `Exported ${exportedDocument.records.length} rounds as CSV · proof ${exportedDocument.proofHash}`,
    );
  };

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
            Review closed vault rounds, dates, participation, deposits, and prize outcomes, or export the archive.
          </p>
        </div>
        <Link href="/app/vaults" className="vq-btn-ghost self-start">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back to vaults
        </Link>
      </div>

      <section className="vq-glass p-4 sm:p-6" aria-labelledby="archive-export-title">
        <div>
          <h2 id="archive-export-title" className="flex items-center gap-2 text-base font-semibold text-vault-text">
            {format === "csv" ? <FileSpreadsheet className="h-5 w-5 text-emerald-500" aria-hidden="true" /> : <FileJson className="h-5 w-5 text-amber-500" aria-hidden="true" />}
            Export archive data
          </h2>
          <p className="mt-1 text-sm text-vault-muted">
            Download every completed round as deterministic CSV or JSON, including eligible deposits, winners, claim status and a proof hash.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="archive-from" className="text-xs font-medium text-vault-muted">From</label>
            <input id="archive-from" type="date" value={fromDate} onChange={(e) => { setFromDate(e.target.value); setVisibleCount(PAGE_SIZE); }}
              className="rounded-lg border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="archive-to" className="text-xs font-medium text-vault-muted">To</label>
            <input id="archive-to" type="date" value={toDate} onChange={(e) => { setToDate(e.target.value); setVisibleCount(PAGE_SIZE); }}
              className="rounded-lg border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500" />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="archive-network" className="text-xs font-medium text-vault-muted">Network</label>
            <select id="archive-network" value={network} onChange={(e) => { setNetwork(e.target.value); setVisibleCount(PAGE_SIZE); }}
              className="rounded-lg border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500">
              <option value="all">All networks</option>
              {NETWORKS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="archive-format" className="text-xs font-medium text-vault-muted">Format</label>
            <select id="archive-format" value={format} onChange={(e) => setFormat(e.target.value)}
              className="rounded-lg border border-vault-border bg-vault-surface px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-red-500">
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </div>
          <button type="button" onClick={handleExport} className="vq-btn-primary">
            <Download className="h-4 w-4" aria-hidden="true" />
            Export {filteredRecords.length} round{filteredRecords.length === 1 ? "" : "s"}
          </button>
        </div>
        {exportNote && (
          <p role="status" className="mt-3 inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
            <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
            {exportNote}
          </p>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Archive summary metrics">
        <SummaryMetric icon={Users} label="Participants" value={totals.participants.toLocaleString("en-US")} />
        <SummaryMetric icon={Archive} label="Eligible deposits" value={formatCurrency(totals.eligibleDeposits)} />
        <SummaryMetric icon={Trophy} label="Prizes paid" value={formatCurrency(totals.prizesPaid)} />
        <SummaryMetric icon={Trophy} label="Winners" value={totals.winners.toLocaleString("en-US")} />
      </section>

      {filteredRecords.length === 0 ? (
        <section className="vq-glass flex flex-col items-center px-6 py-16 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-vault-border bg-vault-surface text-vault-muted">
            <Archive className="h-8 w-8" aria-hidden="true" />
          </span>
          <h2 className="mt-6 text-xl font-semibold text-vault-text">No rounds match your filters</h2>
          <p className="mt-2 max-w-md text-sm text-vault-muted">
            Adjust the date range or network filter to see completed rounds again.
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
                    <ClaimStatusBadge claimStatus={round.claimStatus} status={round.claimStatus} />
                  </div>
                  <p className="mt-2 flex items-center gap-2 text-sm text-vault-muted">
                    <CalendarDays className="h-4 w-4" aria-hidden="true" />
                    {formatDate(round.startDate)} to {formatDate(round.endDate)}
                  </p>
                  <p className="mt-1 font-mono text-xs text-vault-muted">
                    proof {round.proofHash}
                  </p>
                </div>
                <Link href={`/app/vaults/${round.vaultId}`} className="vq-btn-ghost self-start py-1.5">
                  View vault
                </Link>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <SummaryMetric icon={Users} label="Participants" value={round.participants.toLocaleString("en-US")} />
                <SummaryMetric icon={Archive} label="Eligible deposits" value={formatCurrency(round.eligibleDeposits)} />
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
                All rounds shown
              </p>
            )}
            <p className="text-xs text-vault-muted">
              Showing {visibleRounds.length} of {filteredRecords.length} matched rounds
            </p>
          </div>
        </section>
      )}
    </div>
  );
}