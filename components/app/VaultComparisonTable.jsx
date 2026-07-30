"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowUpDown, ArrowUpRight, Wallet, Info } from "lucide-react";
import VaultEmptyState from "@/components/app/VaultEmptyState";
import SavePoolButton from "@/components/app/SavePoolButton";
import ComparePoolButton from "@/components/app/ComparePoolButton";

export default function VaultComparisonTable({ vaults = [], sortBy = "apy", suggestions = null, onSuggestionClick = null, onClearFilters = null, comparisonMode = null }) {
  const [sortConfig, setSortConfig] = useState({ key: sortBy, direction: "desc" });

  const sortedVaults = [...vaults].sort((a, b) => {
    let keyA, keyB;

    if (sortConfig.key === "activity") {
      keyA = a.lastActivity?.getTime() || 0;
      keyB = b.lastActivity?.getTime() || 0;
    } else {
      keyA = a[sortConfig.key];
      keyB = b[sortConfig.key];
    }

    if (keyA < keyB) {
      return sortConfig.direction === "asc" ? -1 : 1;
    }
    if (keyA > keyB) {
      return sortConfig.direction === "asc" ? 1 : -1;
    }
    return 0;
  });

  const handleSort = (key) => {
    let direction = "asc";
    if (sortConfig.key === key && sortConfig.direction === "asc") {
      direction = "desc";
    }
    setSortConfig({ key, direction });
  };

  const SortIcon = ({ columnKey }) => (
    <ArrowUpDown 
      size={14} 
      className={`ml-1 inline-block transition-colors ${
        sortConfig.key === columnKey ? "text-vault-accent" : "text-vault-muted group-hover:text-vault-text"
      }`} 
    />
  );

  if (vaults.length === 0) {
    return (
      <div className="space-y-4">
        <VaultEmptyState variant="vaultList" onClearFilters={onClearFilters ?? undefined} />
        {suggestions && suggestions.length > 0 && (
          <div className="text-center">
            <p className="text-sm font-semibold text-vault-muted mb-3">Did you mean:</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => onSuggestionClick?.(suggestion)}
                  className="rounded-lg border border-vault-border bg-vault-surface/50 px-3 py-1.5 text-xs font-medium text-vault-accent transition-all hover:border-vault-accent hover:bg-vault-surface"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full overflow-x-auto rounded-2xl border border-vault-border bg-vault-surface/50 backdrop-blur-md">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b border-vault-border bg-vault-surface/80 text-xs uppercase tracking-wider text-vault-muted">
          <tr>
            <th className="px-6 py-4 font-semibold">Vault</th>
            <th
              className="group cursor-pointer px-6 py-4 font-semibold hover:bg-white/5"
              onClick={() => handleSort("tvl")}
            >
              Deposits (TVL) <SortIcon columnKey="tvl" />
            </th>
            <th
              className="group cursor-pointer px-6 py-4 font-semibold hover:bg-white/5"
              onClick={() => handleSort("participantCount")}
            >
              Participants <SortIcon columnKey="participantCount" />
            </th>
            <th
              className="group cursor-pointer px-6 py-4 font-semibold hover:bg-white/5"
              onClick={() => handleSort("apy")}
            >
              Est. Yield <SortIcon columnKey="apy" />
            </th>
            <th
              className="group cursor-pointer px-6 py-4 font-semibold hover:bg-white/5"
              onClick={() => handleSort("lockup")}
            >
              Lockup <SortIcon columnKey="lockup" />
            </th>
            <th
              className="group cursor-pointer px-6 py-4 font-semibold hover:bg-white/5"
              onClick={() => handleSort("activity")}
            >
              Activity <SortIcon columnKey="activity" />
            </th>
            <th className="px-6 py-4 text-right font-semibold">Action</th>
          </tr>
        </thead>
        <tbody>
          {sortedVaults.map((vault, idx) => (
            <motion.tr 
              key={vault.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: idx * 0.05 }}
              className="group border-b border-vault-border/50 transition-colors hover:bg-white/5 last:border-0"
            >
              <td className="px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent">
                    <Wallet size={18} />
                  </div>
                  <div>
                    <p className="font-semibold text-vault-text">{vault.name}</p>
                    <p className="text-xs text-vault-muted">{vault.network} • {vault.asset}</p>
                  </div>
                </div>
              </td>
              <td className="px-6 py-4 font-medium text-vault-text">
                ${(vault.tvl / 1000000).toFixed(2)}M
              </td>
              <td className="px-6 py-4 font-medium text-vault-text">
                {vault.participantCount?.toLocaleString("en-US") ?? "Pending"}
              </td>
              <td className="px-6 py-4">
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-sm font-bold text-emerald-500">
                  {vault.apy}%
                </span>
              </td>
              <td className="px-6 py-4 text-vault-muted">
                {vault.lockup === 0 ? "Flexible" : `${vault.lockup} Days`}
              </td>
              <td className="px-6 py-4 text-sm text-vault-muted">
                {vault.lastActivity ? new Date(vault.lastActivity).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'N/A'}
              </td>
              <td className="px-6 py-4 text-right">
                <div className="flex items-center justify-end gap-2">
                  <SavePoolButton pool={vault} />
                  {comparisonMode && (
                    <ComparePoolButton
                      pool={vault}
                      isSelected={comparisonMode.isSelected(vault.id)}
                      onToggle={() => {
                        if (comparisonMode.isSelected(vault.id)) {
                          comparisonMode.removePool(vault.id);
                        } else {
                          comparisonMode.addPool(vault);
                        }
                      }}
                      disabled={!comparisonMode.isSelected(vault.id) && !comparisonMode.canAddMore}
                    />
                  )}
                  <Link href={`/app/vaults/${vault.id}`} className="inline-flex items-center gap-1 rounded-lg border border-vault-border bg-vault-surface px-3 py-1.5 text-sm font-medium text-vault-text transition-all hover:border-vault-accent hover:text-vault-accent">
                    View <ArrowUpRight size={14} />
                  </Link>
                </div>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
