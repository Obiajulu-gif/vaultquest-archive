"use client";

import { AlertTriangle } from "lucide-react";

/**
 * Displays data quality warnings produced by useVaultDataReview.
 * Renders nothing when there are no warnings.
 *
 * @param {{ warnings: string[] }} props
 */
export default function VaultDataWarnings({ warnings = [] }) {
  if (!warnings.length) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 p-4"
    >
      <AlertTriangle
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
        aria-hidden="true"
      />
      <div className="space-y-1">
        <p className="text-xs font-semibold text-vault-text">
          Some vault data could not be loaded
        </p>
        <ul className="space-y-0.5">
          {warnings.map((w, i) => (
            <li key={i} className="text-xs text-vault-muted">
              {w}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
