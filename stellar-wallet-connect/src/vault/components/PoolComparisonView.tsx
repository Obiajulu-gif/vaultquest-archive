import type { FC, ReactNode } from "react";
import { useMemo } from "react";
import { Columns, Plus, X } from "lucide-react";
import { EmptyState, LoadingState, StaleIndicator } from "../../components/FallbackStates";
import type { PoolStatus, PoolSummary } from "../contract/types";
import { formatAmount, formatDate } from "../lib/format";
import PoolStatusBadge from "./PoolStatusBadge";

export interface PoolComparisonViewProps {
  pools: PoolSummary[];
  selectedIds: string[];
  loading?: boolean;
  stale?: boolean;
  maxSelections?: number;
  onToggleSelect: (poolId: string) => void;
  onClear: () => void;
}

interface ComparisonRow {
  label: string;
  render: (pool: PoolSummary) => ReactNode;
}

const ROWS: ComparisonRow[] = [
  { label: "Status", render: (p) => {
    return (
      <PoolStatusBadge status={p.status} />
    );
  }},
  { label: "TVL", render: (p) => formatAmount(p.tvl, p.asset) },
  { label: "Asset", render: (p) => p.asset },
  { label: "Participants", render: (p) => String(p.participantCount) },
  { label: "Expected yield", render: (p) => p.expectedYield },
  { label: "Prize", render: (p) => p.prize ?? "—" },
  { label: "Opens", render: (p) => p.opensAt ? formatDate(p.opensAt) : "—" },
  { label: "Locks", render: (p) => p.locksAt ? formatDate(p.locksAt) : "—" },
  { label: "Draws", render: (p) => p.drawsAt ? formatDate(p.drawsAt) : "—" },
];

export const PoolComparisonView: FC<PoolComparisonViewProps> = ({
  pools,
  selectedIds,
  loading = false,
  stale = false,
  maxSelections = 5,
  onToggleSelect,
  onClear,
}) => {
  const selectedPools = useMemo(
    () => pools.filter((p) => selectedIds.includes(p.id)),
    [pools, selectedIds],
  );

  const isMaxed = selectedIds.length >= maxSelections;

  if (loading && pools.length === 0) {
    return <LoadingState label="Loading pools…" />;
  }

  if (pools.length === 0) {
    return (
      <EmptyState
        icon={<Columns className="h-7 w-7" aria-hidden="true" />}
        title="No pools to compare"
        description="Create or discover pools to start comparing."
      />
    );
  }

  return (
    <section aria-label="Pool comparison" className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-900/20 text-red-300">
            <Columns className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Compare pools</h2>
            <p className="text-sm text-gray-400">
              {selectedIds.length > 0
                ? `${selectedIds.length} pool${selectedIds.length === 1 ? "" : "s"} selected`
                : "Select pools to compare side by side"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {stale && <StaleIndicator />}
          {selectedIds.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:bg-red-900/20 hover:text-white"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Clear all
            </button>
          )}
        </div>
      </header>

      {/* Pool selection chips */}
      <div className="flex flex-wrap gap-2">
        {pools.map((pool) => {
          const isSelected = selectedIds.includes(pool.id);
          return (
            <button
              key={pool.id}
              type="button"
              onClick={() => onToggleSelect(pool.id)}
              disabled={!isSelected && isMaxed}
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-all ${
                isSelected
                  ? "bg-red-600 text-white shadow-sm"
                  : "border border-red-900/30 text-gray-400 hover:border-red-500/40 hover:text-gray-200"
              } disabled:cursor-not-allowed disabled:opacity-40`}
              aria-pressed={isSelected}
            >
              {isSelected ? (
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {pool.name}
            </button>
          );
        })}
      </div>

      {isMaxed && selectedIds.length > 0 && (
        <p className="text-xs text-amber-400">
          Maximum of {maxSelections} pools can be compared. Remove a selection to add another.
        </p>
      )}

      {/* Comparison table */}
      {selectedPools.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-red-900/30 bg-[#1A0505]/60">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-red-900/30">
                <th scope="col" className="sticky left-0 z-10 min-w-[120px] bg-[#1A0505] px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-400">
                  &nbsp;
                </th>
                {selectedPools.map((pool) => (
                  <th key={pool.id} scope="col" className="min-w-[140px] px-4 py-3 text-xs font-medium uppercase tracking-wide text-gray-400">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold normal-case text-white">{pool.name}</span>
                      <button
                        type="button"
                        onClick={() => onToggleSelect(pool.id)}
                        className="shrink-0 rounded-full p-0.5 text-gray-500 transition-colors hover:bg-red-900/20 hover:text-red-400"
                        aria-label={`Remove ${pool.name} from comparison`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row, i) => (
                <tr key={row.label} className={i < ROWS.length - 1 ? "border-b border-red-900/20" : ""}>
                  <th scope="row" className="sticky left-0 z-10 bg-[#1A0505] px-4 py-2.5 text-xs font-medium text-gray-400">
                    {row.label}
                  </th>
                  {selectedPools.map((pool) => (
                    <td key={pool.id} className="px-4 py-2.5 text-gray-200">
                      {row.render(pool)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-red-900/30 bg-[#1A0505]/30 px-6 py-12 text-center">
          <Columns className="h-8 w-8 text-gray-600" aria-hidden="true" />
          <p className="text-sm text-gray-500">
            Select two or more pools above to see a side-by-side comparison.
          </p>
        </div>
      )}
    </section>
  );
};

export default PoolComparisonView;
