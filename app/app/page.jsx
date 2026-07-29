"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useTranslation } from "next-i18next";
import { Sparkles } from "lucide-react";
import OnboardingCards from "@/components/app/OnboardingCards";
import PublicStatsBar from "@/components/app/PublicStatsBar";
import VaultMetricsCards from "@/components/app/VaultMetricsCards";
import UnsupportedNetworkBanner from "@/components/app/UnsupportedNetworkBanner";
import RecentWinners from "@/components/app/RecentWinners";
import YieldCalculator from "@/components/app/YieldCalculator";
import BridgeStatusTracker from "@/components/app/BridgeStatusTracker";
import WinnerCelebration from "@/components/app/WinnerCelebration";
import PrizeCountdown from "@/components/app/PrizeCountdown";
import FaqAccordion from "@/components/app/FaqAccordion";
import { WalletConnectionStatus } from "@vaultquest/stellar-wallet-connect/src/components/WalletConnectionStatus";
import { OnboardingChecklist } from "@vaultquest/stellar-wallet-connect/src/vault/components/OnboardingChecklist";
import VaultEmptyState from "@/components/app/VaultEmptyState";
import VaultOnboardingTour from "@/components/app/VaultOnboardingTour";
import VaultGoalTracker from "@/components/app/VaultGoalTracker";
import VaultRewardsExplanationModal from "@/components/app/VaultRewardsExplanationModal";
import VaultDocsQuickLinks from "@/components/app/VaultDocsQuickLinks";
import VaultLeaderboardPlaceholder from "@/components/app/VaultLeaderboardPlaceholder";

function DashboardSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      {/* Hero Header Skeleton */}
      <header className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between border-b border-vault-border/20 pb-8">
        <div className="space-y-4 max-w-2xl flex-1">
          <div className="h-6 w-48 bg-vault-border/30 rounded-full" />
          <div className="h-10 w-3/4 bg-vault-border/40 rounded-lg sm:h-12" />
          <div className="space-y-2">
            <div className="h-4 bg-vault-border/30 rounded w-full" />
            <div className="h-4 bg-vault-border/30 rounded w-5/6" />
          </div>
        </div>
        <div className="w-full lg:max-w-md h-56 bg-vault-surface/40 border border-vault-border/50 rounded-2xl shrink-0" />
      </header>

      {/* Main Grid Skeleton */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left Column */}
        <div className="space-y-8 lg:col-span-8">
          <div className="vq-glass p-6 h-96 flex flex-col justify-between">
            <div className="flex items-center justify-between border-b border-vault-border/30 pb-4">
              <div className="h-6 w-40 bg-vault-border/40 rounded" />
              <div className="h-6 w-20 bg-vault-border/30 rounded-full" />
            </div>
            <div className="grid grid-cols-3 gap-4 my-4">
              <div className="h-16 bg-vault-border/20 rounded-lg" />
              <div className="h-16 bg-vault-border/20 rounded-lg" />
              <div className="h-16 bg-vault-border/20 rounded-lg" />
            </div>
            <div className="h-48 bg-vault-border/20 rounded-xl" />
          </div>
          <div className="space-y-4">
            <div className="h-6 w-48 bg-vault-border/40 rounded" />
            <div className="flex gap-4 overflow-hidden">
              <div className="w-64 h-36 bg-vault-surface/40 border border-vault-border/50 rounded-2xl shrink-0" />
              <div className="w-64 h-36 bg-vault-surface/40 border border-vault-border/50 rounded-2xl shrink-0" />
              <div className="w-64 h-36 bg-vault-surface/40 border border-vault-border/50 rounded-2xl shrink-0" />
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div className="space-y-8 lg:col-span-4">
          <div className="vq-glass p-6 space-y-6">
            <div className="h-6 w-32 bg-vault-border/40 rounded border-b border-vault-border/30 pb-3" />
            <div className="space-y-3">
              <div className="h-16 bg-vault-border/20 rounded-xl" />
              <div className="h-16 bg-vault-border/20 rounded-xl" />
              <div className="h-16 bg-vault-border/20 rounded-xl" />
              <div className="h-16 bg-vault-border/20 rounded-xl" />
            </div>
          </div>
          <div className="vq-glass p-6 h-56 flex flex-col justify-between">
            <div className="h-6 w-2/3 bg-vault-border/40 mx-auto rounded" />
            <div className="h-12 bg-vault-border/30 rounded-xl w-full" />
            <div className="h-12 bg-vault-border/20 rounded-xl w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AppDashboardPage() {
  const { t } = useTranslation("common");
  const { isConnected, address, chain } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [hasJoinedVault] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isWinner = false;

  const nextDrawDate = useMemo(() => {
    const now = new Date();
    const nextFriday = new Date(now);
    nextFriday.setUTCDate(now.getUTCDate() + ((5 - now.getUTCDay() + 7) % 7));
    nextFriday.setUTCHours(18, 0, 0, 0);
    if (nextFriday <= now) nextFriday.setUTCDate(nextFriday.getUTCDate() + 7);
    return nextFriday;
  }, []);

  const handleStartSaving = () => {
    if (!isConnected) { openConnectModal?.(); setOnboardingStep(1); return; }
    setOnboardingStep(1);
  };

  if (!mounted) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <VaultOnboardingTour />

      <UnsupportedNetworkBanner />

      <WinnerCelebration
        isWinner={isWinner}
        prizeAmount="250.00"
        prizeCurrency="USDC"
        drawDate={new Date().toISOString()}
      />

      {/* Hero Header */}
      <header className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between border-b border-vault-border/20 pb-8">
        <div className="space-y-4 max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1 text-xs font-medium text-vault-muted backdrop-blur-md transition-all duration-300">
            <Sparkles className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
            {t("routes.dashboard.tagline")}
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-vault-text sm:text-4xl lg:text-5xl bg-gradient-to-r from-vault-text via-vault-text to-red-500 bg-clip-text text-transparent">
            {t("routes.dashboard.title")}
          </h1>
          <p className="text-base text-vault-muted leading-relaxed">
            {t("routes.dashboard.subtitle")}
          </p>
        </div>
        <div className="w-full lg:max-w-md shrink-0">
          <PrizeCountdown targetDate={nextDrawDate} />
        </div>
      </header>

      {/* Vault Metrics (full-width, below hero) */}
      <VaultMetricsCards />

      {/* Main Grid */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left Column */}
        <main className="space-y-8 lg:col-span-8">
          <OnboardingChecklist walletConnected={isConnected} hasJoinedVault={hasJoinedVault} />
          {isConnected && !hasJoinedVault && (
            <VaultEmptyState variant="dashboard" />
          )}
          <YieldCalculator />
          <RecentWinners />
          <VaultLeaderboardPlaceholder />
          <VaultDocsQuickLinks />
          <OnboardingCards />
          <FaqAccordion />
        </main>

        {/* Right Column */}
        <aside className="space-y-8 lg:col-span-4">
          <div className="vq-glass p-6 space-y-6">
            <h3 className="text-lg font-bold text-vault-text border-b border-vault-border/30 pb-3">
              Protocol Statistics
            </h3>
            <PublicStatsBar layout="vertical" />
          </div>

          {isConnected && (
            <>
              <VaultGoalTracker currentBalance={1250} />
              <WalletConnectionStatus
                walletAddress={address ?? null}
                network={chain?.name ?? null}
                isNetworkMismatch={isConnected && !chain}
                onReconnect={() => openConnectModal?.()}
              />
              <BridgeStatusTracker
                sourceTxHash="0x1234567890abcdef1234567890abcdef12345678"
                destinationTxHash={null}
                currentStep={2}
                sourceChain="Avalanche"
                destinationChain="Stellar"
                estimatedTime={180}
              />
            </>
          )}

          <section className="vq-glass p-6 text-center sm:p-8 relative overflow-hidden group">
            <div className="absolute -right-16 -top-16 w-32 h-32 rounded-full bg-red-500/10 blur-xl transition-all duration-300 group-hover:scale-125" />
            <h2 className="text-xl font-bold text-vault-text">{t("routes.dashboard.joinTitle")}</h2>
            <p className="mt-2 text-sm text-vault-muted">
              {isConnected
                ? t("routes.dashboard.connectedBody")
                : t("routes.dashboard.disconnectedBody")}
            </p>
            <div className="mt-6 flex flex-col gap-3">
              {onboardingStep === 0 ? (
                <button type="button" onClick={handleStartSaving} className="vq-btn-primary w-full">
                  {t("routes.dashboard.startSaving")}
                </button>
              ) : (
                <>
                  <Link href="/app/prizes" className="vq-btn-primary w-full">{t("routes.dashboard.viewAllPrizes")}</Link>
                  <Link href="/app/vaults" className="vq-btn-ghost w-full">{t("routes.dashboard.manageVaults")}</Link>
                </>
              )}
              {!isConnected && onboardingStep === 0 && (
                <button type="button" onClick={() => openConnectModal?.()} className="vq-btn-ghost w-full">
                  {t("routes.dashboard.connectWallet")}
                </button>
              )}
            </div>
          </section>

          <div className="flex justify-center">
            <VaultRewardsExplanationModal />
          </div>
        </aside>
      </div>
    </div>
  );
}
