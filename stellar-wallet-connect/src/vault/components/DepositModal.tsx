import type { FC } from "react";
import { useState, useCallback, useMemo } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import Modal from "../../components/Modal";
import type { PoolSummary } from "../contract/types";
import { formatAmount } from "../lib/format";
import { calculateDepositPreview } from "../lib/depositPreview";


type Step = "input" | "review" | "broadcasting" | "success";

export interface DepositModalProps {
  pool: PoolSummary;
  walletBalance: string;
  /**
   * This wallet's cumulative principal already deposited into `pool`
   * (#643) — needed to compute remaining per-wallet headroom under
   * `pool.maxWalletDeposit`. Omitted (or "0") when the caller hasn't joined
   * the pool yet, or when the pool has no per-wallet cap to check against.
   */
  walletDeposited?: string;
  onDeposit: (amount: string) => Promise<void>;
  onRefreshBalance?: () => Promise<void>;
  onClose: () => void;
}

const QUICK_AMOUNTS = [25, 50, 75] as const;
const GAS_BUFFER = 0.5;

/** "0"/undefined means uncapped, matching the contract's own convention. */
function parseCap(value: string | undefined): number | null {
  const parsed = parseFloat(value ?? "0");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function estimateWinChanceChange(currentTvl: bigint, depositAmount: bigint, participantCount: number): string {
  if (currentTvl === 0n) return "50%";
  const currentShare = BigInt(participantCount) * 10000n / (currentTvl / 10000n + 1n);
  const newShare = BigInt(participantCount + 1) * 10000n / ((currentTvl + depositAmount) / 10000n + 1n);
  const change = newShare > currentShare ? newShare - currentShare : currentShare - newShare;
  return `${(Number(change) / 100).toFixed(2)}%`;
}

export const DepositModal: FC<DepositModalProps> = ({
  pool,
  walletBalance,
  walletDeposited,
  onDeposit,
  onRefreshBalance,
  onClose,
}) => {
  const [step, setStep] = useState<Step>("input");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const balanceNum = parseFloat(walletBalance);
  const amountNum = parseFloat(amount) || 0;
  const exceedsBalance = amountNum > balanceNum - GAS_BUFFER;

  // Deposit concentration limits (#643) — a client-side preview of the same
  // caps the contract enforces authoritatively. This can never be fully
  // race-proof (another deposit can land on-chain between this render and
  // the user's signature), so `onDeposit`'s rejection path is still the
  // backstop of record; this exists so a user sees "this won't fit" before
  // signing, rather than only after paying a fee for a reverted tx.
  const walletCap = parseCap(pool.maxWalletDeposit);
  const walletDepositedNum = parseFloat(walletDeposited ?? "0") || 0;
  const remainingWalletCapacity = walletCap === null ? null : Math.max(0, walletCap - walletDepositedNum);

  const poolCap = parseCap(pool.maxPoolDeposit);
  const remainingPoolCapacity =
    pool.remainingPoolCapacity !== undefined
      ? Math.max(0, parseFloat(pool.remainingPoolCapacity) || 0)
      : poolCap === null
        ? null
        : Math.max(0, poolCap - (parseFloat(pool.tvl) || 0));

  const exceedsWalletCap = remainingWalletCapacity !== null && amountNum > remainingWalletCapacity;
  const exceedsPoolCap = remainingPoolCapacity !== null && amountNum > remainingPoolCapacity;

  const remainingBalance = useMemo(() => Math.max(0, balanceNum - amountNum - GAS_BUFFER), [balanceNum, amountNum]);
  const isValid = amountNum > 0 && !exceedsBalance && !exceedsWalletCap && !exceedsPoolCap;

  // Deposit preview simulation (#685)
  const depositPreview = useMemo(() => calculateDepositPreview(pool, amount), [pool, amount]);


  // The tightest of wallet balance, per-wallet cap, and pool-wide cap —
  // what "Max" should actually fill in, and what quick-amount percentages
  // are computed against, so those shortcuts never propose an amount the
  // deposit is going to reject anyway.
  const maxDepositable = useMemo(() => {
    const candidates = [Math.max(0, balanceNum - GAS_BUFFER)];
    if (remainingWalletCapacity !== null) candidates.push(remainingWalletCapacity);
    if (remainingPoolCapacity !== null) candidates.push(remainingPoolCapacity);
    return Math.min(...candidates);
  }, [balanceNum, remainingWalletCapacity, remainingPoolCapacity]);

  const handleRefresh = useCallback(async () => {
    if (!onRefreshBalance) return;
    setRefreshing(true);
    try {
      await onRefreshBalance();
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshBalance]);

  const handleQuickAmount = useCallback((pct: number) => {
    const raw = maxDepositable * (pct / 100);
    setAmount(raw.toFixed(2));
    setError(null);
  }, [maxDepositable]);

  const handleMax = useCallback(() => {
    setAmount(maxDepositable.toFixed(2));
    setError(null);
  }, [maxDepositable]);

  const handleContinue = useCallback(async () => {
    if (!isValid) {
      if (amountNum === 0) {
        setError("Enter an amount");
      } else if (exceedsWalletCap) {
        setError(
          `Exceeds your per-wallet limit for this pool (${formatAmount(String(remainingWalletCapacity), pool.asset)} remaining)`,
        );
      } else if (exceedsPoolCap) {
        setError(
          `Exceeds this pool's remaining capacity (${formatAmount(String(remainingPoolCapacity), pool.asset)} remaining)`,
        );
      } else {
        setError("Insufficient balance (leave buffer for gas)");
      }
      return;
    }
    // Refresh pool/balance state before locking in the numbers shown on the
    // review step. Without this, a user who opens the modal and waits could
    // confirm a deposit against a stale pool.tvl/participantCount snapshot
    // from whenever the modal first mounted (#619).
    if (onRefreshBalance) {
      setRefreshing(true);
      try {
        await onRefreshBalance();
      } finally {
        setRefreshing(false);
      }
    }
    setStep("review");
    setError(null);
  }, [
    isValid,
    amountNum,
    exceedsWalletCap,
    exceedsPoolCap,
    remainingWalletCapacity,
    remainingPoolCapacity,
    pool.asset,
    onRefreshBalance,
  ]);

  const handleConfirm = useCallback(async () => {
    setStep("broadcasting");
    setError(null);
    try {
      await onDeposit(amount);
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
      setStep("review");
    }
  }, [amount, onDeposit]);

  return (
    <Modal
      onClose={step === "broadcasting" ? () => {} : onClose}
      ariaLabelledBy="deposit-modal-title"
      ariaDescribedBy="deposit-modal-desc"
    >
      <div className="space-y-5">
        <h2 id="deposit-modal-title" className="text-xl font-bold text-white">Deposit</h2>
        <p id="deposit-modal-desc" className="sr-only">
          Enter the amount of assets you wish to deposit into the prize pool.
        </p>

        {step === "input" && (
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <label htmlFor="deposit-amount" className="block text-sm font-medium text-gray-300">
                  Amount
                </label>
                {onRefreshBalance && (
                  <button
                    type="button"
                    onClick={handleRefresh}
                    disabled={refreshing}
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
                    aria-label="Refresh wallet balance"
                  >
                    <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                )}
              </div>
              <div className="relative mt-1">
                <input
                  id="deposit-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => { setAmount(e.target.value); setError(null); }}
                  className="w-full rounded-xl border border-red-900/40 bg-[#1A0505] px-4 py-3 pr-16 text-lg text-white placeholder-gray-600 outline-none transition-colors focus:border-red-500/60 focus:ring-1 focus:ring-red-500/30"
                  placeholder="0.00"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                  {pool.asset}
                </span>
              </div>
            </div>

            {/* Balance impact preview */}
            <div className="rounded-xl border border-red-900/20 bg-[#1A0505]/40 p-3 space-y-1.5">
              <p className="text-xs font-medium text-gray-400">Balance impact</p>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Current balance</span>
                <span className="text-gray-300">{formatAmount(walletBalance, pool.asset)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Deposit amount</span>
                <span className="text-red-400">-{amountNum > 0 ? formatAmount(String(amountNum), pool.asset) : `0.00 ${pool.asset}`}</span>
              </div>
              <div className="flex justify-between text-xs border-t border-red-900/20 pt-1.5">
                <span className="font-medium text-gray-300">Remaining after deposit</span>
                <span className={`font-semibold ${remainingBalance < 0 ? "text-red-400" : "text-emerald-400"}`}>
                  {formatAmount(String(remainingBalance), pool.asset)}
                </span>
              </div>
            </div>

            <p className="text-xs text-gray-500">
              Balance: {formatAmount(walletBalance, pool.asset)} · ~{GAS_BUFFER} {pool.asset} reserved for gas
            </p>

            {/* Deposit capacity preview (#643) — shown whenever this pool
                enforces a per-wallet or protocol-wide cap, so a user sees
                their real headroom before signing rather than only
                discovering it from a reverted transaction. */}
            {(remainingWalletCapacity !== null || remainingPoolCapacity !== null) && (
              <div
                className="rounded-xl border border-red-900/20 bg-[#1A0505]/40 p-3 space-y-1.5"
                data-testid="deposit-capacity-preview"
              >
                <p className="text-xs font-medium text-gray-400">Deposit capacity</p>
                {remainingWalletCapacity !== null && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Your remaining limit</span>
                    <span className={exceedsWalletCap ? "text-red-400" : "text-gray-300"}>
                      {formatAmount(String(remainingWalletCapacity), pool.asset)}
                    </span>
                  </div>
                )}
                {remainingPoolCapacity !== null && (
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-500">Pool remaining capacity</span>
                    <span className={exceedsPoolCap ? "text-red-400" : "text-gray-300"}>
                      {formatAmount(String(remainingPoolCapacity), pool.asset)}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Post-deposit vault state preview (#685) */}
            {amountNum > 0 && (
              <div className="rounded-xl border border-red-900/20 bg-[#1A0505]/40 p-3 space-y-2" data-testid="deposit-simulation-preview">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-gray-400">Post-deposit pool state preview</p>
                  <span className="text-[10px] uppercase font-semibold text-gray-500">Simulated</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Post-deposit TVL</span>
                  <span className="text-gray-300 font-medium">{formatAmount(String(depositPreview.postDepositTvl), pool.asset)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Strategy exposure</span>
                  <span className="text-gray-300">
                    {(depositPreview.currentStrategyExposureBps / 100).toFixed(1)}% → <strong className="text-white">{(depositPreview.postDepositStrategyExposureBps / 100).toFixed(1)}%</strong>
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500">Idle pool liquidity</span>
                  <span className="text-emerald-400 font-medium">
                    {formatAmount(String(depositPreview.postDepositIdleLiquidity), pool.asset)} ({(depositPreview.postDepositIdleRatioBps / 100).toFixed(1)}%)
                  </span>
                </div>
                {depositPreview.queuedWithdrawals > 0 && (
                  <div className="flex justify-between text-xs border-t border-red-900/20 pt-1.5">
                    <span className="text-gray-500">Queued withdrawals coverage</span>
                    <span className={depositPreview.queueDeficit > 0 ? "text-amber-400 font-medium" : "text-emerald-400 font-medium"}>
                      {depositPreview.queueCoverageRatio === Number.POSITIVE_INFINITY
                        ? "100%"
                        : `${Math.min(100, Math.round(depositPreview.queueCoverageRatio * 100))}%`}
                      {depositPreview.queueDeficit > 0 && ` (${formatAmount(String(depositPreview.queueDeficit), pool.asset)} deficit)`}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Risk Warning Banners (#685) */}
            {depositPreview.warnings.map((warning) => (
              <div
                key={warning.code}
                className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                  warning.severity === "danger"
                    ? "border-red-900/60 bg-red-900/20 text-red-300"
                    : "border-amber-900/40 bg-amber-900/10 text-amber-300"
                }`}
                data-testid={`risk-warning-${warning.code.toLowerCase().replace(/_/g, "-")}`}
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-semibold text-xs uppercase tracking-wider">
                    {warning.code === "HIGH_STRATEGY_EXPOSURE"
                      ? "High Strategy Risk"
                      : warning.code === "LOW_IDLE_LIQUIDITY"
                        ? "Low Idle Reserves"
                        : "Queued Withdrawal Pressure"}
                  </p>
                  <p className="mt-0.5 text-xs">{warning.message}</p>
                </div>
              </div>
            ))}


            {exceedsBalance && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-900/40 bg-amber-900/10 p-3 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>Amount exceeds available balance (leave ~{GAS_BUFFER} {pool.asset} for gas)</span>
              </div>
            )}

            {!exceedsBalance && exceedsWalletCap && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-900/40 bg-amber-900/10 p-3 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Amount exceeds your per-wallet limit for this pool ({formatAmount(String(remainingWalletCapacity), pool.asset)} remaining)
                </span>
              </div>
            )}

            {!exceedsBalance && !exceedsWalletCap && exceedsPoolCap && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-900/40 bg-amber-900/10 p-3 text-sm text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Amount exceeds this pool's remaining capacity ({formatAmount(String(remainingPoolCapacity), pool.asset)} remaining)
                </span>
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
              <button
                type="button"
                onClick={handleMax}
                className="flex-1 rounded-lg border border-red-600/40 px-3 py-2 text-sm font-medium text-red-400 transition-colors hover:bg-red-900/20 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
              >
                Max
              </button>
            </div>

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            <button
              type="button"
              onClick={handleContinue}
              disabled={!isValid || refreshing}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
            >
              {refreshing && <Loader2 className="h-4 w-4 animate-spin" />}
              {refreshing ? "Refreshing pool data..." : "Continue"}
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
                <span className="text-gray-400">Lock period</span>
                <span className="text-white">Until {pool.locksAt ? new Date(pool.locksAt).toLocaleDateString() : "N/A"}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Est. gas</span>
                <span className="text-white">~0.001 XLM</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Post-deposit strategy exposure</span>
                <span className="text-white font-medium">
                  {(depositPreview.postDepositStrategyExposureBps / 100).toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Post-deposit idle reserve</span>
                <span className="text-emerald-400 font-medium">
                  {formatAmount(String(depositPreview.postDepositIdleLiquidity), pool.asset)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">Win chance change</span>
                <span className="text-emerald-400 font-semibold">
                  +{estimateWinChanceChange(BigInt(pool.tvl || "0"), BigInt(Math.round(amountNum * 1e7)), pool.participantCount)}
                </span>
              </div>

            </div>

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

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
                Confirm deposit
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
              {error ? "Transaction failed" : "Broadcasting deposit..."}
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
              Deposit successful!
            </p>
            <p className="text-sm text-gray-400 text-center max-w-xs">
              Your deposit of {amount} {pool.asset} has been successfully submitted and confirmed on-chain.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-red-600 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};

export default DepositModal;
