"use client";
import { useState, useEffect, useCallback } from "react";

const SEVERITY_COLORS = {
  low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  medium: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  high: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  critical: "bg-red-500/10 text-red-400 border-red-500/20",
};

const STATE_COLORS = {
  unresolved: "bg-red-500/10 text-red-400",
  retryable: "bg-yellow-500/10 text-yellow-400",
  resolved: "bg-green-500/10 text-green-400",
  ignored: "bg-gray-500/10 text-gray-400",
};

const OPERATION_TYPE_LABELS = {
  background_job: "Background Job",
  external_call: "External Call",
  on_chain: "On-Chain",
  wallet_flow: "Wallet Flow",
};

function Badge({ className, children }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${className}`}
    >
      {children}
    </span>
  );
}

function SummaryCard({ label, value, sub }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-1">
      <span className="text-xs text-vault-muted uppercase tracking-wider">{label}</span>
      <span className="text-2xl font-bold text-white">{value ?? "—"}</span>
      {sub && <span className="text-xs text-vault-muted">{sub}</span>}
    </div>
  );
}

export default function PartialFailureDashboardPage() {
  const [summary, setSummary] = useState(null);
  const [failures, setFailures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [filterState, setFilterState] = useState("");
  const [filterType, setFilterType] = useState("");
  const [filterSeverity, setFilterSeverity] = useState("");
  const [filterRetryable, setFilterRetryable] = useState("");
  const [selected, setSelected] = useState(null);
  const [actionNote, setActionNote] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch("/admin/partial-failures/summary");
      if (res.ok) setSummary(await res.json().then((d) => d.data));
    } catch { /* non-fatal */ }
  }, []);

  const loadFailures = useCallback(
    async (reset = false) => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ limit: "20" });
        if (filterState) params.set("state", filterState);
        if (filterType) params.set("operation_type", filterType);
        if (filterSeverity) params.set("severity", filterSeverity);
        if (filterRetryable) params.set("retryable", filterRetryable);
        if (!reset && cursor) params.set("cursor", cursor);

        const res = await fetch(`/admin/partial-failures?${params}`);
        if (!res.ok) throw new Error(await res.text());
        const body = await res.json();
        setFailures((prev) => (reset ? body.data : [...prev, ...body.data]));
        setHasMore(body.meta?.pagination?.has_more ?? false);
        setCursor(body.meta?.pagination?.next_cursor ?? null);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [filterState, filterType, filterSeverity, filterRetryable, cursor],
  );

  useEffect(() => {
    loadSummary();
    setCursor(null);
    loadFailures(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterState, filterType, filterSeverity, filterRetryable]);

  const doAction = useCallback(
    async (id, action, body) => {
      setActionLoading(true);
      setError("");
      try {
        const res = await fetch(`/admin/partial-failures/${id}/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await res.text());
        setSelected(null);
        setActionNote("");
        loadSummary();
        loadFailures(true);
      } catch (e) {
        setError(e.message);
      } finally {
        setActionLoading(false);
      }
    },
    [loadSummary, loadFailures],
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-white">
      <div className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-white to-indigo-300 bg-clip-text text-transparent">
            Partial Failure Dashboard
          </h1>
          <p className="text-vault-muted mt-1">
            Operations stuck between internal state and external systems.
          </p>
        </div>

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <SummaryCard label="Total Unresolved" value={summary.total} />
            <SummaryCard label="Retryable" value={summary.retryable_count} />
            <SummaryCard label="Stale" value={summary.stale_count} sub="No update since detection" />
            <SummaryCard
              label="Critical"
              value={summary.by_severity?.critical ?? 0}
              sub="Immediate attention required"
            />
          </div>
        )}

        {/* By Type / Severity Mini-table */}
        {summary && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <h3 className="text-sm font-semibold text-vault-muted mb-3 uppercase tracking-wider">By Operation Type</h3>
              {Object.entries(summary.by_operation_type ?? {}).map(([k, v]) => (
                <div key={k} className="flex justify-between text-sm py-1 border-b border-white/5 last:border-0">
                  <span className="text-gray-300">{OPERATION_TYPE_LABELS[k] ?? k}</span>
                  <span className="font-semibold">{v}</span>
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <h3 className="text-sm font-semibold text-vault-muted mb-3 uppercase tracking-wider">By Severity</h3>
              {Object.entries(summary.by_severity ?? {}).map(([k, v]) => (
                <div key={k} className="flex justify-between text-sm py-1 border-b border-white/5 last:border-0">
                  <Badge className={SEVERITY_COLORS[k] ?? ""}>{k}</Badge>
                  <span className="font-semibold">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 items-center">
          <select
            id="pf-filter-state"
            value={filterState}
            onChange={(e) => setFilterState(e.target.value)}
            className="bg-white/10 border border-white/15 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">All States</option>
            <option value="unresolved">Unresolved</option>
            <option value="retryable">Retryable</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
          </select>

          <select
            id="pf-filter-type"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="bg-white/10 border border-white/15 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">All Types</option>
            <option value="background_job">Background Job</option>
            <option value="external_call">External Call</option>
            <option value="on_chain">On-Chain</option>
            <option value="wallet_flow">Wallet Flow</option>
          </select>

          <select
            id="pf-filter-severity"
            value={filterSeverity}
            onChange={(e) => setFilterSeverity(e.target.value)}
            className="bg-white/10 border border-white/15 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <select
            id="pf-filter-retryable"
            value={filterRetryable}
            onChange={(e) => setFilterRetryable(e.target.value)}
            className="bg-white/10 border border-white/15 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">Retryable: any</option>
            <option value="true">Retryable: yes</option>
            <option value="false">Retryable: no</option>
          </select>

          <button
            id="pf-refresh-btn"
            onClick={() => { setCursor(null); loadFailures(true); loadSummary(); }}
            className="vq-btn-ghost px-4 py-2 text-sm"
          >
            ↻ Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Table */}
        <div className="rounded-xl border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-vault-muted uppercase text-xs tracking-wider">
              <tr>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Operation ID</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-left">Severity</th>
                <th className="px-4 py-3 text-left">State</th>
                <th className="px-4 py-3 text-left">Detected</th>
                <th className="px-4 py-3 text-left">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {loading && failures.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-vault-muted">
                    Loading…
                  </td>
                </tr>
              ) : failures.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-vault-muted">
                    No partial failures found. 🎉
                  </td>
                </tr>
              ) : (
                failures.map((f) => (
                  <tr
                    key={f.id}
                    className="hover:bg-white/5 transition-colors cursor-pointer"
                    onClick={() => setSelected(f)}
                  >
                    <td className="px-4 py-3">
                      <span className="text-gray-400">{OPERATION_TYPE_LABELS[f.operation_type] ?? f.operation_type}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-300 max-w-[120px] truncate">
                      {f.operation_id}
                    </td>
                    <td className="px-4 py-3 text-gray-300 max-w-[240px] truncate">{f.description}</td>
                    <td className="px-4 py-3">
                      <Badge className={SEVERITY_COLORS[f.severity] ?? ""}>{f.severity}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge className={STATE_COLORS[f.state] ?? ""}>{f.state}</Badge>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {new Date(f.detected_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                        {f.retryable && f.state !== "resolved" && f.state !== "ignored" && (
                          <button
                            id={`pf-retry-${f.id}`}
                            onClick={() => doAction(f.id, "retry", { outcome: "still_failing" })}
                            disabled={actionLoading}
                            className="vq-btn-ghost text-xs px-2 py-1"
                          >
                            Retry
                          </button>
                        )}
                        {f.state !== "resolved" && f.state !== "ignored" && (
                          <>
                            <button
                              id={`pf-resolve-${f.id}`}
                              onClick={() => setSelected({ ...f, _action: "resolve" })}
                              className="vq-btn-ghost text-xs px-2 py-1 text-green-400"
                            >
                              Resolve
                            </button>
                            <button
                              id={`pf-ignore-${f.id}`}
                              onClick={() => setSelected({ ...f, _action: "ignore" })}
                              className="vq-btn-ghost text-xs px-2 py-1 text-gray-400"
                            >
                              Ignore
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {hasMore && (
          <div className="text-center">
            <button
              id="pf-load-more-btn"
              onClick={() => loadFailures(false)}
              disabled={loading}
              className="vq-btn-ghost px-6 py-2"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}

        {/* Detail / Action Modal */}
        {selected && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="bg-slate-900 border border-white/15 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-semibold">
                    {selected._action
                      ? `${selected._action === "resolve" ? "Resolve" : "Ignore"} Failure`
                      : "Partial Failure Detail"}
                  </h2>
                  <p className="text-xs text-vault-muted font-mono mt-0.5">{selected.id}</p>
                </div>
                <button id="pf-modal-close" onClick={() => setSelected(null)} className="text-gray-500 hover:text-white text-lg leading-none">✕</button>
              </div>

              {!selected._action && (
                <div className="space-y-2 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-vault-muted">Type</span>
                      <p>{OPERATION_TYPE_LABELS[selected.operation_type] ?? selected.operation_type}</p>
                    </div>
                    <div>
                      <span className="text-vault-muted">Operation ID</span>
                      <p className="font-mono text-xs break-all">{selected.operation_id}</p>
                    </div>
                    <div>
                      <span className="text-vault-muted">Severity</span>
                      <p><Badge className={SEVERITY_COLORS[selected.severity] ?? ""}>{selected.severity}</Badge></p>
                    </div>
                    <div>
                      <span className="text-vault-muted">State</span>
                      <p><Badge className={STATE_COLORS[selected.state] ?? ""}>{selected.state}</Badge></p>
                    </div>
                    {selected.external_ref && (
                      <div className="col-span-2">
                        <span className="text-vault-muted">External Ref</span>
                        <p className="font-mono text-xs break-all">{selected.external_ref}</p>
                      </div>
                    )}
                  </div>
                  <div>
                    <span className="text-vault-muted">Description</span>
                    <p className="text-gray-200">{selected.description}</p>
                  </div>
                  {selected.metadata && (
                    <div>
                      <span className="text-vault-muted">Metadata</span>
                      <pre className="text-xs bg-black/30 rounded p-2 overflow-auto max-h-32 mt-1">
                        {JSON.stringify(selected.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                  {selected.resolution_note && (
                    <div>
                      <span className="text-vault-muted">Resolution Note</span>
                      <p>{selected.resolution_note}</p>
                    </div>
                  )}
                </div>
              )}

              {selected._action && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-300">
                    {selected._action === "resolve"
                      ? "Document how this failure was resolved. This is required and will be stored in the audit trail."
                      : "Provide a reason for ignoring this failure. It will be recorded in the audit trail."}
                  </p>
                  <textarea
                    id="pf-action-note"
                    value={actionNote}
                    onChange={(e) => setActionNote(e.target.value)}
                    placeholder={selected._action === "resolve" ? "Resolution note…" : "Reason for ignoring…"}
                    rows={4}
                    className="w-full rounded-lg bg-white/5 border border-white/15 px-3 py-2 text-sm text-white resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
                  />
                </div>
              )}

              {error && (
                <p className="text-xs text-red-400">{error}</p>
              )}

              <div className="flex gap-3 pt-2 justify-end">
                <button id="pf-modal-cancel" onClick={() => { setSelected(null); setActionNote(""); }} className="vq-btn-ghost px-4 py-2 text-sm">
                  Cancel
                </button>
                {selected._action && (
                  <button
                    id={`pf-modal-${selected._action}`}
                    disabled={actionLoading || actionNote.trim().length < 5}
                    onClick={() => doAction(
                      selected.id,
                      selected._action,
                      selected._action === "resolve"
                        ? { resolution_note: actionNote }
                        : { reason: actionNote },
                    )}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 ${
                      selected._action === "resolve"
                        ? "bg-green-600 hover:bg-green-500 text-white"
                        : "bg-gray-600 hover:bg-gray-500 text-white"
                    }`}
                  >
                    {actionLoading ? "…" : selected._action === "resolve" ? "Mark Resolved" : "Mark Ignored"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
