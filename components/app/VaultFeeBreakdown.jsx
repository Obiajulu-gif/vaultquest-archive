"use client";

import { Info, AlertCircle, Zap, Building2, Receipt } from "lucide-react";

/**
 * VaultFeeBreakdown — displays a structured fee estimate before vault actions.
 *
 * Props:
 *   networkFee      string | null  — estimated network / gas fee (e.g. "~0.001 XLM")
 *   platformFeePct  number | null  — platform fee as a percentage (e.g. 0.5 for 0.5 %)
 *   amount          number | null  — action amount used to compute platform fee total
 *   currency        string         — display currency label (default "USDC")
 *   unavailable     boolean        — show the "fee data unavailable" state
 */
export default function VaultFeeBreakdown({
  networkFee = null,
  platformFeePct = null,
  amount = null,
  currency = "USDC",
  unavailable = false,
}) {
  const platformFeeTotal =
    platformFeePct != null && amount != null
      ? ((amount * platformFeePct) / 100).toFixed(4)
      : null;

  const hasAnyFee = networkFee != null || platformFeeTotal != null;

  const rows = [
    {
      Icon: Zap,
      label: "Estimated network fee",
      value: networkFee ?? "—",
      sub: "Paid to Stellar validators",
    },
    {
      Icon: Building2,
      label: `Platform fee${platformFeePct != null ? ` (${platformFeePct}%)` : ""}`,
      value:
        platformFeeTotal != null
          ? `${platformFeeTotal} ${currency}`
          : platformFeePct != null
          ? "Enter amount to estimate"
          : "—",
      sub: "Retained by VaultQuest protocol",
    },
  ];

  return (
    <div className="rounded-2xl border border-vault-border bg-vault-surface/60 p-5 backdrop-blur-md">
      <div className="flex items-center gap-2 mb-4">
        <Receipt className="h-4 w-4 text-vault-accent" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-vault-text">Fee breakdown</h3>
        <span title="Fees are estimates and may vary at confirmation time.">
          <Info className="h-3.5 w-3.5 text-vault-muted" aria-hidden="true" />
        </span>
      </div>

      {unavailable ? (
        <div className="flex items-start gap-3 rounded-xl border border-vault-border bg-vault-bg/40 px-4 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-vault-muted" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-vault-text">Fee data unavailable</p>
            <p className="mt-0.5 text-xs text-vault-muted">
              Estimated fees couldn&apos;t be loaded right now. You can still proceed — actual fees will be shown in your wallet before you sign.
            </p>
          </div>
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {rows.map(({ Icon, label, value, sub }) => (
              <li
                key={label}
                className="flex items-start justify-between gap-4 rounded-xl border border-vault-border bg-vault-bg/30 px-4 py-3"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-vault-muted" aria-hidden="true" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-vault-text">{label}</p>
                    <p className="text-xs text-vault-muted">{sub}</p>
                  </div>
                </div>
                <span className="shrink-0 text-sm font-semibold text-vault-text tabular-nums">
                  {value}
                </span>
              </li>
            ))}
          </ul>

          {hasAnyFee && (
            <div className="mt-4 flex items-center justify-between border-t border-vault-border pt-4">
              <p className="text-sm font-semibold text-vault-text">Total estimated fees</p>
              <p className="text-sm font-bold text-vault-accent tabular-nums">
                {networkFee && platformFeeTotal
                  ? `${platformFeeTotal} ${currency} + ${networkFee}`
                  : platformFeeTotal
                  ? `${platformFeeTotal} ${currency}`
                  : networkFee ?? "—"}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
