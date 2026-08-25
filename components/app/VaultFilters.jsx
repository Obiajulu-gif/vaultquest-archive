"use client";

import { useState, useEffect } from "react";
import { Search, Filter, X, RotateCcw, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const NETWORKS = ["Avalanche", "Stellar", "Solana"];
const LOCKUP_OPTIONS = [
  { label: "Flexible", value: 0 },
  { label: "Short (1-14 days)", value: "short" },
  { label: "Medium (15-30 days)", value: "medium" },
  { label: "Long (30+ days)", value: "long" },
];
const STRATEGIES = ["Stable Yield", "Growth", "High Yield", "Flexible Drip", "Conservative"];
const STATUSES = ["Active", "Pending", "Completed"];

export default function VaultFilters({ filters, setFilters, onClear }) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const handleNetworkToggle = (network) => {
    const next = filters.networks.includes(network)
      ? filters.networks.filter((n) => n !== network)
      : [...filters.networks, network];
    setFilters({ ...filters, networks: next });
  };

  const FilterContent = () => (
    <div className="flex flex-col gap-8">
      {/* Search */}
      <div className="space-y-3">
        <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
          Search
        </label>
        <div className="relative">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-vault-muted"
            size={18}
          />
          <input
            type="text"
            placeholder="Search vaults or assets..."
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            className="w-full rounded-xl border border-vault-border bg-vault-surface/50 py-2.5 pl-10 pr-4 text-sm text-vault-text focus:border-vault-accent focus:outline-none transition-all"
          />
        </div>
      </div>

      {/* Networks */}
      <div className="space-y-3">
        <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
          Networks
        </label>
        <div className="flex flex-wrap gap-2">
          {NETWORKS.map((network) => (
            <button
              key={network}
              onClick={() => handleNetworkToggle(network)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                filters.networks.includes(network)
                  ? "border-vault-accent bg-vault-accent/10 text-vault-accent"
                  : "border-vault-border bg-vault-surface/30 text-vault-muted hover:border-vault-accent/50 hover:text-vault-text"
              }`}
            >
              {network}
            </button>
          ))}
        </div>
      </div>

      {/* APY Range */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
            Min APY
          </label>
          <span className="text-sm font-semibold text-vault-accent">
            {filters.minApy}%+
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="20"
          step="0.5"
          value={filters.minApy}
          onChange={(e) =>
            setFilters({ ...filters, minApy: parseFloat(e.target.value) })
          }
          className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-vault-border accent-vault-accent"
        />
        <div className="flex justify-between text-[10px] text-vault-muted font-medium">
          <span>0%</span>
          <span>10%</span>
          <span>20%</span>
        </div>
      </div>

      {/* TVL Range */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
            Min TVL
          </label>
          <span className="text-sm font-semibold text-vault-accent">
            ${filters.minTvl}M+
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="20"
          step="1"
          value={filters.minTvl}
          onChange={(e) =>
            setFilters({ ...filters, minTvl: parseInt(e.target.value) })
          }
          className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-vault-border accent-vault-accent"
        />
        <div className="flex justify-between text-[10px] text-vault-muted font-medium">
          <span>$0M</span>
          <span>$10M</span>
          <span>$20M</span>
        </div>
      </div>

      {/* Lockup */}
      <div className="space-y-3">
        <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
          Lockup Duration
        </label>
        <div className="space-y-2">
          {LOCKUP_OPTIONS.map((option) => (
            <label
              key={option.label}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-vault-border bg-vault-surface/30 p-3 transition-all hover:border-vault-accent/30"
            >
              <input
                type="checkbox"
                checked={filters.lockups.includes(option.value)}
                onChange={() => {
                  const next = filters.lockups.includes(option.value)
                    ? filters.lockups.filter((v) => v !== option.value)
                    : [...filters.lockups, option.value];
                  setFilters({ ...filters, lockups: next });
                }}
                className="h-4 w-4 rounded border-vault-border bg-vault-surface text-vault-accent focus:ring-vault-accent"
              />
              <span className="text-sm text-vault-text font-medium">
                {option.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Status */}
      <div className="space-y-3">
        <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
          Status
        </label>
        <div className="flex flex-wrap gap-2">
          {STATUSES.map((status) => {
            const statusValue = status.toLowerCase();
            return (
              <button
                key={status}
                onClick={() => {
                  const next = filters.statuses?.includes(statusValue)
                    ? filters.statuses.filter((s) => s !== statusValue)
                    : [...(filters.statuses || []), statusValue];
                  setFilters({ ...filters, statuses: next });
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                  filters.statuses?.includes(statusValue)
                    ? "border-vault-accent bg-vault-accent/10 text-vault-accent"
                    : "border-vault-border bg-vault-surface/30 text-vault-muted hover:border-vault-accent/50 hover:text-vault-text"
                }`}
              >
                {status}
              </button>
            );
          })}
        </div>
      </div>

      {/* Strategy */}
      <div className="space-y-3">
        <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
          Strategy
        </label>
        <div className="space-y-2">
          {STRATEGIES.map((strategy) => (
            <label
              key={strategy}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-vault-border bg-vault-surface/30 p-3 transition-all hover:border-vault-accent/30"
            >
              <input
                type="checkbox"
                checked={filters.strategies?.includes(strategy) || false}
                onChange={() => {
                  const next = filters.strategies?.includes(strategy)
                    ? filters.strategies.filter((s) => s !== strategy)
                    : [...(filters.strategies || []), strategy];
                  setFilters({ ...filters, strategies: next });
                }}
                className="h-4 w-4 rounded border-vault-border bg-vault-surface text-vault-accent focus:ring-vault-accent"
              />
              <span className="text-sm text-vault-text font-medium">
                {strategy}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Sort by Activity */}
      <div className="space-y-3">
        <label className="text-xs font-bold uppercase tracking-wider text-vault-muted">
          Sort
        </label>
        <select
          value={filters.sortBy || "apy"}
          onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
          className="w-full rounded-xl border border-vault-border bg-vault-surface/50 px-3 py-2.5 text-sm text-vault-text focus:border-vault-accent focus:outline-none transition-all"
        >
          <option value="apy">Yield (Highest)</option>
          <option value="tvl">TVL (Largest)</option>
          <option value="activity">Activity (Recent)</option>
          <option value="lockup">Lockup (Shortest)</option>
        </select>
      </div>

      {/* Clear Filters */}
      <button
        onClick={onClear}
        className="vq-btn-ghost mt-4 flex w-full items-center justify-center gap-2 border-dashed border-vault-muted/30 py-3 text-vault-muted hover:text-vault-accent hover:border-vault-accent"
      >
        <RotateCcw size={16} />
        Reset All Filters
      </button>
    </div>
  );

  return (
    <>
      {/* Mobile Toggle */}
      <div className="mb-6 flex items-center justify-between lg:hidden">
        <button
          onClick={() => setIsMobileOpen(true)}
          className="vq-btn-ghost flex items-center gap-2"
        >
          <Filter size={18} />
          Filters & Search
        </button>
        {Object.values(filters).some(
          (v) =>
            (Array.isArray(v) && v.length > 0) ||
            (typeof v === "string" && v !== "") ||
            (typeof v === "number" && v > 0)
        ) && (
          <span className="rounded-full bg-vault-accent px-2 py-0.5 text-[10px] font-bold text-white uppercase">
            Active
          </span>
        )}
      </div>

      {/* Desktop Sidebar */}
      <aside className="hidden w-72 shrink-0 lg:block">
        <div className="sticky top-6 rounded-2xl border border-vault-border bg-vault-surface/40 p-6 backdrop-blur-md">
          <div className="mb-6 flex items-center gap-2 text-vault-text font-bold uppercase tracking-widest text-sm">
            <Filter size={16} />
            Refine Pools
          </div>
          <FilterContent />
        </div>
      </aside>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {isMobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsMobileOpen(false)}
              className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm lg:hidden"
            />
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed bottom-0 left-0 top-0 z-[70] w-full max-w-[320px] bg-vault-bg p-6 shadow-2xl lg:hidden overflow-y-auto"
            >
              <div className="mb-8 flex items-center justify-between">
                <div className="flex items-center gap-2 text-vault-text font-bold uppercase tracking-widest text-sm">
                  <Filter size={16} />
                  Filters
                </div>
                <button
                  onClick={() => setIsMobileOpen(false)}
                  className="rounded-full p-2 text-vault-muted hover:bg-vault-surface"
                >
                  <X size={20} />
                </button>
              </div>
              <FilterContent />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
