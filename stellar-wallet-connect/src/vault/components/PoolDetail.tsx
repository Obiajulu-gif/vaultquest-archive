import type { FC, ReactNode } from "react";
import { useStore } from "@nanostores/react";
import { Bookmark, Coins, Trophy, Users } from "lucide-react";
import {
  ErrorState,
  LoadingState,
  WalletDisconnectedState,
} from "../../components/FallbackStates";
import { DataRefreshControl } from "../../components/DataRefreshControl";
import type { PoolActionType, PoolStatus, PoolSummary, UserPosition } from "../contract/types";
import { formatAmount, formatDate, truncateAddress } from "../lib/format";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { isNetworkMismatch } from "../../core/store.js";
import { NetworkDiagnostics } from "../../components/NetworkDiagnostics";
import { TransactionTimeline } from "../../components/TransactionTimeline";
import type { TxFlowResult } from "../lib/txStateMachine";
import PoolStatusBadge from "./PoolStatusBadge";

/**
 * Pool detail view (#73): overview, the connected user's position, and the
 * actions available from the current pool state. Presentational — pair it with
 * `usePoolDetail` for data. Handles loading / stale / error / wallet states and
 * is responsive (stacked on mobile, two columns on desktop).
 */

export interface PoolDetailProps {
  pool: PoolSummary | null;
  position?: UserPosition | null;
  loading?: boolean;
  stale?: boolean;
  error?: string | null;
  walletConnected?: boolean;
  onConnect?: () => void;
  onRetry?: () => void;
  /** Invoked when the user triggers a pool action. */
  onAction?: (type: PoolActionType) => void;
  /** Optional saved-pool toggle for watchlist workflows. */
  onToggleSaved?: () => void;
  saved?: boolean;
  savingSavedState?: boolean;
  showOnboarding?: boolean;
  /** When provided, renders an inline transaction timeline below the action buttons. */
  txFlow?: TxFlowResult;
  updatedAt?: number | null;
  fetching?: boolean;
  partialError?: Error | null;
  refetch?: () => void;
}

const Stat: FC<{ icon: ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="rounded-xl border border-red-900/30 bg-[#1A0505]/60 p-3 sm:p-4">
    <div className="flex items-center gap-2 text-[10px] sm:text-xs uppercase tracking-wide text-gray-400">
      {icon}
      {label}
    </div>
    <p className="mt-1 text-base sm:text-lg font-semibold text-white truncate" title={value}>{value}</p>
  </div>
);

/** Actions available to the connected user given pool state and position. */
export function availableActions(pool: PoolSummary, position: UserPosition | null): PoolActionType[] {
  const joined = position?.joined ?? false;
  switch (pool.status) {
    case "open":
      return joined ? ["drip", "withdraw"] : ["join"];
    case "locked":
      return joined ? ["withdraw"] : [];
    case "settled":
      return joined ? ["claim", "withdraw"] : [];
    case "drawing":
    default:
      return [];
  }
}

const ACTION_LABEL: Record<PoolActionType, string> = {
  create: "Create pool",
  join: "Join pool",
  drip: "Add deposit",
  claim: "Claim reward",
  withdraw: "Withdraw",
};

