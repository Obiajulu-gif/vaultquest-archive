import type { FC } from "react";
import { useState, useCallback } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import Modal from "../../components/Modal";
import type { PoolSummary, UserPosition } from "../contract/types";
import { formatAmount } from "../lib/format";

type Step = "input" | "review" | "broadcasting" | "success";

const QUICK_AMOUNTS = [25, 50, 75] as const;

export interface WithdrawalModalProps {
  pool: PoolSummary;
  position: UserPosition;
  onWithdraw: (amount: string) => Promise<void>;
  onClose: () => void;
}

export const WithdrawalModal: FC<WithdrawalModalProps> = ({ pool, position, onWithdraw, onClose }) => {
  const [step, setStep] = useState<Step>("input");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const depositedNum = parseFloat(position.deposited);
  const amountNum = parseFloat(amount) || 0;
  const isValid = amountNum > 0 && amountNum <= depositedNum;

  const handleMax = useCallback(() => {
    setAmount(depositedNum.toFixed(2));
    setError(null);
  }, [depositedNum]);

  const handleQuickAmount = useCallback((pct: number) => {
    const raw = depositedNum * (pct / 100);
    setAmount(raw.toFixed(2));
    setError(null);
  }, [depositedNum]);

  const handleContinue = useCallback(() => {
    if (!isValid) {
      setError(amountNum <= 0 ? "Enter an amount" : "Amount exceeds deposited position");
      return;
    }
    setStep("review");
    setError(null);
  }, [isValid, amountNum]);

  const handleConfirm = useCallback(async () => {
    setStep("broadcasting");
    setError(null);
    try {
      await onWithdraw(amount);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setStep("review");
    }
  }, [amount, onWithdraw]);

  return (
    <Modal
      onClose={step === "broadcasting" ? () => {} : onClose}
      ariaLabelledBy="withdraw-modal-title"
      ariaDescribedBy="withdraw-modal-desc"
    >
      <div className="space-y-5">
        <h2 id="withdraw-modal-title" className="text-xl font-bold text-white">Withdraw</h2>
        <p id="withdraw-modal-desc" className="sr-only">
          Enter the amount of assets you wish to withdraw from the prize pool.
        </p>

        {step === "input" && (
          <div className="space-y-4">
            <div>
              <label htmlFor="withdraw-amount" className="block text-sm font-medium text-gray-300">
                Amount
              </label>
              <div className="relative mt-1">
                <input
                  id="withdraw-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  max={depositedNum}
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setError(null); }}
                  className="w-full rounded-xl border border-red-900/40 bg-[#1A0505] px-4 py-3 pr-16 text-lg text-white placeholder-gray-600 outline-none transition-colors focus:border-red-500/60 focus:ring-1 focus:ring-red-500/30"
                  placeholder="0.00"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                  {pool.asset}
                </span>
              </div>
              <p className="mt-1 text-xs text-gray-500">
                Deposited: {formatAmount(position.deposited, pool.asset)}
              </p>
            </div>

            {amountNum > depositedNum && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-900/40 bg-amber-900/10 p-3 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Amount exceeds your deposited position</span>
              </div>
            )}

            <div className="flex gap-2">
              {QUICK_AMOUNTS.map((pct) => (
                <button
                  key={pct}
                  type="button"
                  onClick={() => handleQuickAmount(pct)}
                  className="flex-1 rounded-lg border border-red-900/30 px-3 py-2 text-sm font-medium text-gray-300 transition-colors hover:bg-red-900/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
                >
                  {pct}%
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleMax}
              className="w-full rounded-lg border border-red-600/40 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
            >
              Withdraw all ({formatAmount(position.deposited, pool.asset)})
            </button>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button
              type="button"
              onClick={handleContinue}
              disabled={!isValid}
              className="w-full rounded-xl bg-red-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
            >
              Continue
            </button>
          </div>
        )}

        {step === "review" && (
          <div className="space-y-4">
            <div className="rounded-xl border border-red-900/30 bg-[#1A0505]/60 p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Amount</span>
                <span className="text-white font-semibold">{formatAmount(amount, pool.asset)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Pool</span>
                <span className="text-white">{pool.name}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Remaining deposit</span>
                <span className="text-white">
                  {formatAmount(String(Math.max(0, depositedNum - amountNum)), pool.asset)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Est. gas</span>
                <span className="text-white">~0.001 XLM</span>
              </div>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep("input")}
                className="flex-1 rounded-xl border border-red-900/30 py-3 text-sm font-semibold text-gray-300 transition-colors hover:bg-red-900/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                className="flex-1 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
              >
                Confirm withdrawal
              </button>
            </div>
          </div>
        )}

        {step === "broadcasting" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-red-500/30">
              {error ? (
                <AlertTriangle className="h-8 w-8 text-red-400" />
              ) : (
                <Loader2 className="h-8 w-8 animate-spin text-red-400" />
              )}
            </div>
            <p className="text-base font-semibold text-white">
              {error ? "Transaction failed" : "Broadcasting withdrawal..."}
            </p>
            <p className="text-sm text-gray-400 text-center max-w-xs">
              {error
                ? error
                : "Please check your wallet to approve the transaction."}
            </p>
            {error && (
              <button
                type="button"
                onClick={() => { setStep("review"); setError(null); }}
                className="rounded-xl bg-red-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
              >
                Try again
              </button>
            )}
            {!error && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <Check className="h-4 w-4 text-emerald-400" />
                <span>Waiting for wallet confirmation</span>
              </div>
            )}
          </div>
        )}

        {step === "success" && (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shadow-glow-green">
              <Check className="h-8 w-8" />
            </div>
            <p className="text-base font-semibold text-white">
              Withdrawal successful!
            </p>
            <p className="text-sm text-gray-400 text-center max-w-xs">
              Your withdrawal of {formatAmount(amount, pool.asset)} from the pool has been successfully confirmed.
            </p>
            <div className="w-full divide-y divide-red-900/20 rounded-xl border border-red-900/30 bg-[#1A0505]/40 px-4 py-2 text-xs">
              <div className="flex justify-between py-1.5">
                <span className="text-gray-400">Pool</span>
                <span className="text-white font-medium">{pool.name}</span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-gray-400">Remaining deposit</span>
                <span className="text-white font-semibold">
                  {formatAmount(String(Math.max(0, depositedNum - amountNum)), pool.asset)}
                </span>
              </div>
              <div className="flex justify-between py-1.5">
                <span className="text-gray-400">Status</span>
                <span className="text-emerald-400 font-bold">Confirmed</span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl bg-red-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default WithdrawalModal;
