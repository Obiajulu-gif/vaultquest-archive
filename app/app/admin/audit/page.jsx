"use client";

import { useState, useEffect, useMemo } from "react";
import { useAccount } from "wagmi";
import {
  Shield, ClipboardList, Download, Search,
  ChevronLeft, ChevronRight, Filter, Clock
} from "lucide-react";
import { ADMIN_ADDRESSES } from "../admin-config";

const PAGE_SIZE = 10;

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function serializeValue(v) {
  if (v === null || v === undefined) return "-";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export default function AdminAuditPage() {
  const { address, isConnected } = useAccount();
  const [isMockConnected, setIsMockConnected] = useState(false);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(0);
  const [filterParam, setFilterParam] = useState("");
  const [filterActor, setFilterActor] = useState("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("mockConnected") === "true") setIsMockConnected(true);
    }
  }, []);

  const isAdmin =
    (isConnected && ADMIN_ADDRESSES.some(a => a.toLowerCase() === address?.toLowerCase())) ||
    isMockConnected;

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ limit: "50" });
    if (filterParam) params.set("parameter_name", filterParam);
    if (filterActor) params.set("actor", filterActor);

    fetch(`/admin/audit?${params.toString()}`, {
      headers: { authorization: "Bearer mock-admin-token" }
    })
      .then(async r => {
        if (!r.ok) throw new Error("Failed to load audit records");
        return r.json();
      })
      .then(d => { setRecords(d.data || []); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [isAdmin, filterParam, filterActor]);

  const filtered = useMemo(() => records, [records]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const slice = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const handleExport = async () => {
    try {
      const params = new URLSearchParams({ limit: "1000" });
      if (filterParam) params.set("parameter_name", filterParam);
      if (filterActor) params.set("actor", filterActor);

      const res = await fetch(`/admin/audit/export?${params.toString()}`, {
        headers: { authorization: "Bearer mock-admin-token" }
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "protocol-audit.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Export failed. Please try again.");
    }
  };

  if (!isAdmin) {
    return (
      <div className="vq-glass flex flex-col items-center px-6 py-16 text-center">
        <Shield className="h-16 w-16 text-vault-muted" />
        <h2 className="mt-6 text-xl font-semibold text-vault-text">Access Restricted</h2>
        <p className="mt-2 max-w-md text-sm text-vault-muted">
          Connect your admin wallet to view the protocol parameter change audit log.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-center gap-2">
          <ClipboardList className="h-8 w-8 text-vault-accent" />
          <h1 className="text-3xl font-bold text-vault-text">Protocol Audit Log</h1>
        </div>
        <p className="mt-2 text-vault-muted">
          Recorded changes to protocol and pool configuration parameters.
        </p>
      </header>

      <div className="vq-glass p-4 sm:p-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-param" className="text-xs font-medium text-vault-muted">
              Parameter name
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vault-muted" />
              <input
                id="filter-param"
                type="text"
                value={filterParam}
                onChange={e => { setFilterParam(e.target.value); setPage(0); }}
                placeholder="e.g. fee_rate"
                className="rounded-lg border border-vault-border bg-vault-bg pl-9 pr-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-vault-accent w-48"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-actor" className="text-xs font-medium text-vault-muted">
              Actor
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vault-muted" />
              <input
                id="filter-actor"
                type="text"
                value={filterActor}
                onChange={e => { setFilterActor(e.target.value); setPage(0); }}
                placeholder="Wallet address"
                className="rounded-lg border border-vault-border bg-vault-bg pl-9 pr-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-vault-accent w-48"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-2 rounded-xl bg-vault-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            <Download className="h-4 w-4" /> Export CSV
          </button>
        </div>
      </div>

      {loading ? (
        <div className="vq-glass p-8 text-center">
          <p className="text-sm text-vault-muted">Loading audit records...</p>
        </div>
      ) : error ? (
        <div className="vq-glass p-8 text-center">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="vq-glass flex flex-col items-center px-6 py-16 text-center">
          <Clock className="h-12 w-12 text-vault-muted" />
          <h2 className="mt-4 text-lg font-semibold text-vault-text">No audit records found</h2>
          <p className="mt-1 text-sm text-vault-muted">
            {filterParam || filterActor
              ? "Try adjusting your filters."
              : "No parameter changes have been recorded yet."}
          </p>
        </div>
      ) : (
        <div className="vq-glass overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-vault-border/60 text-vault-muted">
                  <th className="p-4 font-medium">Date</th>
                  <th className="p-4 font-medium">Parameter</th>
                  <th className="p-4 font-medium">Previous Value</th>
                  <th className="p-4 font-medium">New Value</th>
                  <th className="p-4 font-medium">Actor</th>
                  <th className="p-4 font-medium">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {slice.map(r => (
                  <tr key={r.id} className="border-b border-vault-border/40">
                    <td className="p-4 text-vault-text whitespace-nowrap">{formatDate(r.created_at)}</td>
                    <td className="p-4">
                      <code className="rounded bg-vault-surface px-2 py-0.5 text-xs text-vault-accent">{r.parameter_name}</code>
                    </td>
                    <td className="p-4 text-vault-muted font-mono text-xs max-w-[200px] truncate" title={serializeValue(r.previous_value)}>
                      {serializeValue(r.previous_value)}
                    </td>
                    <td className="p-4 text-vault-text font-mono text-xs max-w-[200px] truncate" title={serializeValue(r.new_value)}>
                      {serializeValue(r.new_value)}
                    </td>
                    <td className="p-4 font-mono text-xs text-vault-muted">
                      {r.actor ? `${r.actor.slice(0, 6)}...${r.actor.slice(-4)}` : "-"}
                    </td>
                    <td className="p-4 font-mono text-xs text-vault-muted">
                      {r.tx_hash ? (
                        <span title={r.tx_hash}>{r.tx_hash.slice(0, 8)}...{r.tx_hash.slice(-6)}</span>
                      ) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-vault-border/70 p-4">
              <button
                type="button"
                disabled={safePage === 0}
                onClick={() => setPage(p => Math.max(0, p - 1))}
                className="vq-btn-ghost disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" /> Prev
              </button>
              <span className="text-sm text-vault-muted">Page {safePage + 1} of {pageCount}</span>
              <button
                type="button"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                className="vq-btn-ghost disabled:opacity-40"
              >
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
