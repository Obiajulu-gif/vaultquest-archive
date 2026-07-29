import type { FC, ReactNode } from "react";
import { Bookmark, ExternalLink, Folder, Trash2 } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  WalletDisconnectedState,
} from "../../components/FallbackStates";
import { DataRefreshControl } from "../../components/DataRefreshControl";
import type { SavedPoolEntry, PoolStatus } from "../contract/types";
import { formatAmount, formatDate } from "../lib/format";
import PoolStatusBadge from "./PoolStatusBadge";

/**
 * Saved pools watchlist (#89, #90).
 *
 * Presentational dashboard section for bookmarked pools. Use it with
 * `useSavedPools` for data and mutations. Handles loading, empty, error,
 * stale, and wallet-disconnected states; renders a compact table on desktop
 * and stacked cards on mobile.
 */

export interface SavedPoolsWatchlistProps {
  entries: SavedPoolEntry[] | null;
  loading?: boolean;
  stale?: boolean;
  error?: string | null;
  walletConnected?: boolean;
  onRetry?: () => void;
  onConnect?: () => void;
  onOpenPool?: (poolId: string) => void;
  onUnsave?: (entry: SavedPoolEntry) => void;
  savingPoolId?: string | null;
  updatedAt?: number | null;
  fetching?: boolean;
  partialError?: Error | null;
  refetch?: () => void;
}

const HeaderIcon: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-900/20 text-red-300">
    {children}
  </div>
);

export const SavedPoolsWatchlist: FC<SavedPoolsWatchlistProps> = ({
  entries,
  loading = false,
  stale = false,
  error = null,
  walletConnected = true,
  onRetry,
  onConnect,
  onOpenPool,
  onUnsave,
  savingPoolId = null,
  updatedAt = null,
  fetching = false,
  partialError = null,
  refetch = () => {},
}) => {
  if (!walletConnected) {
    return <WalletDisconnectedState onConnect={onConnect} />;
  }
  if (error) {
    return <ErrorState title="Couldn't load saved pools" message={error} onRetry={onRetry} />;
  }
  if (loading && (entries === null || entries.length === 0)) {
    return <LoadingState label="Loading saved pools…" />;
  }
  if (entries === null || entries.length === 0) {
    return (
      <EmptyState
        icon={<Folder className="h-7 w-7" aria-hidden="true" />}
        title="No saved pools yet"
        description="Save a pool from its detail page to keep it pinned here for quick return visits."
      />
    );
  }

  return (
    <section aria-label="Saved pools watchlist" className="space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <HeaderIcon>
            <Bookmark className="h-4 w-4" aria-hidden="true" />
          </HeaderIcon>
          <div>
            <h2 className="text-lg font-semibold text-white">Saved pools</h2>
            <p className="text-sm text-gray-400">Pools you bookmarked for later.</p>
          </div>
        </div>
        <DataRefreshControl
          updatedAt={updatedAt}
          stale={stale}
          fetching={fetching}
          partialError={partialError}
          onRefresh={refetch}
        />
      </header>

      <div className="hidden overflow-hidden rounded-2xl border border-red-900/30 bg-[#1A0505]/60 lg:block">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-gray-400">
            <tr className="border-b border-red-900/30">
              <th scope="col" className="px-4 py-3 font-medium">Pool</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 font-medium">TVL</th>
              <th scope="col" className="px-4 py-3 font-medium">Yield</th>
              <th scope="col" className="px-4 py-3 font-medium">Saved</th>
              <th scope="col" className="px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              return (
                <tr key={entry.id} className="border-b border-red-900/20 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-white">{entry.name}</div>
                    <div className="text-xs text-gray-400">{entry.asset}</div>
                  </td>
                  <td className="px-4 py-3">
                    <PoolStatusBadge status={entry.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-300">{formatAmount(entry.tvl, entry.asset)}</td>
                  <td className="px-4 py-3 text-gray-300">{entry.expectedYield}</td>
                  <td className="px-4 py-3 text-gray-300">{formatDate(entry.savedAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {onOpenPool && (
                        <button
                          type="button"
                          onClick={() => onOpenPool(entry.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-900/20 transition-colors"
                        >
                          Open
                          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                      {onUnsave && (
                        <button
                          type="button"
                          onClick={() => onUnsave(entry)}
                          disabled={savingPoolId === entry.id}
                          className="inline-flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {savingPoolId === entry.id ? "Removing…" : "Remove"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="space-y-3 lg:hidden">
        {entries.map((entry) => {
          return (
            <li key={entry.id} className="rounded-2xl border border-red-900/30 bg-[#1A0505]/60 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-white">{entry.name}</div>
                  <div className="mt-1 text-xs text-gray-400">{formatDate(entry.savedAt)}</div>
                </div>
                <PoolStatusBadge status={entry.status} />
              </div>
              <dl className="mt-3 space-y-1.5 text-sm">
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-400">TVL</dt>
                  <dd className="text-gray-200">{formatAmount(entry.tvl, entry.asset)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-gray-400">Yield</dt>
                  <dd className="text-gray-200">{entry.expectedYield}</dd>
                </div>
                {entry.prize && (
                  <div className="flex justify-between gap-2">
                    <dt className="text-gray-400">Prize</dt>
                    <dd className="text-gray-200">{entry.prize}</dd>
                  </div>
                )}
              </dl>
              <div className="mt-4 flex gap-2">
                {onOpenPool && (
                  <button
                    type="button"
                    onClick={() => onOpenPool(entry.id)}
                    className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl border border-red-500/30 px-4 py-2 text-sm font-semibold text-white hover:bg-red-900/20 transition-colors"
                  >
                    Open pool
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
                {onUnsave && (
                  <button
                    type="button"
                    onClick={() => onUnsave(entry)}
                    disabled={savingPoolId === entry.id}
                    className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {savingPoolId === entry.id ? "Removing…" : "Remove"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default SavedPoolsWatchlist;
