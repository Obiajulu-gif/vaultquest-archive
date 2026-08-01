"use client";

import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Wallet, Shield, Coins, CheckCircle, ArrowRight, X, Compass, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { MOCK_VAULTS } from "@/lib/vault-mock-data";
import { POOL_STATUS } from "@/lib/pool-status";
import { SUPPORTED_CHAINS } from "@/lib/wagmi";

const STORAGE_KEY = "vq_first_deposit_onboarding_dismissed";

export default function FirstDepositOnboarding({ hasJoinedVault, onOpenDeposit }) {
  const { isConnected, address, chain } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [dismissed, setDismissed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") {
      setDismissed(true);
    }
  }, []);

  if (!mounted) return null;

  // Hide the guide if the user has joined a vault, or if they dismissed it.
  if (hasJoinedVault || dismissed) {
    return null;
  }

  const isSupportedNetwork = chain && SUPPORTED_CHAINS.some((c) => c.id === chain.id);

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    setDismissed(true);
  };

  const activePools = MOCK_VAULTS.filter((v) => v.status === POOL_STATUS.ACTIVE);

  return (
    <div className="vq-glass relative overflow-hidden rounded-3xl border border-red-500/20 bg-[#1A0505]/40 p-6 md:p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
      {/* Top Background Gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-red-500/10 via-transparent to-transparent pointer-events-none" />

      {/* Header */}
      <div className="relative flex items-start justify-between border-b border-vault-border/30 pb-4 mb-6">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-400">
            <Compass className="h-3.5 w-3.5 animate-spin-slow" />
            First-Deposit Onboarding Guide
          </span>
          <h2 className="text-xl md:text-2xl font-bold mt-2 text-vault-text">
            Start Your Saving Journey
          </h2>
          <p className="text-sm text-vault-muted mt-1 max-w-xl">
            Follow this path to connect your wallet, check requirements, and join your first prize-savings vault.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-xl border border-vault-border/50 p-2 text-vault-muted hover:text-vault-text hover:bg-vault-surface/40 transition-all"
          aria-label="Dismiss guide"
        >
          <X className="h-4.5 w-4.5" />
        </button>
      </div>

      {/* Grid of Steps */}
      <div className="relative grid gap-6 md:grid-cols-2 lg:grid-cols-4 mb-8">
        {/* Step 1: Wallet Connection */}
        <div className={`p-5 rounded-2xl border transition-all ${isConnected ? "border-emerald-500/20 bg-emerald-950/10" : "border-vault-border/40 bg-vault-surface/20"}`}>
          <div className="flex justify-between items-start">
            <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${isConnected ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
              <Wallet className="h-5 w-5" />
            </span>
            {isConnected ? (
              <span className="text-[10px] uppercase font-bold text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10">Connected</span>
            ) : (
              <span className="text-[10px] uppercase font-bold text-red-400 px-2 py-0.5 rounded-full bg-red-500/10">Required</span>
            )}
          </div>
          <h3 className="text-base font-semibold mt-4 text-vault-text">1. Connect Wallet</h3>
          <p className="text-xs text-vault-muted mt-1.5 leading-relaxed">
            VaultQuest uses your wallet to verify your savings balance and sign transactions.
          </p>
          {!isConnected && (
            <button
              type="button"
              onClick={openConnectModal}
              className="vq-btn-primary mt-4 w-full justify-center text-xs py-2 inline-flex items-center gap-1.5"
            >
              Connect Wallet
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Step 2: Network Check */}
        <div className={`p-5 rounded-2xl border transition-all ${isConnected && isSupportedNetwork ? "border-emerald-500/20 bg-emerald-950/10" : "border-vault-border/40 bg-vault-surface/20"}`}>
          <div className="flex justify-between items-start">
            <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${isConnected && isSupportedNetwork ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>
              <Shield className="h-5 w-5" />
            </span>
            {isConnected ? (
              isSupportedNetwork ? (
                <span className="text-[10px] uppercase font-bold text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10">Verified</span>
              ) : (
                <span className="text-[10px] uppercase font-bold text-amber-400 px-2 py-0.5 rounded-full bg-amber-500/10">Mismatch</span>
              )
            ) : (
              <span className="text-[10px] uppercase font-bold text-vault-muted px-2 py-0.5 rounded-full bg-vault-border/30">Pending</span>
            )}
          </div>
          <h3 className="text-base font-semibold mt-4 text-vault-text">2. Network Status</h3>
          <p className="text-xs text-vault-muted mt-1.5 leading-relaxed">
            Ensure your wallet is switched to a supported network.
          </p>
          {isConnected && !isSupportedNetwork && (
            <p className="text-[11px] text-amber-400 mt-2 font-medium">
              Please switch your wallet to Avalanche or Stellar testnet.
            </p>
          )}
          {isConnected && isSupportedNetwork && (
            <p className="text-[11px] text-emerald-400 mt-2 font-medium">
              Network: {chain.name}
            </p>
          )}
        </div>

        {/* Step 3: Asset & Gas Requirements */}
        <div className="p-5 rounded-2xl border border-vault-border/40 bg-vault-surface/20">
          <div className="flex justify-between items-start">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent">
              <Coins className="h-5 w-5" />
            </span>
            <span className="text-[10px] uppercase font-bold text-vault-muted px-2 py-0.5 rounded-full bg-vault-border/30">Info</span>
          </div>
          <h3 className="text-base font-semibold mt-4 text-vault-text">3. Asset & Gas Fees</h3>
          <p className="text-xs text-vault-muted mt-1.5 leading-relaxed">
            Deposit pools require USDC. You also need native tokens (AVAX/XLM) to pay transaction gas fees.
          </p>
        </div>

        {/* Step 4: Signing & Confirmation */}
        <div className="p-5 rounded-2xl border border-vault-border/40 bg-vault-surface/20">
          <div className="flex justify-between items-start">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent">
              <CheckCircle className="h-5 w-5" />
            </span>
            <span className="text-[10px] uppercase font-bold text-vault-muted px-2 py-0.5 rounded-full bg-vault-border/30">Info</span>
          </div>
          <h3 className="text-base font-semibold mt-4 text-vault-text">4. Signing & Confirmation</h3>
          <p className="text-xs text-vault-muted mt-1.5 leading-relaxed">
            Confirm your deposit in your wallet app. Transactions take seconds to settle on the blockchain ledger.
          </p>
        </div>
      </div>

      {/* Active Pools Section */}
      <div className="relative border-t border-vault-border/30 pt-6">
        <h3 className="text-base font-bold text-vault-text mb-4">
          Recommended Active Vaults
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          {activePools.map((vault) => (
            <div
              key={vault.id}
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-4 rounded-xl border border-vault-border bg-vault-surface/30 hover:bg-vault-surface/50 transition-all gap-4"
            >
              <div>
                <h4 className="font-semibold text-vault-text text-sm">{vault.name}</h4>
                <p className="text-xs text-vault-muted mt-0.5">
                  Est. APY: <span className="font-medium text-emerald-400">{vault.apy}%</span> · Network: {vault.network} ({vault.asset})
                </p>
              </div>
              <Link
                href="/app/vaults"
                className="vq-btn-primary text-xs py-2 inline-flex items-center gap-1 shrink-0 self-start sm:self-auto"
              >
                Deposit Now
                <ArrowRight className="h-3 w-3" />
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
