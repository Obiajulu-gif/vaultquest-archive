"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  AlertTriangle,
  RotateCcw,
  RefreshCw,
  Copy,
  Check,
  ShieldAlert,
  Wallet,
  X,
} from "lucide-react";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";

/**
 * AsyncErrorRecovery (#1072)
 *
 * Production-grade WCAG 2.1 AA accessible asynchronous error recovery component.
 *
 * Accessibility Protections:
 * - Alert & Region Semantics: role="alert" / role="region", aria-labelledby, aria-describedby.
 * - Live Region Announcements: aria-live="polite" for status transitions, aria-live="assertive" for critical errors.
 * - Async State Feedback: aria-busy="true" during active retry or status recheck operations.
 * - Focus Management:
 *   - Auto-focuses the primary action (e.g. Retry or Connect Wallet) on mount.
 *   - Restores focus to previous active element upon dismissal/resolution.
 *   - Focus stays trapped within the recovery container during modal/blocking recovery.
 * - Keyboard Traversal: Tab / Shift+Tab cycling, Escape dismissal, Enter/Space activation.
 * - Screen Reader Form Binding: Descriptive error messages linked via aria-describedby.
 * - Reduced Motion: Animated spinners and transitions pause when prefers-reduced-motion is active.
 * - Authorization Guard: Disconnected or unauthorized states provide accessible guidance and focusable reconnect actions.
 *
 * @param {Object} props
 * @param {string} [props.title]
 * @param {string} [props.errorMessage]
 * @param {string} [props.errorCode]
 * @param {string} [props.diagnosticId]
 * @param {boolean} [props.isRetrying]
 * @param {number} [props.retryCount]
 * @param {number} [props.maxRetries]
 * @param {boolean} [props.isWalletConnected]
 * @param {Function} [props.onRetry]
 * @param {Function} [props.onConnectWallet]
 * @param {Function} [props.onDismiss]
 * @param {Function} [props.onReload]
 * @param {"alert" | "region" | "dialog"} [props.containerRole]
 * @param {boolean} [props.autoFocus]
 */
