"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { X, Loader2, CheckCircle2, AlertTriangle, ArrowLeft, RefreshCw, Wallet } from "lucide-react";
import GasPrioritySelector from "@/components/app/GasPrioritySelector";
import { toast } from "react-hot-toast";
import { usePrefersReducedMotion } from "@/lib/usePrefersReducedMotion";
import { formatAssetAmount } from "@/lib/formatting";
import { calculateDepositPreview } from "../../stellar-wallet-connect/src/vault/lib/depositPreview";

const MIN_DEPOSIT = 1;
const MAX_DEPOSIT = 100_000;
const QUICK_AMOUNTS = [25, 50, 75];

function formatToken(value, token) {
  return formatAssetAmount(value, token);
}

export default function DepositModal({
  isOpen,
  onClose,
  initialAmount = "250",
  onDeposit = null,
  isConnected = true,
  onConnectWallet = null,
  poolSummary = null,
}) {
  const [step, setStep] = useState("input"); // "input" | "confirm" | "loading" | "success" | "error"
  const [amount, setAmount] = useState(initialAmount);
  const [feeState, setFeeState] = useState(null);
  const [error, setError] = useState(null);
  const [walletBalance, setWalletBalance] = useState(0.0018);
  const [usdcBalance, setUsdcBalance] = useState(1000.0);
  const [refreshing, setRefreshing] = useState(false);

  const dialogRef = useRef(null);
  const titleRef = useRef(null);
  const previouslyFocusedRef = useRef(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  const gasBudget = useMemo(() => feeState?.estimatedNative ?? 0, [feeState]);
  const amountNum = useMemo(() => parseFloat(amount) || 0, [amount]);
  const remainingUsdc = useMemo(() => usdcBalance - amountNum, [usdcBalance, amountNum]);
  const remainingNative = useMemo(() => walletBalance - gasBudget, [walletBalance, gasBudget]);
  const isGasShort = walletBalance < gasBudget;
  const isBelowMin = amountNum > 0 && amountNum < MIN_DEPOSIT;
  const isAboveMax = amountNum > MAX_DEPOSIT;
  const isInsufficientUsdc = amountNum > usdcBalance;
  const isInsufficientNative = gasBudget > 0 && walletBalance < gasBudget;

  const mockPoolSummary = useMemo(
    () =>
      poolSummary ?? {
        id: "usdc_pool",
        name: "USDC Stable Pool",
        status: "open",
        tvl: "500000",
        asset: "USDC",
        participantCount: 142,
        expectedYield: "5.2% APY",
        opensAt: null,
        locksAt: null,
        drawsAt: null,
        strategyExposureBps: 8000,
        idleLiquidity: "100000",
        queuedWithdrawals: "15000",
        maxStrategyExposureBps: 8500,
        minIdleRatioBps: 1500,
      },
    [poolSummary],
  );

  const depositPreview = useMemo(
    () => calculateDepositPreview(mockPoolSummary, amountNum),
    [mockPoolSummary, amountNum],
  );

  const handleQuickAmount = useCallback(
    (pct) => {
      const raw = usdcBalance * (pct / 100);
      const clamped = Math.min(raw, MAX_DEPOSIT);
      setAmount(formatAssetAmount(clamped, "USDC", { showSymbol: false }));
      setError(null);
    },
    [usdcBalance],
  );

  const handleMaxAmount = useCallback(() => {
    const max = Math.min(usdcBalance, MAX_DEPOSIT);
    setAmount(formatAssetAmount(max, "USDC", { showSymbol: false }));
    setError(null);
  }, [usdcBalance]);

  const refreshBalances = useCallback(async () => {
    setRefreshing(true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    setRefreshing(false);
    toast.success("Balances refreshed", { duration: 2000 });
  }, []);

  // Save previous activeElement on open and restore on close
  useEffect(() => {
    if (isOpen) {
      if (typeof document !== "undefined") {
        previouslyFocusedRef.current = document.activeElement;
      }
      if (titleRef.current) {
        titleRef.current.focus();
      }
    } else {
      setStep("input");
      setError(null);
      if (previouslyFocusedRef.current && typeof previouslyFocusedRef.current.focus === "function") {
        previouslyFocusedRef.current.focus();
      }
    }
  }, [isOpen]);

  // When step changes, shift focus to the step heading for screen readers
  useEffect(() => {
    if (isOpen && titleRef.current) {
      titleRef.current.focus();
    }
  }, [step, isOpen]);

  // Focus trap and Escape listener
  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event) => {
      if (event.key === "Escape" && step !== "loading") {
        onClose?.();
        return;
      }

      if (event.key === "Tab") {
        const root = dialogRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose, step]);

  if (!isOpen) {
    return null;
  }

  const handleContinue = () => {
    if (!isConnected) {
      setError("Please connect your wallet before proceeding.");
      return;
    }
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      setError("Please enter a valid deposit amount.");
      return;
    }
    if (isBelowMin) {
      setError(`Minimum deposit is ${MIN_DEPOSIT} USDC.`);
      return;
    }
    if (isAboveMax) {
      setError(`Maximum deposit is ${MAX_DEPOSIT.toLocaleString()} USDC.`);
      return;
    }
    if (isInsufficientUsdc) {
      setError("Deposit amount exceeds your available USDC balance.");
      return;
    }
    if (isInsufficientNative) {
      setError("Insufficient AVAX to cover the estimated network fee.");
      return;
    }
    setError(null);
    setStep("confirm");
  };

  const handleConfirmDeposit = async () => {
    setStep("loading");
    try {
      if (onDeposit) {
        await onDeposit(amount);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setStep("success");
      toast.success(
        <div className="flex flex-col gap-1">
          <span>Deposit of {amount} USDC confirmed!</span>
          <a
            href="https://etherscan.io/tx/0x7d3a95bfce31a20df949e29ae8f9"
            target="_blank"
            rel="noreferrer"
            className="text-xs underline text-emerald-500 hover:text-emerald-400"
          >
            View transaction
          </a>
        </div>,
        { duration: 5000 },
      );
    } catch (err) {
      const msg = err?.message || "Transaction failed or was rejected by wallet.";
      setError(msg);
      setStep("error");
    }
  };

  const handleRetry = () => {
    setError(null);
    handleConfirmDeposit();
  };

  const getHeaderTitle = () => {
    switch (step) {
      case "confirm":
        return "Confirm transaction";
      case "loading":
        return "Broadcasting transaction";
      case "success":
        return "Transaction confirmed";
      case "error":
        return "Transaction failed";
      case "input":
      default:
        return "Review gas before signing";
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm sm:items-center"
      data-testid="deposit-modal-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-modal-title"
        className="vq-glass w-full max-w-5xl overflow-hidden border border-vault-border/60 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-vault-border/40 px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-vault-muted">
              Deposit flow
            </p>
            <h2
              id="deposit-modal-title"
              ref={titleRef}
              tabIndex={-1}
              className="mt-1 text-xl font-semibold text-vault-text outline-none"
            >
              {getHeaderTitle()}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="vq-btn-ghost h-10 w-10 rounded-full p-0 disabled:opacity-40"
            aria-label="Close deposit modal"
            disabled={step === "loading"}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Authorization Alert if wallet not connected */}
        {!isConnected && (
          <div
            role="alert"
            aria-live="polite"
            className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-200"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium">
                Wallet connection required to deposit. Please connect your Stellar wallet.
              </span>
            </div>
            {onConnectWallet && (
              <button
                type="button"
                onClick={onConnectWallet}
                className="flex items-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/30 focus:outline-none focus:ring-2 focus:ring-amber-400"
                aria-label="Connect wallet to continue"
              >
                <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
                Connect Wallet
              </button>
            )}
          </div>
        )}

        {/* Body Content */}
        <div className="p-5 lg:p-6">
          {step === "input" && (
            <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
              <section className="space-y-4 rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-5">
                <div>
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="deposit-amount"
                      className="text-xs font-medium uppercase tracking-wide text-vault-muted"
                    >
                      Deposit amount
                    </label>
                    <button
                      type="button"
                      onClick={refreshBalances}
                      disabled={refreshing}
                      className="flex items-center gap-1 text-xs text-vault-muted hover:text-vault-text transition-colors focus:outline-none focus:ring-2 focus:ring-red-400/25"
                      aria-label="Refresh wallet balances"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${refreshing && !prefersReducedMotion ? "animate-spin" : ""}`}
                        aria-hidden="true"
                      />
                      Refresh
                    </button>
                  </div>
                  <input
                    id="deposit-amount"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setError(null);
                    }}
                    inputMode="decimal"
                    aria-required="true"
                    aria-invalid={error ? "true" : "false"}
                    aria-describedby={error ? "deposit-amount-error" : undefined}
                    className={`mt-2 w-full rounded-2xl border bg-vault-surface px-4 py-3 text-lg font-semibold text-vault-text outline-none transition focus:ring-2 ${
                      error
                        ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/25"
                        : "border-vault-border focus:border-red-400 focus:ring-red-400/25"
                    }`}
                    placeholder="0.00"
                  />
                  {error && (
                    <p
                      id="deposit-amount-error"
                      className="mt-2 text-sm text-red-500 font-semibold"
                      role="alert"
                      aria-live="assertive"
                    >
                      {error}
                    </p>
                  )}

                  <div className="mt-3 flex gap-2">
                    {QUICK_AMOUNTS.map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => handleQuickAmount(pct)}
                        className="flex-1 rounded-xl border border-vault-border/60 px-3 py-2 text-sm font-medium text-vault-muted transition-colors hover:bg-vault-surface hover:text-vault-text focus:outline-none focus:ring-2 focus:ring-red-400/25"
                      >
                        {pct}%
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={handleMaxAmount}
                      className="flex-1 rounded-xl border border-red-500/40 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus:outline-none focus:ring-2 focus:ring-red-400/25"
                    >
                      Max
                    </button>
                  </div>

                  {/* Balance impact preview */}
                  <div className="mt-3 rounded-2xl border border-vault-border/40 bg-vault-surface/50 p-4 space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                      Balance impact
                    </p>
                    <div className="flex justify-between text-sm">
                      <span className="text-vault-muted">Current USDC balance</span>
                      <span className="font-medium text-vault-text">
                        {formatAssetAmount(usdcBalance, "USDC")}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-vault-muted">Deposit amount</span>
                      <span className="font-medium text-vault-text">
                        {formatAssetAmount(amountNum, "USDC")}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm border-t border-vault-border/40 pt-2">
                      <span className="text-vault-muted">Remaining USDC</span>
                      <span className="font-medium text-vault-text">
                        {formatAssetAmount(Math.max(0, remainingUsdc), "USDC")}
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Right column: Gas fee breakdown */}
              <section className="space-y-4 rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-5">
                <GasPrioritySelector onFeeCalculated={setFeeState} />
              </section>
            </div>
          )}

          {step === "confirm" && (
            <section className="space-y-4 max-w-xl mx-auto py-4">
              <div className="rounded-2xl border border-vault-border/40 bg-vault-surface/40 p-5 space-y-3">
                <h3 className="text-sm font-semibold text-vault-muted uppercase tracking-wider">
                  Transaction Summary
                </h3>
                <div className="flex justify-between text-base">
                  <span className="text-vault-muted">Pool:</span>
                  <span className="font-semibold text-vault-text">{mockPoolSummary.name}</span>
                </div>
                <div className="flex justify-between text-base">
                  <span className="text-vault-muted">Deposit:</span>
                  <span className="font-semibold text-emerald-400">{amount} USDC</span>
                </div>
                <div className="flex justify-between text-sm text-vault-muted">
                  <span>Network Gas Fee:</span>
                  <span>{gasBudget.toFixed(4)} XLM</span>
                </div>
              </div>
            </section>
          )}

          {step === "loading" && (
            <section
              role="status"
              aria-live="polite"
              aria-busy="true"
              className="flex flex-col items-center justify-center py-16 space-y-4"
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-red-500/30">
                <Loader2
                  className={`h-8 w-8 text-red-400 ${prefersReducedMotion ? "" : "animate-spin"}`}
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-lg font-semibold text-vault-text">Processing Deposit</h3>
              <p className="text-sm text-vault-muted max-w-xs text-center">
                Please approve the transaction in your connected wallet. Broadcasting to the network...
              </p>
            </section>
          )}

          {step === "success" && (
            <section
              role="status"
              aria-live="polite"
              className="flex flex-col items-center justify-center py-8 space-y-4 max-w-md mx-auto"
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shadow-glow-green">
                <CheckCircle2
                  className={`h-10 w-10 ${prefersReducedMotion ? "" : "animate-bounce"}`}
                  aria-hidden="true"
                />
              </div>
              <h3 className="text-2xl font-bold text-vault-text">Deposit Successful!</h3>
              <p className="text-sm text-vault-muted text-center">
                Your deposit of <strong className="text-vault-text">{amount} USDC</strong> was successfully broadcast and confirmed on-chain.
              </p>

              <div className="w-full divide-y divide-vault-border rounded-2xl border border-vault-border/40 bg-vault-surface/40 px-5 py-3 text-xs">
                <div className="flex justify-between py-2">
                  <span className="text-vault-muted">Pool</span>
                  <span className="text-vault-text font-medium">{mockPoolSummary.name}</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-vault-muted">Transaction Hash</span>
                  <span className="text-vault-text font-mono">0x7d3a95bfce31a20df949e29a...e8f9</span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-vault-muted">Status</span>
                  <span className="text-emerald-500 font-bold">Confirmed</span>
                </div>
              </div>
            </section>
          )}

          {step === "error" && (
            <section
              role="alert"
              aria-live="assertive"
              className="flex flex-col items-center justify-center py-8 space-y-4 max-w-md mx-auto"
            >
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
                <AlertTriangle className="h-10 w-10 text-red-400" aria-hidden="true" />
              </div>
              <h3 className="text-2xl font-bold text-vault-text">Transaction Failed</h3>
              <p className="text-sm text-vault-muted text-center">
                {error || "An unexpected error occurred while processing your transaction."}
              </p>
              <p className="text-xs text-vault-muted text-center">
                Your entered amount ({amount} USDC) was preserved. You can safely retry without creating a duplicate.
              </p>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-vault-border/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="text-sm text-vault-muted">
            {step === "input" && "Review the balance impact below before continuing."}
            {step === "confirm" && "Double check transaction payload and destination pool details before signing."}
            {step === "loading" && "Do not close this modal or refresh the page while the transaction is broadcasting."}
            {step === "success" && "Transaction completed successfully. You can close this modal."}
            {step === "error" && "Transaction did not complete. Review the error details and choose an action."}
          </div>
          <div className="flex gap-3">
            {step === "input" && (
              <>
                <button type="button" onClick={onClose} className="vq-btn-ghost">
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleContinue}
                  className="vq-btn-primary"
                  aria-disabled={!isConnected}
                >
                  Confirm deposit
                </button>
              </>
            )}
            {step === "confirm" && (
              <>
                <button type="button" onClick={() => setStep("input")} className="vq-btn-ghost">
                  <ArrowLeft className="h-4 w-4 mr-1 inline" aria-hidden="true" /> Back
                </button>
                <button type="button" onClick={handleConfirmDeposit} className="vq-btn-primary">
                  Sign & Submit
                </button>
              </>
            )}
            {step === "loading" && (
              <button
                type="button"
                disabled
                aria-busy="true"
                className="vq-btn-primary opacity-50 cursor-not-allowed"
              >
                Broadcasting...
              </button>
            )}
            {step === "success" && (
              <button type="button" onClick={onClose} className="vq-btn-primary">
                Close
              </button>
            )}
            {step === "error" && (
              <>
                <button type="button" onClick={() => setStep("input")} className="vq-btn-ghost">
                  Back to edit
                </button>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="vq-btn-primary"
                  aria-label={`Retry deposit of ${amount} USDC`}
                >
                  Retry deposit
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
