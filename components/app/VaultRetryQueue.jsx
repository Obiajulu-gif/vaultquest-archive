"use client";

import { useState, useCallback } from "react";
import { AlertCircle, RefreshCw, Trash2, XCircle, CheckCircle2, Clock, Wallet } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

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
  },
];

function StatusBadge({ status }) {
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

function QueuedAction({ action, onRetry, onCancel, onDismiss }) {
  const [isProcessing, setIsProcessing] = useState(false);

  const handleRetry = useCallback(async () => {
    setIsProcessing(true);
    try {
      await onRetry(action);
    } finally {
      setIsProcessing(false);
    }
  }, [action, onRetry]);

  const handleCancel = useCallback(async () => {
    setIsProcessing(true);
    try {
      await onCancel(action);
    } finally {
      setIsProcessing(false);
    }
  }, [action, onCancel]);

  const isPending = action.status === "pending";

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.2 }}
      className="flex items-start gap-4 rounded-xl border border-vault-border bg-vault-surface/50 p-4"
    >
      <ActionIcon type={action.type} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium capitalize text-vault-text">
            {action.type}
          </p>
          <StatusBadge status={action.status} />
          {action.retryCount > 0 && (
            <span className="text-xs text-vault-muted">
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
        {!isPending && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={isProcessing}
            className="vq-btn-primary px-3 py-1.5 text-xs"
            aria-label={`Retry ${action.type}`}
          >
            {isProcessing ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Retry
          </button>
        )}
        <button
          type="button"
          onClick={isPending ? handleCancel : handleDismiss}
          disabled={isProcessing}
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

  const failedCount = actions.filter((a) => a.status === "failed").length;
  const pendingCount = actions.filter((a) => a.status === "pending").length;
  const totalCount = actions.length;

  const handleRetry = useCallback(async (action) => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setActions((prev) =>
      prev.map((a) =>
        a.id === action.id
          ? { ...a, status: "pending", errorCode: null, errorDetail: null, retryCount: a.retryCount + 1 }
          : a
      )
    );
  }, []);

  const handleCancel = useCallback(async (action) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    setActions((prev) =>
      prev.map((a) =>
        a.id === action.id
          ? { ...a, status: "failed", errorCode: "WALLET_REJECTED", errorDetail: "Action was cancelled by user" }
          : a
      )
    );
  }, []);

  const handleDismiss = useCallback((action) => {
    setActions((prev) => prev.filter((a) => a.id !== action.id));
  }, []);

  const handleClearAll = useCallback(() => {
    setActions([]);
  }, []);

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
                Successful retries will appear in your Activity page.
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
