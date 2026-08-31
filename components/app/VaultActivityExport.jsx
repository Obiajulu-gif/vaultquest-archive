"use client";

import { useState, useRef } from "react";
import { Download, CheckCircle2, AlertCircle, Loader2, XCircle } from "lucide-react";

/**
 * VaultActivityExport — pagination-safe export of vault activity records.
 *
 * Pages through `GET /actions?wallet=...&limit=...&cursor=...` (cursor-based
 * pagination, see backend/src/routes/actions.ts) instead of loading the entire
 * history in one response, and streams each page's rows into the CSV/JSON
 * output as it arrives. Multi-page exports show a progress indicator and a
 * cancel button that aborts the in-flight requests.
 *
 * Props:
 *   wallet      Wallet address whose activity is exported (required)
 *   filename    Base filename without extension (default "vault-activity")
 *   pageSize    Rows fetched per page (default 100; backend caps at 100)
 *   fetchImpl   fetch implementation override (defaults to global fetch; for tests)
 *   apiBase     API base URL override (defaults to NEXT_PUBLIC_VAULTQUEST_API_BASE_URL or "/api")
 */

const API_BASE = process.env.NEXT_PUBLIC_VAULTQUEST_API_BASE_URL || "/api";

const FIELDS = [
  "id",
  "date",
  "action_type",
  "pool_id",
  "asset",
  "amount",
  "status",
  "tx_hash",
  "error_code",
  "submitted_at",
  "confirmed_at",
];

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Mirrors the backend /actions/export clean-record mapping. */
function mapRecord(row) {
  const payload = row.action_payload ?? {};
  return {
    id: row.id ?? "",
    date: row.created_at ?? "",
    action_type: row.action_type ?? "",
    pool_id: String(payload.vault_id ?? payload.pool_id ?? ""),
    asset: String(payload.token ?? payload.asset ?? ""),
    amount: String(payload.amount ?? ""),
    status: row.status ?? "",
    tx_hash: row.tx_hash ?? "",
    error_code: row.error_code ?? "",
    submitted_at: row.submitted_at ?? "",
    confirmed_at: row.confirmed_at ?? "",
  };
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function VaultActivityExport({
  wallet,
  filename = "vault-activity",
  pageSize = 100,
  fetchImpl = typeof globalThis !== "undefined" ? globalThis.fetch?.bind(globalThis) : null,
  apiBase = API_BASE,
}) {
  const [format, setFormat] = useState("csv");
  const [status, setStatus] = useState("idle"); // idle | exporting | success | error | cancelled
  const [errorMsg, setErrorMsg] = useState("");
  const [progress, setProgress] = useState({ rows: 0, pages: 0 });
  const abortRef = useRef(null);

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleExport = async () => {
    if (!wallet) {
      setStatus("error");
      setErrorMsg("A wallet address is required to export activity.");
      return;
    }
    if (!fetchImpl) {
      setStatus("error");
      setErrorMsg("Export is unavailable in this environment.");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("exporting");
    setErrorMsg("");
    setProgress({ rows: 0, pages: 0 });

    try {
      let cursor = null;
      let rowsTotal = 0;
      let pages = 0;

      // CSV is built incrementally — rows are appended as each page arrives,
      // so the full history is never materialized in a single response. JSON
      // accumulates records (inherent to the format) but still pages through
      // the API rather than fetching everything at once.
      let csv = format === "csv" ? FIELDS.join(",") + "\r\n" : null;
      const records = [];

      do {
        const params = new URLSearchParams({ wallet, limit: String(pageSize) });
        if (cursor) params.set("cursor", cursor);

        const res = await fetchImpl(`${apiBase}/actions?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`Export failed (HTTP ${res.status})`);
        }
        const body = await res.json();
        const items = Array.isArray(body?.data) ? body.data : [];
        const nextCursor = body?.meta?.pagination?.next_cursor ?? null;

        for (const row of items) {
          const record = mapRecord(row);
          if (format === "csv") {
            csv += FIELDS.map((f) => csvEscape(record[f])).join(",") + "\r\n";
          } else {
            records.push(record);
          }
          rowsTotal += 1;
        }
        pages += 1;
        setProgress({ rows: rowsTotal, pages });

        if (!nextCursor) break;
        cursor = nextCursor;
      } while (true);

      if (format === "csv") {
        download(csv, `${filename}.csv`, "text/csv");
      } else {
        download(JSON.stringify(records, null, 2), `${filename}.json`, "application/json");
      }
      setStatus("success");
    } catch (err) {
      if (controller.signal.aborted || err?.name === "AbortError") {
        setStatus("cancelled");
      } else {
        setStatus("error");
        setErrorMsg(err?.message || "Export failed. Please try again.");
      }
    }
  };

  const exporting = status === "exporting";

  return (
    <div className="rounded-2xl border border-vault-border bg-vault-surface/60 p-5">
      <h3 className="text-sm font-semibold text-vault-text">Export activity</h3>
      <p className="mt-1 text-xs text-vault-muted">
        Download your vault history including action type, date, and amount.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="vae-format" className="text-xs font-medium text-vault-muted">
            Format
          </label>
          <select
            id="vae-format"
            value={format}
            onChange={(e) => { setFormat(e.target.value); setStatus("idle"); }}
            disabled={exporting}
            className="rounded-lg border border-vault-border bg-vault-bg px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-vault-accent disabled:opacity-50"
          >
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex items-center gap-2 rounded-xl bg-vault-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="h-4 w-4" aria-hidden="true" />
          )}
          {exporting ? "Exporting…" : "Export"}
        </button>

        {exporting && (
          <>
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-2 rounded-xl border border-vault-border px-4 py-2 text-sm font-semibold text-vault-muted transition-colors hover:bg-vault-surface hover:text-vault-text"
            >
              <XCircle className="h-4 w-4" aria-hidden="true" />
              Cancel
            </button>
            <div className="flex flex-col gap-1" role="status" aria-live="polite">
              <span className="text-xs text-vault-muted">
                Exporting… <span className="font-mono text-vault-text">{progress.rows}</span> rows
                across <span className="font-mono text-vault-text">{progress.pages}</span> page{progress.pages === 1 ? "" : "s"}
              </span>
              <div className="h-1.5 w-40 overflow-hidden rounded-full bg-vault-border/50">
                <div
                  className="h-full rounded-full bg-vault-accent transition-all duration-300"
                  style={{ width: progress.rows > 0 ? "100%" : "0%" }}
                />
              </div>
            </div>
          </>
        )}
      </div>

      {status === "success" && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Downloaded <span className="font-mono">{filename}.{format}</span> successfully ({progress.rows} rows).</span>
        </div>
      )}

      {status === "cancelled" && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-400">
          <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Export cancelled after {progress.rows} rows.</span>
        </div>
      )}

      {status === "error" && (
        <div role="alert" className="mt-3 flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
}