export const PoolDetail: FC<PoolDetailProps> = ({
  pool,
  position = null,
  loading = false,
  stale = false,
  error = null,
  walletConnected = true,
  onConnect,
  onRetry,
  onAction,
  onToggleSaved,
  saved = false,
  savingSavedState = false,
  showOnboarding = true,
  txFlow,
  updatedAt = null,
  fetching = false,
  partialError = null,
  refetch = () => {},
}) => {
  const mismatch = useStore(isNetworkMismatch);

  if (error) {
    return <ErrorState title="Couldn't load pool" message={error} onRetry={onRetry} />;
  }
  if (loading && pool === null) {
    return <LoadingState label="Loading pool…" />;
  }
  if (pool === null) {
    return <ErrorState title="Pool unavailable" message="This pool could not be found." onRetry={onRetry} />;
  }

  const actions = walletConnected ? availableActions(pool, position) : [];

  return (
    <section aria-label={`Pool ${pool.name}`} className="space-y-6">
      {showOnboarding && <OnboardingChecklist />}

      <NetworkDiagnostics />

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-white">{pool.name}</h1>
          <PoolStatusBadge status={pool.status} />
        </div>
        <div className="flex items-center gap-3">
          {walletConnected && onToggleSaved && (
            <button
              type="button"
              onClick={onToggleSaved}
              disabled={savingSavedState}
              className="inline-flex items-center gap-2 rounded-xl border border-red-500/30 px-4 py-2 text-sm font-semibold text-white hover:bg-red-900/20 disabled:cursor-not-allowed disabled:opacity-60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
            >
              <Bookmark className="h-4 w-4" aria-hidden="true" />
              {savingSavedState ? "Saving…" : saved ? "Unsave pool" : "Save pool"}
            </button>
          )}
          <DataRefreshControl
            updatedAt={updatedAt}
            stale={stale}
            fetching={fetching}
            partialError={partialError}
            onRefresh={refetch}
          />
        </div>
      </header>

      {/* Overview */}
      <div className="grid grid-cols-1 xs:grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat icon={<Coins className="h-3.5 w-3.5" aria-hidden="true" />} label="TVL" value={formatAmount(pool.tvl, pool.asset)} />
        <Stat icon={<Users className="h-3.5 w-3.5" aria-hidden="true" />} label="Participants" value={String(pool.participantCount)} />
        <Stat icon={<Trophy className="h-3.5 w-3.5" aria-hidden="true" />} label="Expected yield" value={pool.expectedYield} />
        <Stat icon={<Trophy className="h-3.5 w-3.5" aria-hidden="true" />} label="Prize" value={pool.prize ?? "—"} />
      </div>

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
        <div className="flex justify-between gap-2 sm:flex-col">
          <dt className="text-gray-400">Opens</dt>
          <dd className="text-gray-200">{formatDate(pool.opensAt)}</dd>
        </div>
        <div className="flex justify-between gap-2 sm:flex-col">
          <dt className="text-gray-400">Locks</dt>
          <dd className="text-gray-200">{formatDate(pool.locksAt)}</dd>
        </div>
        <div className="flex justify-between gap-2 sm:flex-col">
          <dt className="text-gray-400">Draws</dt>
          <dd className="text-gray-200">{formatDate(pool.drawsAt)}</dd>
        </div>
      </dl>

      {/* User position */}
      <div className="rounded-2xl border border-red-900/30 bg-[#1A0505]/60 p-5">
        <h2 className="text-lg font-semibold text-white">Your position</h2>
        {!walletConnected ? (
          <div className="mt-3">
            <WalletDisconnectedState onConnect={onConnect} />
          </div>
        ) : position?.joined ? (
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-gray-400">Deposited</dt>
              <dd className="text-base font-semibold text-white">{formatAmount(position.deposited, pool.asset)}</dd>
            </div>
            <div>
              <dt className="text-gray-400">Shares</dt>
              <dd className="text-base font-semibold text-white">{formatAmount(position.shares)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-gray-400">Wallet</dt>
              <dd className="font-mono text-gray-200">{truncateAddress(position.walletAddress)}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-gray-400">You haven't joined this pool yet.</p>
        )}
      </div>

      {/* Actions */}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => !mismatch && onAction?.(action)}
              disabled={mismatch || txFlow?.busy}
              className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505] ${
                mismatch
                  ? "bg-gray-600 opacity-50 cursor-not-allowed focus-visible:ring-gray-400"
                  : "bg-red-600 hover:bg-red-700 focus-visible:ring-red-400"
              }`}
              title={mismatch ? "Actions blocked due to network mismatch" : ACTION_LABEL[action]}
            >
              {ACTION_LABEL[action]}
            </button>
          ))}
        </div>
      )}

      {/* Inline transaction timeline (shown when a txFlow is wired in) */}
      {txFlow && txFlow.state.stage !== "idle" && (
        <TransactionTimeline
          stage={txFlow.state.stage === "failed" ? "failed" : txFlow.state.stage as import("../../components/TransactionTimeline").TimelineStage}
          failedAtStage={txFlow.state.stage === "failed" ? txFlow.state.failedAt : undefined}
          txHash={"txHash" in txFlow.state ? txFlow.state.txHash : undefined}
          errorMessage={txFlow.state.stage === "failed" ? txFlow.state.message : undefined}
          onRetry={txFlow.state.stage === "failed" ? txFlow.reset : undefined}
          onDismiss={txFlow.state.stage === "success" || txFlow.state.stage === "failed" ? txFlow.reset : undefined}
        />
      )}
    </section>
  );
};

export default PoolDetail;
