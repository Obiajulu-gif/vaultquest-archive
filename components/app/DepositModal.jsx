"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { X, Loader2, CheckCircle2, AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";
import GasPrioritySelector from "@/components/app/GasPrioritySelector";
import { toast } from "react-hot-toast";

const MIN_DEPOSIT = 1;
const MAX_DEPOSIT = 100_000;
const QUICK_AMOUNTS = [25, 50, 75] as const;

function formatToken(value, token) {
  return `${Number(value || 0).toFixed(token === "XLM" ? 6 : 4)} ${token}`;
}

export default function DepositModal({ isOpen, onClose }) {
  const [step, setStep] = useState("input"); // "input" | "confirm" | "loading" | "success"
  const [amount, setAmount] = useState("250");
  const [feeState, setFeeState] = useState(null);
  const [error, setError] = useState(null);
  const [walletBalance, setWalletBalance] = useState(0.0018);
  const [usdcBalance, setUsdcBalance] = useState(1000.00);
  const [refreshing, setRefreshing] = useState(false);

  const gasBudget = useMemo(() => feeState?.estimatedNative ?? 0, [feeState]);
  const amountNum = useMemo(() => parseFloat(amount) || 0, [amount]);
  const remainingUsdc = useMemo(() => usdcBalance - amountNum, [usdcBalance, amountNum]);
  const remainingNative = useMemo(() => walletBalance - gasBudget, [walletBalance, gasBudget]);
  const isGasShort = walletBalance < gasBudget;
  const isBelowMin = amountNum > 0 && amountNum < MIN_DEPOSIT;
  const isAboveMax = amountNum > MAX_DEPOSIT;
  const isInsufficientUsdc = amountNum > usdcBalance;
  const isInsufficientNative = gasBudget > 0 && walletBalance < gasBudget;

  const handleQuickAmount = useCallback((pct) => {
    const raw = usdcBalance * (pct / 100);
    const clamped = Math.min(raw, MAX_DEPOSIT);
    setAmount(clamped.toFixed(2));
    setError(null);
  }, [usdcBalance]);

  const handleMaxAmount = useCallback(() => {
    const max = Math.min(usdcBalance, MAX_DEPOSIT);
    setAmount(max.toFixed(2));
    setError(null);
  }, [usdcBalance]);

  const refreshBalances = useCallback(async () => {
    setRefreshing(true);
    // Simulate balance refresh — in production this would call the RPC
    await new Promise((resolve) => setTimeout(resolve, 600));
    setRefreshing(false);
    toast.success("Balances refreshed", { duration: 2000 });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setStep("input");
      setError(null);
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === "Escape" && step !== "loading") {
        onClose?.();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose, step]);

  if (!isOpen) {
    return null;
  }

  const handleContinue = () => {
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

  const handleConfirmDeposit = () => {
    setStep("loading");
    setTimeout(() => {
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
        { duration: 5000 }
      );
    }, 1800);
  };

  const getHeaderTitle = () => {
    switch (step) {
      case "confirm":
        return "Confirm transaction";
      case "loading":
        return "Broadcasting transaction";
      case "success":
        return "Transaction confirmed";
      case "input":
      default:
        return "Review gas before signing";
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-sm sm:items-center">
      <div className="vq-glass w-full max-w-5xl overflow-hidden border border-vault-border/60 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-vault-border/40 px-5 py-4 sm:px-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.22em] text-vault-muted">
              Deposit flow
            </p>
            <h2 className="mt-1 text-xl font-semibold text-vault-text">
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

        {/* Body Content */}
        <div className="p-5 lg:p-6">
          {step === "input" && (
            <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
              <section className="space-y-4 rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-5">
                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                      Deposit amount
                    </p>
                    <button
                      type="button"
                      onClick={refreshBalances}
                      disabled={refreshing}
                      className="flex items-center gap-1 text-xs text-vault-muted hover:text-vault-text transition-colors"
                      aria-label="Refresh wallet balances"
                    >
                      <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                      Refresh
                    </button>
                  </div>
                  <label htmlFor="deposit-amount" className="sr-only">
                    Deposit amount
                  </label>
                  <input
                    id="deposit-amount"
                    value={amount}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setError(null);
                    }}
                    inputMode="decimal"
                    className={`mt-2 w-full rounded-2xl border bg-vault-surface px-4 py-3 text-lg font-semibold text-vault-text outline-none transition focus:ring-2 ${
                      error
                        ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/25"
                        : "border-vault-border focus:border-red-400 focus:ring-red-400/25"
                    }`}
                    placeholder="0.00"
                  />
                  {error && (
                    <p className="mt-2 text-sm text-red-500 font-semibold" role="alert">
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
                      <span className="font-medium text-vault-text">{usdcBalance.toFixed(2)} USDC</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-vault-muted">Deposit amount</span>
                      <span className="font-medium text-red-500">-{amountNum > 0 ? amountNum.toFixed(2) : "0.00"} USDC</span>
                    </div>
                    <div className="border-t border-vault-border/30 pt-2 flex justify-between text-sm">
                      <span className="font-semibold text-vault-text">Remaining after deposit</span>
                      <span className={`font-bold ${remainingUsdc < 0 ? "text-red-500" : "text-vault-text"}`}>
                        {remainingUsdc >= 0 ? remainingUsdc.toFixed(2) : "0.00"} USDC
                      </span>
                    </div>
                  </div>

                  {/* Min/Max hint */}
                  <p className="mt-1 text-xs text-vault-muted">
                    Min: {MIN_DEPOSIT} USDC · Max: {MAX_DEPOSIT.toLocaleString()} USDC
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-vault-border/40 bg-vault-surface/35 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                      Deposit preview
                    </p>
                    <p className="mt-1 text-lg font-semibold text-vault-text">
                      {amount || "0.00"} USDC
                    </p>
                  </div>
                  <div className="rounded-2xl border border-vault-border/40 bg-vault-surface/35 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                      Est. remaining native
                    </p>
                    <p className="mt-1 text-lg font-semibold text-vault-text">
                      {formatToken(remainingNative, "AVAX")}
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-vault-border/40 bg-slate-950/75 p-4 text-sm text-slate-200">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    Transaction payload
                  </p>
                  <pre className="mt-2 overflow-auto text-xs leading-relaxed text-slate-200">
                    {JSON.stringify(
                      {
                        amount: amountNum,
                        asset: "USDC",
                        gasBudget: formatToken(gasBudget, "AVAX"),
                        walletBalance: formatToken(walletBalance, "AVAX"),
                        remainingBalance: formatToken(remainingNative, "AVAX"),
                      },
                      null,
                      2,
                    )}
                  </pre>
                </div>

                {isGasShort && (
                  <div
                    role="alert"
                    aria-live="assertive"
                    className="rounded-2xl border border-amber-400/35 bg-amber-500/10 p-4 text-sm text-amber-100"
                  >
                    <p className="font-semibold text-vault-text">Network fee warning</p>
                    <p className="mt-1 text-vault-muted">
                      The connected wallet has insufficient AVAX to cover the estimated network fee of {formatToken(gasBudget, "AVAX")}.
                    </p>
                  </div>
                )}
              </section>

              <GasPrioritySelector nativeBalance={walletBalance} onChange={setFeeState} />
            </div>
          )}

          {step === "confirm" && (
            <section className="space-y-6 rounded-3xl border border-vault-border/40 bg-vault-surface/30 p-6 max-w-2xl mx-auto my-2">
              <div className="text-center">
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
                  Review transaction
                </p>
                <h3 className="mt-2 text-2xl font-bold text-vault-text">
                  Deposit Confirmation
                </h3>
              </div>

              <div className="divide-y divide-vault-border rounded-2xl border border-vault-border/40 bg-vault-surface/40 px-6 py-2 space-y-3">
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Amount to Deposit</span>
                  <span className="font-bold text-vault-text">{amount} USDC</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Destination Pool</span>
                  <span className="font-medium text-vault-text">USDC Stable Pool</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Estimated Gas Fee</span>
                  <span className="font-medium text-vault-text">{formatToken(gasBudget, "AVAX")}</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Remaining USDC Balance</span>
                  <span className="font-medium text-vault-text">{remainingUsdc.toFixed(2)} USDC</span>
                </div>
                <div className="flex justify-between py-2.5">
                  <span className="text-vault-muted">Remaining AVAX Balance</span>
                  <span className="font-medium text-vault-text">{formatToken(remainingNative, "AVAX")}</span>
                </div>
                <div className="flex justify-between py-2.5 pt-4">
                  <span className="font-semibold text-vault-text">Deduction Summary</span>
                  <span className="font-bold text-red-500">
                    {amount} USDC + {formatToken(gasBudget, "AVAX")}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-vault-muted">
                Yield generated from pooled deposits funds periodic prize drawings. Your original deposit (principal) remains fully withdrawable at any time.
              </div>
            </section>
          )}

          {step === "loading" && (
            <section className="flex flex-col items-center justify-center py-16 space-y-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-red-500/30">
                <Loader2 className="h-8 w-8 animate-spin text-red-400" />
              </div>
              <h3 className="text-lg font-semibold text-vault-text">Processing Deposit</h3>
              <p className="text-sm text-vault-muted max-w-xs text-center">
                Please approve the transaction in your connected wallet. Broadcasting to the network...
              </p>
            </section>
          )}

          {step === "success" && (
            <section className="flex flex-col items-center justify-center py-8 space-y-4 max-w-md mx-auto">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shadow-glow-green">
                <CheckCircle2 className="h-10 w-10 animate-bounce" />
              </div>
              <h3 className="text-2xl font-bold text-vault-text">Deposit Successful!</h3>
              <p className="text-sm text-vault-muted text-center">
                Your deposit of <strong className="text-vault-text">{amount} USDC</strong> was successfully broadcast and confirmed on-chain.
              </p>

              <div className="w-full divide-y divide-vault-border rounded-2xl border border-vault-border/40 bg-vault-surface/40 px-5 py-3 text-xs">
                <div className="flex justify-between py-2">
                  <span className="text-vault-muted">Pool</span>
                  <span className="text-vault-text font-medium">USDC Stable Pool</span>
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
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-vault-border/40 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="text-sm text-vault-muted">
            {step === "input" && "Review the balance impact below before continuing."}
            {step === "confirm" && "Double check transaction payload and destination pool details before signing."}
            {step === "loading" && "Do not close this modal or refresh the page while the transaction is broadcasting."}
            {step === "success" && "Transaction completed successfully. You can close this modal."}
          </div>
          <div className="flex gap-3">
            {step === "input" && (
              <>
                <button type="button" onClick={onClose} className="vq-btn-ghost">
                  Cancel
                </button>
                <button type="button" onClick={handleContinue} className="vq-btn-primary">
                  Confirm deposit
                </button>
              </>
            )}
            {step === "confirm" && (
              <>
                <button type="button" onClick={() => setStep("input")} className="vq-btn-ghost">
                  <ArrowLeft className="h-4 w-4 mr-1 inline" /> Back
                </button>
                <button type="button" onClick={handleConfirmDeposit} className="vq-btn-primary">
                  Sign & Submit
                </button>
              </>
            )}
            {step === "loading" && (
              <button type="button" disabled className="vq-btn-primary opacity-50 cursor-not-allowed">
                Broadcasting...
              </button>
            )}
            {step === "success" && (
              <button type="button" onClick={onClose} className="vq-btn-primary">
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
