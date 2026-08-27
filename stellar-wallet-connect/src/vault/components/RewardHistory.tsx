import type { FC } from "react";
import { ExternalLink, History, Trophy } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  WalletDisconnectedState,
} from "../../components/FallbackStates";
import { DataRefreshControl } from "../../components/DataRefreshControl";
import type { RewardHistoryEntry, RewardOutcome, ProofStatus } from "../contract/types";
import { explorerTxUrl, formatAmount, formatDate, truncateAddress, type StellarNetwork } from "../lib/format";
import { TransactionTimeline } from "../../components/TransactionTimeline";
import type { TxFlowResult } from "../lib/txStateMachine";

/**
 * Reward history for completed pool cycles (#75).
 *
 * Presentational: pair it with `useRewardHistory` (or any adapter) for data.
 * Handles loading, empty, stale, error, and wallet-disconnected states; shows
 * truncated wallet addresses and explorer links where a tx reference exists.
 * Responsive — a table on desktop, stacked cards on mobile.
 */

export interface RewardHistoryProps {
  entries: RewardHistoryEntry[] | null;
  loading?: boolean;
  stale?: boolean;
  error?: string | null;
  walletConnected?: boolean;
  network?: StellarNetwork;
  onRetry?: () => void;
  onConnect?: () => void;
  /** When provided, renders an inline claim transaction timeline and wires claim buttons. */
  claimFlow?: TxFlowResult;
  onClaim?: (entry: RewardHistoryEntry) => void;
  updatedAt?: number | null;
  fetching?: boolean;
  partialError?: Error | null;
  refetch?: () => void;
}

const OUTCOME_BADGE: Record<RewardOutcome, { label: string; className: string }> = {
  won: { label: "Won", className: "bg-emerald-500/15 text-emerald-300" },
  no_win: { label: "No win", className: "bg-gray-500/15 text-gray-300" },
  pending: { label: "Pending", className: "bg-amber-500/15 text-amber-300" },
};

const OutcomeBadge: FC<{ status: RewardOutcome }> = ({ status }) => {
  const badge = OUTCOME_BADGE[status];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
};

const PROOF_BADGE: Record<ProofStatus, { label: string; className: string; title: string }> = {
  verified: { label: "Proof ✓", className: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30", title: "Draw proof verified" },
  tampered: { label: "Proof ✗", className: "bg-red-500/10 text-red-400 border border-red-500/30", title: "Draw proof integrity check failed" },
  missing: { label: "No proof", className: "bg-gray-500/10 text-gray-400 border border-gray-600/30", title: "No draw proof found for this round" },
  pending: { label: "Proof pending", className: "bg-amber-500/10 text-amber-400 border border-amber-500/30", title: "Draw proof not yet available" },
  unverified: { label: "Proof ?", className: "bg-gray-500/10 text-gray-400 border border-gray-600/30", title: "Proof present but could not be fully verified" },
};

const CLAIM_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  claimed: { label: "Claimed", className: "bg-emerald-500/10 text-emerald-400" },
  pending: { label: "Claim pending", className: "bg-amber-500/10 text-amber-400" },
  unclaimed: { label: "Unclaimed", className: "bg-gray-500/10 text-gray-300" },
  failed: { label: "Claim failed", className: "bg-red-500/10 text-red-400" },
};

const ProofBadge: FC<{ proofStatus: ProofStatus; detail?: string }> = ({ proofStatus, detail }) => {
  const badge = PROOF_BADGE[proofStatus];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}
      title={detail || badge.title}
      aria-label={detail || badge.title}
    >
      {badge.label}
    </span>
  );
};

const ClaimStatusBadge: FC<{ claimStatus: string }> = ({ claimStatus }) => {
  const badge = CLAIM_STATUS_BADGE[claimStatus] ?? { label: claimStatus, className: "bg-gray-500/10 text-gray-400" };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
      {badge.label}
    </span>
  );
};

