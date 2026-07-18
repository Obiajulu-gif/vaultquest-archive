"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import GasPrioritySelector from "@/components/app/GasPrioritySelector";
import DepositModal from "@/components/app/DepositModal";
import VaultFilters from "@/components/app/VaultFilters";
import VaultList, { MOCK_VAULTS } from "@/components/app/VaultList";
import VaultComparisonTable from "@/components/app/VaultComparisonTable";
import VaultDataRefresh from "@/components/app/VaultDataRefresh";
import VaultDataWarnings from "@/components/app/VaultDataWarnings";
import VaultFaqSection from "@/components/app/VaultFaqSection";
import VaultRiskExplainer from "@/components/app/VaultRiskExplainer";
import VaultHealthStatusPanel from "@/components/app/VaultHealthStatusPanel";
import VaultRewardsExplanationModal from "@/components/app/VaultRewardsExplanationModal";
import MobileVaultActions from "@/components/app/MobileVaultActions";
import VaultRetryQueue from "@/components/app/VaultRetryQueue";
import { useVaultDataReview } from "@/hooks/useVaultDataReview";
import { Archive, LayoutGrid, Table } from "lucide-react";

const INITIAL_FILTERS = {
  search: "",
  networks: [],
  minApy: 0,
  minTvl: 0,
  lockups: [],
  statuses: [],
  strategies: [],
  sortBy: "apy",
};

export default function VaultsPage() {
  const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
  const [filters, setFilters] = useState(INITIAL_FILTERS);
  const [viewMode, setViewMode] = useState("table");

  const { vaults: reviewedVaults, warnings: dataWarnings } =
    useVaultDataReview(MOCK_VAULTS);

  const filteredVaults = useMemo(() => {
    return reviewedVaults.filter((vault) => {
      // Search (by name, asset, or strategy)
      if (filters.search) {
        const search = filters.search.toLowerCase();
        if (
          !vault.name.toLowerCase().includes(search) &&
          !vault.asset.toLowerCase().includes(search) &&
          !vault.strategy.toLowerCase().includes(search)
        ) {
          return false;
        }
      }

      // Networks
      if (
        filters.networks.length > 0 &&
        !filters.networks.includes(vault.network)
      ) {
        return false;
      }

      // APY
      if (vault.apy < filters.minApy) {
        return false;
      }

      // TVL (in millions)
      if (vault.tvl / 1000000 < filters.minTvl) {
        return false;
      }

      // Lockups
      if (filters.lockups.length > 0) {
        const isMatch = filters.lockups.some((l) => {
          if (l === 0) return vault.lockup === 0;
          if (l === "short") return vault.lockup >= 1 && vault.lockup <= 14;
          if (l === "medium") return vault.lockup >= 15 && vault.lockup <= 30;
          if (l === "long") return vault.lockup > 30;
          return false;
        });
        if (!isMatch) return false;
      }

      // Status
      if (filters.statuses && filters.statuses.length > 0) {
        if (!filters.statuses.includes(vault.status)) {
          return false;
        }
      }

      // Strategy
      if (filters.strategies && filters.strategies.length > 0) {
        if (!filters.strategies.includes(vault.strategy)) {
          return false;
        }
      }

      return true;
    });
  }, [filters, reviewedVaults]);

  const clearFilters = () => setFilters(INITIAL_FILTERS);

  const generateSuggestions = () => {
    if (filteredVaults.length > 0 || !filters.search) {
      return null;
    }

    const search = filters.search.toLowerCase();
    const allNames = MOCK_VAULTS.map((v) => v.name);
    const allAssets = MOCK_VAULTS.map((v) => v.asset);
    const allStrategies = MOCK_VAULTS.map((v) => v.strategy);

    const suggestions = new Set();

    [...allNames, ...allAssets, ...allStrategies].forEach((item) => {
      if (item.toLowerCase().includes(search) && suggestions.size < 3) {
        suggestions.add(item);
      }
    });

    return Array.from(suggestions);
  };

  const handleSuggestionClick = (suggestion) => {
    setFilters({ ...filters, search: suggestion });
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-vault-text">Vaults</h1>
            <p className="mt-3 max-w-2xl text-vault-muted">
              Manage your pool positions and drip deposits. Review live fee tiers
              before you submit a transaction.
            </p>
          </div>
          <Link href="/app/vaults/archive" className="vq-btn-ghost self-start">
            <Archive className="h-4 w-4" aria-hidden="true" />
            Round archive
          </Link>
        </div>
      </section>

      <VaultRiskExplainer />

      <VaultRetryQueue />

      <div className="flex justify-end">
        <VaultRewardsExplanationModal />
      </div>

      <div className="flex flex-col gap-8 lg:flex-row">
        <VaultFilters
          filters={filters}
          setFilters={setFilters}
          onClear={clearFilters}
        />

        <div className="flex-1 space-y-6">
          <VaultDataRefresh />

          <VaultDataWarnings warnings={dataWarnings} />

          <VaultHealthStatusPanel />

          <MobileVaultActions
            vaultName="Selected Vault"
            onAction={(action) => console.log(`Action: ${action}`)}
          />

          <div className="grid gap-6 xl:grid-cols-2">
            <GasPrioritySelector nativeBalance={0.0018} />

            <section className="vq-glass-hover flex flex-col justify-between p-6">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.24em] text-vault-muted">
                  Deposit review
                </p>
                <h2 className="mt-1 text-xl font-semibold text-vault-text">
                  Quick Deposit Flow
                </h2>
                <p className="mt-2 text-sm text-vault-muted">
                  Select a vault below to begin your deposit. Live network
                  estimates will be calculated automatically.
                </p>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setIsDepositModalOpen(true)}
                  className="vq-btn-primary"
                >
                  Open deposit modal
                </button>
                <Link
                  href="/app/vaults/planner"
                  className="vq-btn-ghost"
                >
                  Recurring Planner
                </Link>
              </div>
            </section>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xl font-bold text-vault-text">
                  Available Pools
                </h3>
                <p className="text-sm text-vault-muted">
                  Showing {filteredVaults.length} of {MOCK_VAULTS.length} vaults
                </p>
              </div>
              <div className="flex gap-2 rounded-lg border border-vault-border p-1 bg-vault-surface">
                <button
                  onClick={() => setViewMode("table")}
                  className={`p-1.5 rounded-md transition-colors ${viewMode === "table" ? "bg-vault-accent/20 text-vault-accent" : "text-vault-muted hover:text-vault-text"}`}
                >
                  <Table size={18} />
                </button>
                <button
                  onClick={() => setViewMode("grid")}
                  className={`p-1.5 rounded-md transition-colors ${viewMode === "grid" ? "bg-vault-accent/20 text-vault-accent" : "text-vault-muted hover:text-vault-text"}`}
                >
                  <LayoutGrid size={18} />
                </button>
              </div>
            </div>
            {viewMode === "table" ? (
              <VaultComparisonTable
                vaults={filteredVaults}
                sortBy={filters.sortBy}
                suggestions={generateSuggestions()}
                onSuggestionClick={handleSuggestionClick}
                onClearFilters={clearFilters}
              />
            ) : (
              <VaultList
                vaults={filteredVaults}
                suggestions={generateSuggestions()}
                onSuggestionClick={handleSuggestionClick}
              />
            )}
          </div>

          <VaultFaqSection />
        </div>
      </div>

      <DepositModal
        isOpen={isDepositModalOpen}
        onClose={() => setIsDepositModalOpen(false)}
      />

      <Link href="/app" className="vq-btn-ghost inline-flex">
        ← Back to dashboard
      </Link>
    </div>
  );
}
