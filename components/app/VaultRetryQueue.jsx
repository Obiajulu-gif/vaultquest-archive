"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  AlertCircle,
  RefreshCw,
  Trash2,
  XCircle,
  CheckCircle2,
  Clock,
  Wallet,
  Hourglass,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

// ─── Retry policy ─────────────────────────────────────────────────────────────
// Automatic retries back off exponentially (base * factor^(attempt-1), capped).
// These are deliberately small/demo-friendly; tune per environment.
export const MAX_RETRY_ATTEMPTS = 3; // total attempts before "exhausted"
export const BACKOFF_BASE_MS = 2000; // first automatic retry delay
export const BACKOFF_FACTOR = 2; // exponential multiplier between attempts
export const BACKOFF_MAX_MS = 60_000; // cap so the queue never sleeps forever
export const STATUS_RECHECK_DELAY_MS = 150; // simulated server round-trip
const SUBMIT_DELAY_MS = 800; // simulated submission round-trip
const RESOLVED_DISMISS_MS = 2500; // how long "resolved" rows stay visible

export function getBackoffDelay(attempt) {
  return Math.min(
    BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, attempt - 1),
    BACKOFF_MAX_MS,
  );
}

// Server-side statuses that mean "no retry needed" — the action has already
// been reconciled/confirmed since the UI last polled.
const RESOLVED_SERVER_STATUSES = new Set([
  "confirmed",
  "completed",
  "reconciled",
  "reverted",
]);

const MOCK_FAILED_ACTIONS = [
  {
    id: "act-001",
    type: "deposit",
    pool: "USDC Yield Pool",
    amount: "500",
    status: "failed",
    errorCode: "WALLET_REJECTED",
    errorDetail: "User rejected the transaction in wallet",
    createdAt: new Date(Date.now() - 600000).toISOString(),
    retryCount: 0,
    retryState: "idle",
    nextRetryAt: null,
    serverStatus: "failed",
    mockFailuresBeforeSuccess: 0,
  },
  {
    id: "act-002",
    type: "withdraw",
    pool: "ETH Staking Vault",
    amount: "250",
    status: "failed",
    errorCode: "NETWORK_ERROR",
    errorDetail: "Network timeout, please try again",
    createdAt: new Date(Date.now() - 1800000).toISOString(),
    retryCount: 1,
    retryState: "idle",
    nextRetryAt: null,
    serverStatus: "failed",
    mockFailuresBeforeSuccess: 2,
  },
  {
    id: "act-003",
    type: "deposit",
    pool: "BTC Synthetic Pool",
    amount: "1000",
    status: "pending",
    errorCode: null,
    errorDetail: null,
    createdAt: new Date(Date.now() - 300000).toISOString(),
    retryCount: 0,
    retryState: "idle",
    nextRetryAt: null,
    serverStatus: "submitted",
    mockFailuresBeforeSuccess: 0,
  },
  {
    id: "act-004",
    type: "withdraw",
    pool: "SOL Yield Vault",
    amount: "750",
    status: "failed",
    errorCode: "TIMEOUT",
    errorDetail: "The transaction timed out. Please retry.",
    createdAt: new Date(Date.now() - 900000).toISOString(),
    retryCount: 0,
    retryState: "idle",
    nextRetryAt: null,
    // Demo of the re-check: the server has actually confirmed this action
    // since the UI last polled — retrying would double-submit.
    serverStatus: "confirmed",
    mockFailuresBeforeSuccess: 0,
  },
  {
    id: "act-005",
    type: "deposit",
    pool: "DOT Staking Vault",
    amount: "320",
    status: "failed",
    errorCode: "NETWORK_ERROR",
    errorDetail: "Network timeout, please try again",
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    retryCount: 2,
    retryState: "idle",
    nextRetryAt: null,
    serverStatus: "failed",
    // Always fails in the mock so the exhausted/manual-intervention state is
    // reachable in the demo.
    mockFailuresBeforeSuccess: 99,
  },
];

/**
 * Re-checks the action's current server-side status. In production this calls
 * the backend (e.g. GET /api/actions/:id) — the action may have been
 * reconciled/confirmed since the UI last polled, in which case retrying would
 * double-submit and waste fees.
 */
async function fetchActionStatus(action) {
  await new Promise((resolve) => setTimeout(resolve, STATUS_RECHECK_DELAY_MS));
  return action.serverStatus ?? "failed";
}

/**
 * Submits the retry to the backend. Mock: fails `mockFailuresBeforeSuccess`
 * times (simulating transient network errors) before succeeding, so backoff
 * and exhaustion are reachable in the demo.
 */
async function submitRetry(action) {
  await new Promise((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
  if (action.retryCount < (action.mockFailuresBeforeSuccess ?? 0)) {
    throw new Error("NETWORK_ERROR");
  }
  return { ok: true };
}

function StatusBadge({ status, retryState }) {
  if (retryState === "retrying") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400">
        <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
        Retrying
      </span>
    );
  }
  if (retryState === "scheduled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400">
        <Clock className="h-3 w-3" aria-hidden="true" />
        Retrying soon
      </span>
    );
  }
  if (retryState === "exhausted") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        Needs attention
      </span>
    );
  }
  if (retryState === "resolved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Resolved on-chain
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
        <AlertCircle className="h-3 w-3" aria-hidden="true" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
      <Clock className="h-3 w-3" aria-hidden="true" />
      Pending
    </span>
  );
}

