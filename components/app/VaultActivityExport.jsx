"use client";

import { useState } from "react";
import { Download, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

/**
 * VaultActivityExport — client-side export of vault activity records.
 *
 * Generates a CSV or JSON file from the provided `activities` array and
 * triggers a browser download. No API call required.
 *
 * Props:
 *   activities  Array of activity objects (required)
 *   filename    Base filename without extension (default "vault-activity")
 */

const FIELDS = ["id", "type", "pool", "asset", "amount", "date", "status"];

function toCsv(activities) {
  const header = FIELDS.join(",");
  const rows = activities.map((a) =>
    FIELDS.map((f) => {
      const v = a[f] ?? "";
      const str = String(v);
      return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(",")
  );
  return [header, ...rows].join("\r\n") + "\r\n";
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

export default function VaultActivityExport({ activities = [], filename = "vault-activity" }) {
  const [format, setFormat] = useState("csv");
  const [status, setStatus] = useState("idle"); // idle | loading | success | error
  const [errorMsg, setErrorMsg] = useState("");

  const handleExport = () => {
    if (!activities.length) {
      setStatus("error");
      setErrorMsg("No activity records to export.");
      return;
    }

    setStatus("loading");
    try {
      if (format === "csv") {
        download(toCsv(activities), `${filename}.csv`, "text/csv");
      } else {
        download(JSON.stringify(activities, null, 2), `${filename}.json`, "application/json");
      }
      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMsg("Export failed. Please try again.");
    }
  };

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
            className="rounded-lg border border-vault-border bg-vault-bg px-3 py-2 text-sm text-vault-text focus:outline-none focus:ring-2 focus:ring-vault-accent"
          >
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>

        <button
          type="button"
          onClick={handleExport}
          disabled={status === "loading"}
          className="inline-flex items-center gap-2 rounded-xl bg-vault-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "loading" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="h-4 w-4" aria-hidden="true" />
          )}
          {status === "loading" ? "Exporting…" : "Export"}
        </button>
      </div>

      {status === "success" && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Downloaded <span className="font-mono">{filename}.{format}</span> successfully.</span>
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