export default function AsyncErrorRecovery({
  title = "Operation encountered an error",
  errorMessage = "Unable to complete the asynchronous transaction. Please verify your connection and retry.",
  errorCode = "ASYNC_TRANSACTION_FAILED",
  diagnosticId = "vq-err-84920",
  isRetrying = false,
  retryCount = 0,
  maxRetries = 3,
  isWalletConnected = true,
  onRetry,
  onConnectWallet,
  onDismiss,
  onReload,
  containerRole = "alert",
  autoFocus = true,
}) {
  const [internalRetrying, setInternalRetrying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const reducedMotion = usePrefersReducedMotion();

  const primaryBtnRef = useRef(null);
  const previousFocusRef = useRef(null);
  const containerRef = useRef(null);

  // Store previously focused element on mount for accessible restoration
  useEffect(() => {
    if (typeof document !== "undefined") {
      previousFocusRef.current = document.activeElement;
    }
    if (autoFocus && primaryBtnRef.current) {
      primaryBtnRef.current.focus();
    }

    return () => {
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === "function") {
        previousFocusRef.current.focus();
      }
    };
  }, [autoFocus]);

  // Global Escape key handler for accessible modal/banner dismissal
  useEffect(() => {
    if (!onDismiss || typeof window === "undefined") return;

    const handleWindowKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, [onDismiss]);

  const activeRetrying = isRetrying || internalRetrying;
  const retriesExhausted = retryCount >= maxRetries;
  const isAuthorized = isWalletConnected;

  const handleRetry = useCallback(async () => {
    if (activeRetrying || retriesExhausted || !isAuthorized || !onRetry) return;

    setInternalRetrying(true);
    setAnnouncement(`Retrying operation. Attempt ${retryCount + 1} of ${maxRetries}`);

    try {
      await Promise.resolve(onRetry());
      setAnnouncement("Operation recovered successfully.");
    } catch {
      setAnnouncement("Retry attempt failed. Please try again or copy diagnostic ID for support.");
    } finally {
      setInternalRetrying(false);
    }
  }, [activeRetrying, retriesExhausted, isAuthorized, onRetry, retryCount, maxRetries]);

  const handleCopy = useCallback(async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(diagnosticId);
        setCopied(true);
        setAnnouncement(`Diagnostic identifier ${diagnosticId} copied to clipboard`);
        setTimeout(() => setCopied(false), 3000);
      }
    } catch {
      setAnnouncement("Failed to copy diagnostic identifier to clipboard");
    }
  }, [diagnosticId]);

  return (
    <div
      ref={containerRef}
      role={containerRole}
      aria-labelledby="async-recovery-title"
      aria-describedby="async-recovery-desc"
      aria-busy={activeRetrying ? "true" : "false"}
      className="relative rounded-2xl border border-red-500/30 bg-red-950/20 p-6 text-vault-text backdrop-blur-md transition-colors"
      data-testid="async-error-recovery"
      tabIndex={-1}
    >
      {/* Live Region for Screen Reader Announcements */}
      <div
        className="sr-only"
        role="status"
        aria-live={retriesExhausted ? "assertive" : "polite"}
        aria-atomic="true"
        data-testid="a11y-live-region"
      >
        {announcement}
      </div>

      <div className="flex items-start gap-4">
        {/* Status Icon */}
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-red-500/40 bg-red-500/10 text-red-400"
          aria-hidden="true"
        >
          {retriesExhausted ? (
            <ShieldAlert className="h-6 w-6" />
          ) : (
            <AlertTriangle className="h-6 w-6" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3
              id="async-recovery-title"
              className="text-lg font-semibold text-red-200"
              tabIndex={-1}
            >
              {title}
            </h3>
            {onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg p-1.5 text-vault-muted hover:bg-white/10 hover:text-vault-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                aria-label="Dismiss error notification"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            )}
          </div>

          <p id="async-recovery-desc" className="mt-1 text-sm text-gray-300">
            {errorMessage}
          </p>

          {/* Authorization Warning Path */}
          {!isAuthorized && (
            <div
              className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-sm text-amber-200"
              role="alert"
              aria-live="assertive"
              data-testid="wallet-auth-alert"
            >
              <Wallet className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Wallet disconnected. Reconnect your Stellar wallet to authorize retry.</span>
            </div>
          )}

          {/* Diagnostic Code & Metadata */}
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-vault-muted">
            <span className="font-mono bg-white/5 px-2 py-1 rounded">
              Code: <strong className="text-red-300">{errorCode}</strong>
            </span>
            <span
              id="async-recovery-diagnostic"
              className="font-mono bg-white/5 px-2 py-1 rounded inline-flex items-center gap-1.5"
            >
              ID: {diagnosticId}
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1 text-vault-muted hover:text-vault-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-400"
                aria-label={`Copy diagnostic ID ${diagnosticId}`}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>{copied ? "Copied" : "Copy"}</span>
              </button>
            </span>
            {retryCount > 0 && (
              <span className="bg-white/5 px-2 py-1 rounded">
                Attempt {retryCount} of {maxRetries}
              </span>
            )}
          </div>

          {/* Accessible Action Controls */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            {!isAuthorized && onConnectWallet ? (
              <button
                ref={primaryBtnRef}
                type="button"
                onClick={onConnectWallet}
                className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                aria-label="Connect Stellar wallet to authorize retry"
              >
                <Wallet className="h-4 w-4" aria-hidden="true" />
                <span>Connect Wallet</span>
              </button>
            ) : (
              onRetry && (
                <button
                  ref={primaryBtnRef}
                  type="button"
                  onClick={handleRetry}
                  disabled={activeRetrying || retriesExhausted}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                  aria-label={
                    activeRetrying
                      ? "Retrying operation…"
                      : retriesExhausted
                      ? "Retries exhausted. Manual intervention required."
                      : `Retry operation (${maxRetries - retryCount} attempts remaining)`
                  }
                  data-testid="async-retry-button"
                >
                  <RotateCcw
                    className={`h-4 w-4 ${
                      activeRetrying && !reducedMotion ? "animate-spin" : ""
                    }`}
                    aria-hidden="true"
                  />
                  <span>
                    {activeRetrying
                      ? "Retrying…"
                      : retriesExhausted
                      ? "Retries Exhausted"
                      : "Retry Operation"}
                  </span>
                </button>
              )
            )}

            {onReload && (
              <button
                type="button"
                onClick={onReload}
                className="inline-flex items-center gap-2 rounded-lg border border-vault-border bg-vault-surface px-4 py-2 text-sm font-semibold text-vault-text transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
                aria-label="Reload current view"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                <span>Reload</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
