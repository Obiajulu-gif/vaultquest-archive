import type { FC } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

/**
 * Transaction timeline component (#63).
 *
 * Reusable visual progress tracker for any flow that crosses the wallet →
 * network → indexer → UI boundary (create, join, drip, claim, withdraw…).
 *
 * Stages map to the typical lifecycle of a Soroban transaction:
 *
 *  1. **preparing**         — building the transaction in JS
 *  2. **awaiting-signature** — wallet popup is open, waiting on user
 *  3. **submitting**         — broadcast to Stellar RPC
 *  4. **confirming**         — waiting for ledger inclusion
 *  5. **indexing**           — backend/indexer catching up
 *  6. **success** / **failed**
 *
 * The component is fully controlled — the parent picks the current stage and
 * optionally the failed stage so the timeline can highlight where the failure
 * occurred. Retry buttons appear only when the parent provides `onRetry`.
 */

export type TimelineStage =
  | "preparing"
  | "awaiting-signature"
  | "submitting"
  | "confirming"
  | "indexing"
  | "success"
  | "failed";

interface StageMeta {
  id: TimelineStage;
  label: string;
  description: string;
}

const STAGES: StageMeta[] = [
  { id: "preparing", label: "Preparing", description: "Building the transaction" },
  { id: "awaiting-signature", label: "Awaiting signature", description: "Approve in your wallet" },
  { id: "submitting", label: "Submitting", description: "Broadcasting to Stellar" },
  { id: "confirming", label: "Confirming", description: "Waiting for ledger inclusion" },
  { id: "indexing", label: "Indexing", description: "Updating app state" },
  { id: "success", label: "Complete", description: "Transaction confirmed" },
];

const STAGE_ORDER: Record<TimelineStage, number> = {
  preparing: 0,
  "awaiting-signature": 1,
  submitting: 2,
  confirming: 3,
  indexing: 4,
  success: 5,
  failed: -1,
};

export interface TransactionTimelineProps {
  /** Current stage of the flow. */
  stage: TimelineStage;
  /** When `stage` is "failed", the stage where it failed (used to highlight the row). */
  failedAtStage?: Exclude<TimelineStage, "success" | "failed">;
  /** Transaction hash (shown with an Explorer link once `submitting` or later). */
  txHash?: string;
  /** Builder for the explorer link from a tx hash. */
  explorerUrl?: (txHash: string) => string;
  /** Human-readable error message rendered when `stage === "failed"`. */
  errorMessage?: string;
  /** Optional retry callback rendered when the flow has failed or stalled. */
  onRetry?: () => void;
  /** Optional dismiss/cancel callback. */
  onDismiss?: () => void;
  className?: string;
}

function rowState(
  stage: TimelineStage,
  rowId: TimelineStage,
  failedAtStage?: TransactionTimelineProps["failedAtStage"],
): "complete" | "active" | "pending" | "failed" {
  // #1133 — every row is done on success, and rows before the failed one are
  // done on failure; each row's state is announced, so it must be accurate.
  if (stage === "success") return "complete";
  if (stage === "failed") {
    if (failedAtStage === rowId) return "failed";
    return failedAtStage && STAGE_ORDER[rowId] < STAGE_ORDER[failedAtStage] ? "complete" : "pending";
  }
  const current = STAGE_ORDER[stage];
  const row = STAGE_ORDER[rowId];
  if (row < current) return "complete";
  if (row === current) return "active";
  return "pending";
}

/** Screen-reader text for each row; the icons and colours are aria-hidden. */
const ROW_STATE_TEXT = {
  complete: "completed",
  active: "in progress",
  pending: "not started",
  failed: "failed",
} as const;

interface StageRowProps {
  meta: StageMeta;
  state: "complete" | "active" | "pending" | "failed";
  isLast: boolean;
}