function ActionIcon({ type }) {
  if (type === "deposit") {
    return (
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <Wallet className="h-5 w-5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-muted">
      <Wallet className="h-5 w-5" aria-hidden="true" />
    </span>
  );
}

function ErrorMessage({ errorCode, errorDetail }) {
  const messages = {
    WALLET_REJECTED: "Transaction was rejected in your wallet. Click retry to try again.",
    NETWORK_ERROR: "A network error occurred. Check your connection and retry.",
    INSUFFICIENT_FEES: "Not enough XLM for transaction fees. Fund your wallet and retry.",
    TIMEOUT: "The transaction timed out. Please retry.",
    RETRY_EXHAUSTED: "Automatic retries exhausted — manual intervention required.",
  };

  return (
    <p className="mt-1 text-xs text-red-500 dark:text-red-400">
      {messages[errorCode] || errorDetail || "An unknown error occurred."}
    </p>
  );
}

function formatTimeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function QueuedAction({ action, now, onRetry, onCancel, onDismiss }) {
  const isPending = action.status === "pending";
  const isRetrying = action.retryState === "retrying";
  const isScheduled = action.retryState === "scheduled" && action.nextRetryAt != null;
  const isExhausted = action.retryState === "exhausted";
  const isResolved = action.retryState === "resolved";

  const retryDisabled = isPending || isRetrying || isScheduled || isResolved;

  const retryLabel = isRetrying
    ? "Retrying…"
    : isScheduled
      ? `Retrying in ${Math.max(1, Math.ceil((action.nextRetryAt - now) / 1000))}s`
      : "Retry";

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-start gap-4 rounded-xl border border-vault-border bg-vault-surface/50 p-4"
      data-testid={`retry-action-${action.id}`}
    >
      <ActionIcon type={action.type} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium capitalize text-vault-text">
            {action.type}
          </p>
          <StatusBadge status={action.status} retryState={action.retryState} />
          {action.retryCount > 0 && (
            <span className="text-xs text-vault-muted" data-testid={`retry-count-${action.id}`}>
              Retry #{action.retryCount}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-vault-muted">
          {action.pool} &middot; {action.amount} USDC
        </p>
        <p className="text-xs text-vault-muted">
          {formatTimeAgo(action.createdAt)}
        </p>
        {action.errorCode && (
          <ErrorMessage errorCode={action.errorCode} errorDetail={action.errorDetail} />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {!isPending && !isResolved && (
          <button
            type="button"
            onClick={() => onRetry(action)}
            disabled={retryDisabled}
            className="vq-btn-primary px-3 py-1.5 text-xs"
            aria-label={`Retry ${action.type}`}
            data-testid={`retry-button-${action.id}`}
          >
            {isRetrying ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : isScheduled ? (
              <Hourglass className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {retryLabel}
          </button>
        )}
        <button
          type="button"
          onClick={isPending ? () => onCancel(action) : () => onDismiss(action)}
          disabled={isRetrying}
          className="vq-btn-ghost px-2 py-1.5 text-xs"
          aria-label={isPending ? "Cancel pending action" : "Dismiss"}
        >
          {isPending ? (
            <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isPending ? "Cancel" : "Dismiss"}
        </button>
      </div>
    </motion.li>
  );
}

export default function VaultRetryQueue() {
  const [actions, setActions] = useState(MOCK_FAILED_ACTIONS);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // In-flight guard: prevents double-submit for the same action, even if the
  // user smashes the retry button before React re-renders the disabled state.
  const inFlightRef = useRef(new Set());
  const timersRef = useRef(new Map());
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  }, [actions]);

  const failedCount = actions.filter((a) => a.status === "failed").length;
  const pendingCount = actions.filter((a) => a.status === "pending").length;
  const totalCount = actions.length;

  const updateAction = useCallback((actionId, patch) => {
    setActions((prev) =>
      prev.map((a) => (a.id === actionId ? { ...a, ...patch } : a)),
    );
  }, []);

  const clearScheduledTimer = useCallback((actionId) => {
    const timer = timersRef.current.get(actionId);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(actionId);
    }
  }, []);

  // Clean up any pending backoff timers on unmount.
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, []);

  // Tick while any action is waiting out a backoff so the countdown re-renders.
  const hasScheduled = actions.some(
    (a) => a.retryState === "scheduled" && a.nextRetryAt != null,
  );
  useEffect(() => {
    if (!hasScheduled) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, [hasScheduled]);

  const attemptRetry = useCallback(
    async (actionId, { automatic = false } = {}) => {
      // Dedup: never start a second retry while one is already in flight.
      if (inFlightRef.current.has(actionId)) return;

      const action = actionsRef.current.find((a) => a.id === actionId);
      if (!action) return;

      // An automatic attempt only runs while the action is still scheduled
      // (the user may have dismissed or retried it in the meantime).
      if (automatic && action.retryState !== "scheduled") return;

      inFlightRef.current.add(actionId);
      clearScheduledTimer(actionId);
      updateAction(actionId, { retryState: "retrying", nextRetryAt: null });

      try {
        // 1) Re-check the server-side status before touching the chain — the
        //    action may have been reconciled/confirmed since the UI last polled.
        const serverStatus = await fetchActionStatus(action);
        if (RESOLVED_SERVER_STATUSES.has(serverStatus)) {
          updateAction(actionId, {
            retryState: "resolved",
            errorCode: null,
            errorDetail: "Action was already resolved on-chain; no retry needed.",
            serverStatus,
          });
          const dismissTimer = setTimeout(() => {
            setActions((prev) => prev.filter((a) => a.id !== actionId));
          }, RESOLVED_DISMISS_MS);
          timersRef.current.set(actionId, dismissTimer);
          return;
        }

        // 2) The action still needs a retry — submit it.
        await submitRetry(action);
        updateAction(actionId, {
          status: "pending",
          errorCode: null,
          errorDetail: null,
          retryCount: action.retryCount + 1,
          retryState: "idle",
          nextRetryAt: null,
          serverStatus: "submitted",
        });
      } catch (err) {
        // 3) Retry failed — back off and schedule an automatic retry, unless
        //    we've exhausted the budget and need manual intervention.
        const attempt = action.retryCount + 1;
        if (attempt >= MAX_RETRY_ATTEMPTS) {
          updateAction(actionId, {
            retryState: "exhausted",
            nextRetryAt: null,
            errorCode: "RETRY_EXHAUSTED",
            errorDetail: `Retry failed after ${attempt} attempts — automatic retries exhausted, manual intervention required.`,
          });
        } else {
          const delay = getBackoffDelay(attempt);
          updateAction(actionId, {
            retryState: "scheduled",
            nextRetryAt: Date.now() + delay,
            errorCode: err.message,
            errorDetail: `Retry failed — will retry automatically in ${Math.round(delay / 1000)}s.`,
          });
          const timer = setTimeout(() => {
            attemptRetry(actionId, { automatic: true });
          }, delay);
          timersRef.current.set(actionId, timer);
        }
      } finally {
        inFlightRef.current.delete(actionId);
      }
    },
    [clearScheduledTimer, updateAction],
  );

  const handleRetry = useCallback(
    (action) => {
      attemptRetry(action.id, { automatic: false });
    },
    [attemptRetry],
  );

  const handleCancel = useCallback(async (action) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    setActions((prev) =>
      prev.map((a) =>
        a.id === action.id
          ? { ...a, status: "failed", errorCode: "WALLET_REJECTED", errorDetail: "Action was cancelled by user" }
          : a,
      ),
    );
  }, []);

  const handleDismiss = useCallback(
    (action) => {
      clearScheduledTimer(action.id);
      inFlightRef.current.delete(action.id);
      setActions((prev) => prev.filter((a) => a.id !== action.id));
    },
    [clearScheduledTimer],
  );

  const handleClearAll = useCallback(() => {
    for (const action of actionsRef.current) {
      clearScheduledTimer(action.id);
    }
    inFlightRef.current.clear();
    setActions([]);
  }, [clearScheduledTimer]);

  if (totalCount === 0) return null;

  return (
    <section className="vq-glass p-4 sm:p-6" role="region" aria-label="Transaction retry queue">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left"
          aria-expanded={!collapsed}
          aria-controls="retry-queue-content"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-500" aria-hidden="true" />
            <h2 className="text-lg font-semibold text-vault-text">
              Pending Actions
            </h2>
          </div>
          <div className="flex gap-1.5">
            {failedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                {failedCount} failed
              </span>
            )}
            {pendingCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                {pendingCount} pending
              </span>
            )}
          </div>
        </button>

        <div className="flex items-center gap-2">
          {totalCount > 1 && (
            <button type="button" onClick={handleClearAll} className="vq-btn-ghost px-3 py-1.5 text-xs">
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear all
            </button>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="vq-btn-ghost px-3 py-1.5 text-xs"
            aria-label={collapsed ? "Expand queue" : "Collapse queue"}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            id="retry-queue-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <p className="mt-2 text-sm text-vault-muted">
              {failedCount > 0
                ? `${failedCount} transaction${failedCount > 1 ? "s" : ""} failed. You can retry or dismiss them.`
                : `${pendingCount} transaction${pendingCount > 1 ? "s" : ""} waiting to be processed.`}
            </p>

            <ul className="mt-4 space-y-3" role="list">
              <AnimatePresence>
                {actions.map((action) => (
                  <QueuedAction
                    key={action.id}
                    action={action}
                    now={now}
                    onRetry={handleRetry}
                    onCancel={handleCancel}
                    onDismiss={handleDismiss}
                  />
                ))}
              </AnimatePresence>
            </ul>

            {totalCount > 0 && (
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-vault-surface/50 px-4 py-3 text-xs text-vault-muted">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
                Successful retries will appear in your Activity page. Failed retries retry automatically with backoff.
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
