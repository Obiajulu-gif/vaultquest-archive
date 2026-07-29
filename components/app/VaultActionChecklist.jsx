"use client";

import { useState } from "react";
import { CheckSquare, Square, AlertTriangle, Receipt, Wallet, Info } from "lucide-react";

/**
 * VaultActionChecklist — pre-confirmation checklist for major vault actions.
 *
 * Forces users to acknowledge key details before submitting a transaction.
 *
 * Props:
 *   action        string  — human-readable action label (e.g. "Withdraw 500 USDC")
 *   balanceBefore string  — wallet balance before the action
 *   balanceAfter  string  — estimated wallet balance after the action
 *   feeEstimate   string  — fee estimate string (e.g. "~0.001 XLM"), or null
 *   onConfirm     fn      — called when all items are checked and user presses confirm
 *   onCancel      fn      — called when user cancels
 *   loading       boolean — disables the confirm button while a tx is in flight
 */

const CHECKLIST_ITEMS = [
  { id: "action", label: "I have reviewed the action summary above." },
  { id: "balance", label: "I understand the balance impact shown." },
  { id: "fees", label: "I accept the estimated fee." },
  { id: "irreversible", label: "I understand on-chain actions cannot be reversed." },
];

export default function VaultActionChecklist({
  action = "Vault action",
  balanceBefore = null,
  balanceAfter = null,
  feeEstimate = null,
  onConfirm,
  onCancel,
  loading = false,
}) {
  const [checked, setChecked] = useState(() => Object.fromEntries(CHECKLIST_ITEMS.map((i) => [i.id, false])));

  const allChecked = CHECKLIST_ITEMS.every((i) => checked[i.id]);

  function toggle(id) {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div className="vq-glass space-y-5 p-5 sm:p-6">
      {/* Action summary */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Info className="h-4 w-4 text-vault-accent" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-vault-text">Action summary</h3>
        </div>
        <div className="rounded-xl border border-vault-border bg-vault-bg/40 px-4 py-3">
          <p className="text-sm font-medium text-vault-text">{action}</p>
        </div>
      </div>

      {/* Balance impact */}
      {(balanceBefore != null || balanceAfter != null) && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Wallet className="h-4 w-4 text-vault-accent" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-vault-text">Balance impact</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-vault-border bg-vault-bg/40 px-4 py-3 text-center">
              <p className="text-xs text-vault-muted mb-1">Before</p>
              <p className="text-sm font-semibold text-vault-text tabular-nums">{balanceBefore ?? "—"}</p>
            </div>
            <div className="rounded-xl border border-vault-border bg-vault-bg/40 px-4 py-3 text-center">
              <p className="text-xs text-vault-muted mb-1">After</p>
              <p className="text-sm font-semibold text-vault-accent tabular-nums">{balanceAfter ?? "—"}</p>
            </div>
          </div>
        </div>
      )}

      {/* Fee estimate */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Receipt className="h-4 w-4 text-vault-accent" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-vault-text">Fee estimate</h3>
        </div>
        <div className="rounded-xl border border-vault-border bg-vault-bg/40 px-4 py-3 flex items-center justify-between">
          <p className="text-xs text-vault-muted">Estimated network fee</p>
          <p className="text-sm font-semibold text-vault-text tabular-nums">
            {feeEstimate ?? <span className="text-vault-muted">Unavailable</span>}
          </p>
        </div>
      </div>

      {/* Confirmation checklist */}
      <fieldset>
        <legend className="mb-3 flex items-center gap-2 text-sm font-semibold text-vault-text">
          <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
          Please confirm before submitting
        </legend>
        <ul className="space-y-2" role="list">
          {CHECKLIST_ITEMS.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-vault-border bg-vault-bg/30 px-4 py-3 transition-colors hover:bg-vault-surface/60">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked[item.id]}
                  onChange={() => toggle(item.id)}
                  aria-label={item.label}
                />
                {checked[item.id] ? (
                  <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Square className="mt-0.5 h-4 w-4 shrink-0 text-vault-muted" aria-hidden="true" />
                )}
                <span className="text-sm text-vault-text">{item.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      {/* Actions */}
      <div className="flex gap-3 pt-1">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="flex-1 rounded-xl border border-vault-border bg-vault-surface px-4 py-2.5 text-sm font-semibold text-vault-text transition-colors hover:bg-white/5 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={!allChecked || loading}
          className="flex-1 rounded-xl bg-vault-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Submitting…" : "Confirm & Submit"}
        </button>
      </div>
    </div>
  );
}
