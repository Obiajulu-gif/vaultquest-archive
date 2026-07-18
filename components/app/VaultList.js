"use client";

import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { Wallet, Info, ArrowUpRight } from "lucide-react";
import RoundStatusBadge from "@/components/app/RoundStatusBadge";
import { MOCK_VAULTS } from "@/lib/vault-mock-data";

export { MOCK_VAULTS, VAULT_ROUND_ARCHIVE } from "@/lib/vault-mock-data";

export default function VaultList({ vaults = [], suggestions = null, onSuggestionClick = null }) {
  if (vaults.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-vault-surface text-vault-muted border border-vault-border">
          <Info size={32} />
        </div>
        <h3 className="text-xl font-semibold text-vault-text">No vaults found</h3>
        <p className="text-vault-muted mb-6">Try adjusting your filters to find more opportunities.</p>
        {suggestions && suggestions.length > 0 && (
          <div className="max-w-md">
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
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
      <AnimatePresence mode="popLayout">
        {vaults.map((vault) => (
          <motion.div
            key={vault.id}
            layout
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.2 }}
            className="vq-glass-hover group flex flex-col justify-between p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent border border-vault-accent/20">
                  <Wallet size={20} />
                </div>
                <div>
                  <h4 className="font-semibold text-vault-text">{vault.name}</h4>
                  <p className="text-xs text-vault-muted">{vault.network} • {vault.asset}</p>
                </div>
              </div>
              <RoundStatusBadge status={vault.status} className="shrink-0" />
            </div>

            <div className="mt-6 grid grid-cols-3 gap-3 border-t border-vault-border pt-4">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-vault-muted font-bold">Est. APY</p>
                <p className="font-bold text-emerald-500">{vault.apy}%</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-vault-muted font-bold">TVL</p>
                <p className="font-medium text-vault-text">
                  ${(vault.tvl / 1000000).toFixed(1)}M
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-vault-muted font-bold">Lockup</p>
                <p className="font-medium text-vault-text">
                  {vault.lockup === 0 ? "Flexible" : `${vault.lockup} Days`}
                </p>
              </div>
            </div>

            <button
              type="button"
              aria-label={`View ${vault.name} details`}
              className="vq-btn-ghost mt-6 w-full group-hover:bg-vault-accent group-hover:text-white group-hover:border-vault-accent transition-all"
            >
              View Vault
              <ArrowUpRight size={16} className="ml-1 inline" />
            </button>

            <div className="mt-4 rounded-xl border border-vault-border bg-vault-surface/30 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-vault-muted">
                Participants
              </p>
              <p className="mt-1 text-sm font-semibold text-vault-text">
                {vault.participantCount?.toLocaleString("en-US") ?? "No participant data"}
              </p>
              <p className="mt-1 text-xs text-vault-muted">
                {vault.activityTrend ?? "Activity trend pending"}
              </p>
            </div>

            <Link href={`/app/vaults/${vault.id}`} className="vq-btn-primary mt-6 w-full text-center">
              View Vault
              <ArrowUpRight size={16} className="ml-1 inline" />
            </Link>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
