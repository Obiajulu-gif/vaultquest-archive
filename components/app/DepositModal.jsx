"use client";

import { useEffect, useMemo, useState } from "react";
import { X, Loader2, CheckCircle2, AlertTriangle, ArrowLeft } from "lucide-react";
import GasPrioritySelector from "@/components/app/GasPrioritySelector";

function formatToken(value, token) {
  return `${Number(value || 0).toFixed(token === "XLM" ? 6 : 4)} ${token}`;
}

export default function DepositModal({ isOpen, onClose }) {
  const [step, setStep] = useState("input"); // "input" | "confirm" | "loading" | "success"
  const [amount, setAmount] = useState("250");
  const [feeState, setFeeState] = useState(null);
  const [error, setError] = useState(null);
  
  const walletBalance = 0.0018; // AVAX
  const usdcBalance = 1000.00; // Demo USDC balance
  
  const gasBudget = useMemo(() => feeState?.estimatedNative ?? 0, [feeState]);

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

  const isGasShort = walletBalance < gasBudget;

  const handleContinue = () => {
    const amountNum = parseFloat(amount);
    if (!amount || isNaN(amountNum)) {
      setError("Please enter a valid amount.");
      return;
    }
    if (amountNum <= 0) {
      setError("Amount must be greater than 0.");
      return;
    }
    if (amountNum > usdcBalance) {
      setError("Amount exceeds your available USDC balance.");
      return;
    }
    if (isGasShort) {
      setError("Insufficient AVAX to cover the estimated gas fee.");
      return;
    }
    setError(null);
    setStep("confirm");
  };

  const handleConfirmDeposit = () => {
    setStep("loading");
    setTimeout(() => {
      setStep("success");
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
                  <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                    Deposit amount
                  </p>
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
                  <div className="mt-2 flex justify-between text-xs text-vault-muted">
                    <span>Demo USDC balance: {usdcBalance.toFixed(2)} USDC</span>
                    <span>Demo AVAX balance: {formatToken(walletBalance, "AVAX")}</span>
                  </div>
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
                      Native balance
                    </p>
                    <p className="mt-1 text-lg font-semibold text-vault-text">
                      {formatToken(walletBalance, "AVAX")}
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
                        amount,
                        gasBudget: formatToken(gasBudget, "AVAX"),
                        balance: formatToken(walletBalance, "AVAX"),
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
                    <p className="font-semibold text-vault-text">Network warning</p>
                    <p className="mt-1 text-vault-muted">
                      The connected wallet does not have enough native token to cover the selected gas fee.
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
                <div className="flex justify-between py-2.5 pt-4">
                  <span className="font-semibold text-vault-text">Deduction Summary</span>
                  <span className="font-bold text-red-500">
                    {amount} USDC + {formatToken(gasBudget, "AVAX")}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-xs text-vault-muted">
                ⚠️ Yield generated from pooled deposits funds periodic prize drawings. Your original deposit (principal) remains fully withdrawable at any time.
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
            {step === "input" && "Selected gas cost is applied to the transaction execution payload before submission."}
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