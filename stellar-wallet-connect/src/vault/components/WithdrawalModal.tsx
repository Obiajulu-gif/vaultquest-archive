import type { FC } from "react";
import { useState, useCallback } from "react";
import { AlertTriangle, Check, Clock, Loader2 } from "lucide-react";
import Modal from "../../components/Modal";
import { ContractInterfaceError, type PoolSummary, type UserPosition } from "../contract/types";
import { formatAmount } from "../lib/format";

type Step = "input" | "review" | "broadcasting" | "success";

/**
 * Withdrawal failure classes the modal renders distinctly (#620).
 *
 * `lockup_active` and `insufficient_liquidity` are expected, recoverable
 * contract-level outcomes (mirroring `Error::LockupActive` and the
 * withdrawal-queue flow in contracts/drip-pool/src/lib.rs) — very different
 * from a generic wallet/RPC/contract failure, so they get their own heading,
 * icon, and tone instead of collapsing into "Transaction failed".
 */
type WithdrawalErrorKind = "lockup_active" | "insufficient_liquidity" | "generic";

const QUICK_AMOUNTS = [25, 50, 75] as const;

/**
 * Outcome of a submitted withdrawal (#654). The contract's `withdraw()`
 * enqueues a FIFO request (returning `0`, event `wq queued`) instead of
 * paying out immediately when idle pool liquidity can't cover it -- e.g.
 * because principal is deployed to a yield strategy. Callers that can tell
 * the two apart (a queued vs. immediately fulfilled withdrawal) should
 * report it here so the UI doesn't call a queued request "Confirmed."
 * Omitting this (or resolving with `undefined`) preserves the previous
 * always-immediate behavior for callers that can't yet distinguish them.
 */
export interface WithdrawalOutcome {
  queued: boolean;
}

export interface WithdrawalModalProps {
  pool: PoolSummary;
  position: UserPosition;
  onWithdraw: (amount: string) => Promise<WithdrawalOutcome | void>;
  onClose: () => void;
}

function classifyWithdrawalError(err: unknown): WithdrawalErrorKind {
  if (err instanceof ContractInterfaceError) {
    if (err.kind === "lockup_active") return "lockup_active";
    if (err.kind === "insufficient_liquidity") return "insufficient_liquidity";
  }
  return "generic";
}

export const WithdrawalModal: FC<WithdrawalModalProps> = ({ pool, position, onWithdraw, onClose }) => {
  const [step, setStep] = useState<Step>("input");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [errorKind, setErrorKind] = useState<WithdrawalErrorKind>("generic");

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
      setErrorKind("generic");
      return;
    }
    setStep("review");
    setError(null);
  }, [isValid, amountNum]);

  const handleConfirm = useCallback(async () => {
    setStep("broadcasting");
    setError(null);
    setErrorKind("generic");
    try {
      const outcome = await onWithdraw(amount);
      setQueued(outcome?.queued ?? false);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setErrorKind(classifyWithdrawalError(err));
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

            {error && (errorKind === "lockup_active" || errorKind === "insufficient_liquidity") && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-900/40 bg-amber-900/10 p-3 text-sm text-amber-300">
                <Clock className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-semibold">
                    {errorKind === "lockup_active" ? "Still in lockup" : "Withdrawal queued"}
                  </p>
                  <p className="mt-0.5 text-amber-300/90">
                    {errorKind === "lockup_active"
                      ? "Your deposit is still within its lockup period and can't be withdrawn yet."
                      : "The pool doesn't have enough available liquidity to settle this withdrawal immediately. Your request has been queued and will settle once liquidity is available."}
                    {" "}
                    {error}
                  </p>
                </div>
              </div>
            )}
            {error && errorKind === "generic" && <p className="text-sm text-red-400">{error}</p>}

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
            <div
              className={`flex h-16 w-16 items-center justify-center rounded-full border-2 ${
                errorKind === "lockup_active" || errorKind === "insufficient_liquidity"
                  ? "border-amber-500/30"
                  : "border-red-500/30"
              }`}
            >
              {errorKind === "lockup_active" || errorKind === "insufficient_liquidity" ? (
                <Clock className="h-8 w-8 text-amber-400" />
              ) : error ? (
                <AlertTriangle className="h-8 w-8 text-red-400" />
              ) : (
                <Loader2 className="h-8 w-8 animate-spin text-red-400" />
              )}
            </div>
            <p className="text-base font-semibold text-white">
              {errorKind === "lockup_active"
                ? "Still in lockup"
                : errorKind === "insufficient_liquidity"
                  ? "Withdrawal queued"
                  : error
                    ? "Transaction failed"
                    : "Broadcasting withdrawal..."}
            </p>
            <p className="text-sm text-gray-400 text-center max-w-xs">
              {errorKind === "lockup_active"
                ? "Your deposit is still within its lockup period and can't be withdrawn yet. " +
                  (error ?? "Try again after the lockup ends.")
                : errorKind === "insufficient_liquidity"
                  ? "The pool doesn't have enough available liquidity to settle this withdrawal immediately. " +
                    (error ?? "Your request has been queued and will settle once liquidity is available.")
                  : error
                    ? error
                    : "Please check your wallet to approve the transaction."}
            </p>
            {error && (
              <button
                type="button"
                onClick={() => { setStep("review"); setError(null); setErrorKind("generic"); }}
                className="rounded-xl bg-red-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
              >
                {errorKind === "lockup_active" || errorKind === "insufficient_liquidity" ? "Back" : "Try again"}
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
            <div
              className={
                queued
                  ? "flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  : "flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 shadow-glow-green"
              }
            >
              {queued ? <Clock className="h-8 w-8" /> : <Check className="h-8 w-8" />}
            </div>
            <p className="text-base font-semibold text-white">
              {queued ? "Withdrawal queued" : "Withdrawal successful!"}
            </p>
            <p className="text-sm text-gray-400 text-center max-w-xs">
              {queued
                ? `Your withdrawal of ${formatAmount(amount, pool.asset)} was added to the pool's withdrawal queue because idle liquidity couldn't cover it right now. It will be paid out automatically as liquidity becomes available -- no action needed.`
                : `Your withdrawal of ${formatAmount(amount, pool.asset)} from the pool has been successfully confirmed.`}
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
                {queued ? (
                  <span className="text-amber-400 font-bold">Queued</span>
                ) : (
                  <span className="text-emerald-400 font-bold">Confirmed</span>
                )}
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
