"use client";

import { X, ArrowUpRight, Users, Lock, TrendingUp, Wallet } from "lucide-react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import RoundStatusBadge from "@/components/app/RoundStatusBadge";

export default function PoolComparisonDrawer({ pools, onRemove, onClearAll, onClose }) {
  const isOpen = pools.length >= 2;

  const ComparisonMetric = ({ label, values, icon: Icon, highlight = false }) => (
    <div className="border-b border-vault-border last:border-b-0">
      <div className="flex items-center gap-2 p-3 bg-vault-surface/50 font-semibold text-vault-text text-sm">
        {Icon && <Icon size={16} className="text-vault-accent" aria-hidden="true" />}
        {label}
      </div>
      <div className={`grid ${pools.length === 2 ? "grid-cols-2" : pools.length === 3 ? "grid-cols-3" : "grid-cols-4"} divide-x divide-vault-border`}>
        {values.map((value, idx) => (
          <div
            key={idx}
            className={`p-3 text-center ${highlight ? "font-bold text-emerald-500" : "text-vault-text"}`}
          >
            {value ?? (
              <span className="text-vault-muted text-sm">N/A</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-40"
          />
          
          {/* Drawer */}
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-50 bg-vault-bg border-t border-vault-border shadow-2xl max-h-[80vh] overflow-auto"
          >
            <div className="sticky top-0 z-10 bg-vault-surface/95 backdrop-blur-lg border-b border-vault-border px-6 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-xl font-bold text-vault-text">
                    Pool Comparison ({pools.length})
                  </h3>
                  <p className="text-sm text-vault-muted mt-0.5">
                    Compare up to 4 pools side by side
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onClearAll}
                    className="vq-btn-ghost text-sm"
                  >
                    Clear All
                  </button>
                  <button
                    onClick={onClose}
                    className="p-2 rounded-lg hover:bg-vault-surface transition-colors text-vault-muted hover:text-vault-text"
                    aria-label="Close comparison"
                  >
                    <X size={20} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6">
              {/* Mobile stacked view */}
              <div className="lg:hidden space-y-4">
                {pools.map((pool) => (
                  <div key={pool.id} className="vq-glass p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="font-semibold text-vault-text">{pool.name}</h4>
                        <p className="text-xs text-vault-muted">{pool.asset}</p>
                      </div>
                      <button
                        onClick={() => onRemove(pool.id)}
                        className="p-1.5 rounded-lg hover:bg-red-500/20 text-vault-muted hover:text-red-500 transition-colors"
                        aria-label="Remove from comparison"
                      >
                        <X size={16} aria-hidden="true" />
                      </button>
                    </div>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-vault-muted">Status</span>
                        <RoundStatusBadge status={pool.status} />
                      </div>
                      <div className="flex justify-between">
                        <span className="text-vault-muted">Est. APY</span>
                        <span className="font-bold text-emerald-500">{pool.apy}%</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-vault-muted">TVL</span>
                        <span className="font-medium text-vault-text">
                          ${(pool.tvl / 1000000).toFixed(2)}M
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-vault-muted">Participants</span>
                        <span className="font-medium text-vault-text">
                          {pool.participantCount?.toLocaleString() ?? "N/A"}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-vault-muted">Lockup</span>
                        <span className="font-medium text-vault-text">
                          {pool.lockup === 0 ? "Flexible" : `${pool.lockup} Days`}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-vault-muted">Strategy</span>
                        <span className="font-medium text-vault-text">{pool.strategy}</span>
                      </div>
                    </div>
                    <Link
                      href={`/app/vaults/${pool.id}`}
                      className="vq-btn-primary mt-3 w-full text-center text-sm"
                    >
                      View Pool <ArrowUpRight size={14} className="inline ml-1" />
                    </Link>
                  </div>
                ))}
              </div>

              {/* Desktop table view */}
              <div className="hidden lg:block">
                <div className="rounded-xl border border-vault-border overflow-hidden">
                  {/* Pool headers */}
                  <div className={`grid ${pools.length === 2 ? "grid-cols-2" : pools.length === 3 ? "grid-cols-3" : "grid-cols-4"} divide-x divide-vault-border bg-vault-surface/80`}>
                    {pools.map((pool) => (
                      <div key={pool.id} className="p-4">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-vault-accent/10 text-vault-accent">
                              <Wallet size={16} />
                            </div>
                            <div>
                              <h4 className="font-semibold text-vault-text text-sm">{pool.name}</h4>
                              <p className="text-xs text-vault-muted">{pool.asset}</p>
                            </div>
                          </div>
                          <button
                            onClick={() => onRemove(pool.id)}
                            className="p-1 rounded hover:bg-red-500/20 text-vault-muted hover:text-red-500 transition-colors"
                            aria-label="Remove from comparison"
                          >
                            <X size={14} aria-hidden="true" />
                          </button>
                        </div>
                        <Link
                          href={`/app/vaults/${pool.id}`}
                          className="vq-btn-ghost w-full text-center text-xs"
                        >
                          View <ArrowUpRight size={12} className="inline ml-1" />
                        </Link>
                      </div>
                    ))}
                  </div>

                  {/* Comparison metrics */}
                  <div className="divide-y divide-vault-border">
                    <ComparisonMetric
                      label="Status"
                      values={pools.map((p) => (
                        <RoundStatusBadge key={p.id} status={p.status} />
                      ))}
                    />
                    <ComparisonMetric
                      label="Est. APY"
                      icon={TrendingUp}
                      values={pools.map((p) => `${p.apy}%`)}
                      highlight
                    />
                    <ComparisonMetric
                      label="Total Value Locked (TVL)"
                      values={pools.map((p) => `$${(p.tvl / 1000000).toFixed(2)}M`)}
                    />
                    <ComparisonMetric
                      label="Participants"
                      icon={Users}
                      values={pools.map((p) => p.participantCount?.toLocaleString() ?? null)}
                    />
                    <ComparisonMetric
                      label="Lockup Period"
                      icon={Lock}
                      values={pools.map((p) => (p.lockup === 0 ? "Flexible" : `${p.lockup} Days`))}
                    />
                    <ComparisonMetric
                      label="Strategy"
                      values={pools.map((p) => p.strategy)}
                    />
                    <ComparisonMetric
                      label="Network"
                      values={pools.map((p) => p.network)}
                    />
                    <ComparisonMetric
                      label="Current Capacity"
                      values={pools.map((p) => {
                        if (p.maxCapacity) {
                          const percent = ((p.tvl / p.maxCapacity) * 100).toFixed(0);
                          return `${percent}% full`;
                        }
                        return null;
                      })}
                    />
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