const TxLink: FC<{ txHash: string | null; network: StellarNetwork }> = ({ txHash, network }) =>
  txHash ? (
    explorerTxUrl(txHash, network) ? (
      <a
        href={explorerTxUrl(txHash, network) ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sm text-red-300 hover:text-red-200 hover:underline"
      >
        {truncateAddress(txHash)}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    ) : (
      <span className="text-sm text-gray-300">{truncateAddress(txHash)}</span>
    )
  ) : (
    <span className="text-sm text-gray-500">—</span>
  );

export const RewardHistory: FC<RewardHistoryProps> = ({
  entries,
  loading = false,
  stale = false,
  error = null,
  walletConnected = true,
  network = "testnet",
  onRetry,
  onConnect,
  claimFlow,
  onClaim,
  updatedAt = null,
  fetching = false,
  partialError = null,
  refetch = () => {},
}) => {
  if (!walletConnected) {
    return <WalletDisconnectedState onConnect={onConnect} />;
  }
  if (error) {
    return <ErrorState title="Couldn't load reward history" message={error} onRetry={onRetry} />;
  }
  if (loading && (entries === null || entries.length === 0)) {
    return <LoadingState label="Loading reward history…" />;
  }
  if (entries === null || entries.length === 0) {
    return (
      <EmptyState
        icon={<History className="h-7 w-7" aria-hidden="true" />}
        title="No completed cycles yet"
        description="Once a pool cycle you joined completes, its reward outcome will appear here."
      />
    );
  }

  return (
    <section aria-label="Reward history" className="space-y-3">
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Trophy className="h-5 w-5 text-red-400" aria-hidden="true" />
          Reward history
        </h2>
        <DataRefreshControl
          updatedAt={updatedAt}
          stale={stale}
          fetching={fetching}
          partialError={partialError}
          onRefresh={refetch}
        />
      </header>

      {/* Desktop: table */}
      <div className="hidden overflow-hidden rounded-2xl border border-red-900/30 bg-[#1A0505]/60 sm:block">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-gray-400">
            <tr className="border-b border-red-900/30">
              <th scope="col" className="px-4 py-3 font-medium">Pool</th>
              <th scope="col" className="px-4 py-3 font-medium">Cycle ended</th>
              <th scope="col" className="px-4 py-3 font-medium">Reward</th>
              <th scope="col" className="px-4 py-3 font-medium">Winner</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 font-medium">Proof</th>
              <th scope="col" className="px-4 py-3 font-medium">Claim</th>
              <th scope="col" className="px-4 py-3 font-medium">Tx</th>
              {onClaim && <th scope="col" className="px-4 py-3 font-medium">Action</th>}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-red-900/20 last:border-0">
                <td className="px-4 py-3 font-medium text-white">{entry.poolName}</td>
                <td className="px-4 py-3 text-gray-300">{formatDate(entry.cycleEndedAt)}</td>
                <td className="px-4 py-3 text-gray-300">{formatAmount(entry.rewardAmount, entry.asset)}</td>
                <td className="px-4 py-3 font-mono text-gray-300">
                  {entry.winnerAddress ? truncateAddress(entry.winnerAddress) : "—"}
                </td>
                <td className="px-4 py-3"><OutcomeBadge status={entry.status} /></td>
                <td className="px-4 py-3">
                  {entry.proofStatus ? (
                    <ProofBadge proofStatus={entry.proofStatus} detail={entry.proofDetail} />
                  ) : (
                    <span className="text-gray-600 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {entry.claimStatus ? (
                    <ClaimStatusBadge claimStatus={entry.claimStatus} />
                  ) : (
                    <span className="text-gray-600 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-3"><TxLink txHash={entry.txHash} network={network} /></td>
                {onClaim && (
                  <td className="px-4 py-3">
                    {entry.status === "won" && !entry.txHash && (
                      <button
                        type="button"
                        onClick={() => onClaim(entry)}
                        disabled={claimFlow?.busy}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                      >
                        Claim
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards */}
      <ul className="space-y-3 sm:hidden">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded-2xl border border-red-900/30 bg-[#1A0505]/60 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-white">{entry.poolName}</span>
              <OutcomeBadge status={entry.status} />
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-gray-400">Cycle ended</dt>
                <dd className="text-gray-200">{formatDate(entry.cycleEndedAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-gray-400">Reward</dt>
                <dd className="text-gray-200">{formatAmount(entry.rewardAmount, entry.asset)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-gray-400">Winner</dt>
                <dd className="font-mono text-gray-200">
                  {entry.winnerAddress ? truncateAddress(entry.winnerAddress) : "—"}
                </dd>
              </div>
              {entry.proofStatus && (
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-400">Proof</dt>
                  <dd><ProofBadge proofStatus={entry.proofStatus} detail={entry.proofDetail} /></dd>
                </div>
              )}
              {entry.claimStatus && (
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-400">Claim</dt>
                  <dd><ClaimStatusBadge claimStatus={entry.claimStatus} /></dd>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <dt className="text-gray-400">Tx</dt>
                <dd><TxLink txHash={entry.txHash} network={network} /></dd>
              </div>
              {onClaim && entry.status === "won" && !entry.txHash && (
                <div className="pt-1">
                  <button
                    type="button"
                    onClick={() => onClaim(entry)}
                    disabled={claimFlow?.busy}
                    className="w-full rounded-lg bg-red-600 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    Claim reward
                  </button>
                </div>
              )}
            </dl>
          </li>
        ))}
      </ul>

      {/* Claim transaction timeline */}
      {claimFlow && claimFlow.state.stage !== "idle" && (
        <TransactionTimeline
          stage={claimFlow.state.stage === "failed" ? "failed" : claimFlow.state.stage as import("../../components/TransactionTimeline").TimelineStage}
          failedAtStage={claimFlow.state.stage === "failed" ? claimFlow.state.failedAt : undefined}
          txHash={"txHash" in claimFlow.state ? claimFlow.state.txHash : undefined}
          errorMessage={claimFlow.state.stage === "failed" ? claimFlow.state.message : undefined}
          onRetry={claimFlow.state.stage === "failed" ? claimFlow.reset : undefined}
          onDismiss={claimFlow.state.stage === "success" || claimFlow.state.stage === "failed" ? claimFlow.reset : undefined}
        />
      )}
    </section>
  );
};

export default RewardHistory;