const StageRow: FC<StageRowProps> = ({ meta, state, isLast }) => {
  const styles = {
    complete: {
      icon: <Check className="h-4 w-4" aria-hidden="true" />,
      iconBg: "bg-green-600 text-white",
      label: "text-green-300",
      line: "bg-green-600/60",
    },
    active: {
      icon: <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />,
      iconBg: "bg-red-600 text-white",
      label: "text-white",
      line: "bg-red-900/40",
    },
    pending: {
      icon: <span className="h-2 w-2 rounded-full bg-gray-500" aria-hidden="true" />,
      iconBg: "bg-gray-800 text-gray-500 border border-gray-700",
      label: "text-gray-500",
      line: "bg-gray-800",
    },
    failed: {
      icon: <X className="h-4 w-4" aria-hidden="true" />,
      iconBg: "bg-red-700 text-white",
      label: "text-red-300",
      line: "bg-red-900/40",
    },
  }[state];

  return (
    <li className="relative flex gap-4 pb-6 last:pb-0" aria-current={state === "active" ? "step" : undefined}>
      {!isLast && (
        <span
          aria-hidden="true"
          className={`absolute left-3.5 top-7 h-full w-px ${styles.line}`}
        />
      )}
      <span
        aria-hidden="true"
        className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${styles.iconBg}`}
      >
        {styles.icon}
      </span>
      <div className="min-w-0 pt-0.5">
        <p className={`text-sm font-medium ${styles.label}`}>
          {meta.label}
          <span className="sr-only">, {ROW_STATE_TEXT[state]}</span>
        </p>
        <p className="mt-0.5 text-xs text-gray-500">{meta.description}</p>
      </div>
    </li>
  );
};

export const TransactionTimeline: FC<TransactionTimelineProps> = ({
  stage,
  failedAtStage,
  txHash,
  explorerUrl,
  errorMessage,
  onRetry,
  onDismiss,
  className = "",
}) => {
  const isFailed = stage === "failed";
  const isSuccess = stage === "success";
  const current = STAGES.find((s) => s.id === stage);
  const failedLabel = STAGES.find((s) => s.id === failedAtStage)?.label;
  // #1133 — announce one short sentence per change instead of re-reading the
  // whole card; failures go to an assertive alert.
  const statusText = isFailed ? "" : isSuccess ? "Transaction confirmed" : `${current?.label}: ${current?.description}`;
  const alertText = isFailed
    ? `Transaction failed${failedLabel ? ` at ${failedLabel}` : ""}.${errorMessage ? ` ${errorMessage}` : ""}`
    : "";

  return (
    <section
      aria-label={
        isFailed
          ? "Transaction failed"
          : isSuccess
            ? "Transaction completed"
            : "Transaction in progress"
      }
      className={`rounded-2xl border border-red-900/30 bg-[#1A0505]/60 p-6 ${className}`}
    >
      {/* Always rendered so assistive tech is already watching them when the text changes. */}
      <p role="status" aria-live="polite" className="sr-only">
        {statusText}
      </p>
      <p role="alert" className="sr-only">
        {alertText}
      </p>

      {/* Header */}
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-white">
            {isFailed
              ? "Transaction failed"
              : isSuccess
                ? "Transaction confirmed"
                : "Processing transaction"}
          </h2>
          {txHash && (
            <p className="mt-1 font-mono text-xs text-gray-500 break-all">
              {explorerUrl ? (
                <a
                  href={explorerUrl(txHash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-red-400 hover:text-red-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 rounded"
                >
                  {txHash.slice(0, 12)}…{txHash.slice(-8)}
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : (
                <>
                  {txHash.slice(0, 12)}…{txHash.slice(-8)}
                </>
              )}
            </p>
          )}
        </div>

        {/* Status badge */}
        {isSuccess ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-green-600/20 px-2.5 py-1 text-xs font-medium text-green-300">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Success
          </span>
        ) : isFailed ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-700/20 px-2.5 py-1 text-xs font-medium text-red-300">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
            Failed
          </span>
        ) : null}
      </header>

      {/* Stages list */}
      <ol className="ml-1">
        {STAGES.map((s, idx) => (
          <StageRow
            key={s.id}
            meta={s}
            state={rowState(stage, s.id, failedAtStage)}
            isLast={idx === STAGES.length - 1}
          />
        ))}
      </ol>

      {/* Failure detail */}
      {isFailed && errorMessage && (
        <div className="mt-4 rounded-xl border border-red-700/40 bg-red-900/20 p-4 text-sm text-red-200">
          <p className="font-semibold text-red-300">Why it failed</p>
          <p className="mt-1 leading-relaxed">{errorMessage}</p>
        </div>
      )}

      {/* Actions */}
      {(onRetry || onDismiss) && (
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-xl px-4 py-2 text-sm font-medium text-gray-400 hover:bg-white/5 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              {isSuccess ? "Done" : "Close"}
            </button>
          )}
          {onRetry && (isFailed || !isSuccess) && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
};
