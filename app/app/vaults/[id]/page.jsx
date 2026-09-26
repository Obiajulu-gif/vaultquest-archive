"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { buildStellarExplorerUrl } from "@/lib/stellar-explorer";
import { defaultVaultDataConfig } from "@vaultquest/stellar-wallet-connect/src/vault/data/config";
import {
  Wallet,
  ChevronLeft,
  TrendingUp,
  Coins,
  Shield,
  Calculator,
  AlertCircle,
  Copy,
  Check,
  CircleDollarSign,
  Clock,
  Server,
  Ticket,
} from "lucide-react";
import { MOCK_VAULTS } from "@/components/app/VaultList";
import DepositModal from "@/components/app/DepositModal";
import RoundStatusBadge from "@/components/app/RoundStatusBadge";
import VaultHealthStatusPanel from "@/components/app/VaultHealthStatusPanel";
import VaultRewardsExplanationModal from "@/components/app/VaultRewardsExplanationModal";
import VaultKeyboardNavAudit from "@/components/app/VaultKeyboardNavAudit";
import VaultDocsQuickLinks from "@/components/app/VaultDocsQuickLinks";
import VaultParticipantInsights from "@/components/app/VaultParticipantInsights";
import { toast } from "react-hot-toast";

function MetricTile({ label, value, tone = "default" }) {
  const toneClass = tone === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-vault-text";

  return (
    <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-vault-muted">{label}</p>
      <p className={`mt-1.5 text-xl font-black sm:text-2xl ${toneClass}`}>{value}</p>
    </div>
  );
}

function DetailSection({ icon: Icon, title, description, children }) {
  const titleId = `${title.toLowerCase().replace(/\s+/g, "-")}-title`;

  return (
    <section className="vq-glass space-y-5 p-4 sm:p-6" aria-labelledby={titleId}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-red-500">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id={titleId} className="text-lg font-bold text-vault-text">
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-vault-muted">{description}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      {/* Breadcrumb & Navigation Skeleton */}
      <div className="flex items-center gap-3">
        <div className="h-9 w-28 bg-vault-border/30 rounded-xl" />
        <div className="h-5 w-40 bg-vault-border/20 rounded" />
      </div>

      {/* Main Header Skeleton */}
      <div className="space-y-4">
        <div className="h-10 w-2/3 bg-vault-border/40 rounded-xl sm:h-12" />
        <div className="h-5 w-1/3 bg-vault-border/20 rounded" />
      </div>

      {/* Two-Column Grid Skeleton */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left Column (Stats & Calculator) */}
        <div className="space-y-8 lg:col-span-8">
          <div className="vq-glass p-6 h-56 flex flex-col justify-between">
            <div className="h-6 w-1/3 bg-vault-border/40 rounded" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="h-16 bg-vault-border/20 rounded-xl" />
              <div className="h-16 bg-vault-border/20 rounded-xl" />
              <div className="h-16 bg-vault-border/20 rounded-xl" />
              <div className="h-16 bg-vault-border/20 rounded-xl" />
            </div>
          </div>
          <div className="vq-glass p-6 h-64 bg-vault-surface/20" />
        </div>

        {/* Right Column (Actions / Wallet info) */}
        <div className="space-y-8 lg:col-span-4">
          <div className="vq-glass p-6 h-80 bg-vault-surface/40 flex flex-col justify-between" />
        </div>
      </div>
    </div>
  );
}

export default function VaultDetailPage({ params }) {
  const { id } = params;
  const { isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [mounted, setMounted] = useState(false);
  const [isDepositOpen, setIsDepositOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Estimator States
  const [calcPrincipal, setCalcPrincipal] = useState("1000");

  useEffect(() => {
    setMounted(true);
  }, []);

  const vault = useMemo(() => {
    return MOCK_VAULTS.find((v) => String(v.id) === id);
  }, [id]);

  const copyAddress = () => {
    navigator.clipboard.writeText("0x9c31A47055Cf166e5fD8dfDFf9d85449A38cCc10");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const calcEarnings = useMemo(() => {
    if (!vault) return { monthly: 0, yearly: 0 };
    const p = parseFloat(calcPrincipal) || 0;
    const yearly = p * (vault.apy / 100);
    const monthly = yearly / 12;
    return {
      monthly: monthly.toLocaleString("en-US", { style: "currency", currency: "USD" }),
      yearly: yearly.toLocaleString("en-US", { style: "currency", currency: "USD" })
    };
  }, [calcPrincipal, vault]);

  if (!mounted) {
    return <DetailSkeleton />;
  }

  if (!vault) {
    return (
      <div className="mx-auto max-w-xl py-12 text-center">
        <div className="vq-glass p-8 flex flex-col items-center gap-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
            <AlertCircle size={32} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-vault-text">Vault Not Found</h1>
            <p className="mt-2 text-sm text-vault-muted leading-relaxed">
              The vault directory index could not resolve vault ID &quot;{id}&quot;. It may have expired, changed addresses, or been archived.
            </p>
          </div>
          <Link href="/app/vaults" className="vq-btn-primary w-full text-center">
            Return to Vaults
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Top Navigation */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-vault-muted">
          <Link href="/app/vaults" className="hover:text-vault-text transition-colors">
            Vaults
          </Link>
          <span>/</span>
          <span className="text-vault-text font-medium truncate max-w-[200px]">{vault.name}</span>
        </div>
        <Link href="/app/vaults" className="vq-btn-ghost py-1.5 px-3 self-start flex items-center gap-1">
          <ChevronLeft size={16} /> Back to Vaults
        </Link>
      </div>

      {/* Hero Header */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-red-500/10 border border-red-500/20 px-3 py-1 text-xs font-semibold text-red-500">
            {vault.network}
          </span>
          <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-500">
            {vault.asset} Backed
          </span>
          <RoundStatusBadge status={vault.status} />
        </div>
        <h1 className="text-3xl font-extrabold text-vault-text sm:text-4xl">
          {vault.name}
        </h1>
        <p className="text-base text-vault-muted leading-relaxed max-w-3xl">
          Secure, principal-protected smart contract savings pool routing decentralized finance yields to weekly prize distributions.
        </p>
      </header>

      {/* Grid Layout */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left Column: Metrics & Estimator */}
        <main className="space-y-8 lg:col-span-8">
          <DetailSection
            icon={Coins}
            title="Vault Data Overview"
            description="Key vault data grouped for faster review before depositing."
          >
            <div className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-vault-text">Performance</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <MetricTile label="Est. APY" value={`${vault.apy}%`} tone="success" />
                  <MetricTile label="Deposits (TVL)" value={`$${(vault.tvl / 1000000).toFixed(2)}M`} />
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-vault-text">Access</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <MetricTile label="Lockup Period" value={vault.lockup === 0 ? "Flexible" : `${vault.lockup} Days`} />
                  <MetricTile label="Slippage Tier" value="0.10%" />
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-vault-text">Round State</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <MetricTile label="Network" value={vault.network} />
                  <MetricTile label="Strategy" value={vault.strategy} />
                </div>
              </div>
            </div>
          </DetailSection>

          {/* Dynamic Estimator */}
          <DetailSection
            icon={Calculator}
            title="Vault Yield Projection"
            description="Estimate how much yield your principal could generate over time."
          >
            <p className="text-sm text-vault-muted">
              Enter a custom deposit amount below to see the estimated non-loss yields generated by your principal over time.
            </p>
            <div className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <label htmlFor="calc-principal" className="text-sm font-semibold text-vault-text sm:w-32">
                  Deposit Amount:
                </label>
                <div className="relative flex-1 max-w-xs">
                  <span className="absolute left-3 top-2.5 text-sm font-semibold text-vault-muted">$</span>
                  <input
                    id="calc-principal"
                    type="number"
                    value={calcPrincipal}
                    onChange={(e) => setCalcPrincipal(e.target.value)}
                    className="w-full pl-7 pr-16 py-2 rounded-xl border border-vault-border bg-vault-surface text-vault-text font-semibold focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-400/30"
                    placeholder="1000"
                  />
                  <span className="absolute right-3 top-2.5 text-xs font-bold text-vault-muted uppercase">
                    {vault.asset}
                  </span>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 pt-2">
                <div className="p-4 rounded-xl border border-vault-border bg-vault-surface/30">
                  <p className="text-xs font-medium text-vault-muted uppercase">Estimated Monthly Yield</p>
                  <p className="mt-1 text-xl font-bold text-vault-text">{calcEarnings.monthly}</p>
                </div>
                <div className="p-4 rounded-xl border border-vault-border bg-vault-surface/30">
                  <p className="text-xs font-medium text-vault-muted uppercase">Estimated Annual Yield</p>
                  <p className="mt-1 text-xl font-bold text-vault-text text-emerald-500">{calcEarnings.yearly}</p>
                </div>
              </div>
            </div>
          </DetailSection>

          {/* Technical Specs */}
          <DetailSection
            icon={Server}
            title="Contract Specifications"
            description="Operational contract data and audit context for this vault."
          >
            <div className="divide-y divide-vault-border/30 text-sm">
              <div className="py-3 flex justify-between gap-4">
                <span className="text-vault-muted">Contract Standard</span>
                <span className="font-semibold text-vault-text">Soroban token-pool / ERC-4626</span>
              </div>
              <div className="py-3 flex justify-between gap-4">
                <span className="text-vault-muted">Audit Status</span>
                <span className="font-semibold text-emerald-500">Verified & Audited</span>
              </div>
              <div className="py-3 flex flex-col gap-1 sm:flex-row sm:justify-between sm:items-center">
                <span className="text-vault-muted">Contract Address</span>
                <div className="flex items-center gap-2 font-mono text-xs text-vault-muted bg-vault-surface/50 border border-vault-border/50 rounded-lg px-2.5 py-1.5 select-all">
                  <span>0x9c31A4...Cc10</span>
                  <button
                    type="button"
                    onClick={copyAddress}
                    className="hover:text-vault-text transition-colors p-0.5"
                    title="Copy Address"
                  >
                    {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>
            </div>
          </DetailSection>

          <VaultDocsQuickLinks />
        </main>

        {/* Right Column: Account metrics & CTAs */}
        <aside className="space-y-8 lg:col-span-4">
          <VaultParticipantInsights vault={vault} />
          <VaultHealthStatusPanel />
          <section className="vq-glass p-4 sm:p-6 space-y-6 relative overflow-hidden group">
            <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-red-500/10 blur-[80px]" />
            <div>
              <h2 className="text-lg font-bold text-vault-text flex items-center gap-2">
                <Shield className="h-5 w-5 text-red-500" /> Your Position Data
              </h2>
              <p className="mt-1 text-sm text-vault-muted">
                Wallet-specific vault metrics load after connection.
              </p>
            </div>

            {isConnected ? (
              <div className="space-y-6">
                <div className="grid gap-3">
                  <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-vault-text">
                      <CircleDollarSign className="h-4 w-4 text-red-500" aria-hidden="true" />
                      Balance
                    </div>
                    <div className="mt-3 flex justify-between items-center text-sm">
                      <span className="text-vault-muted">Your Deposits</span>
                      <span className="font-bold text-vault-text">1,250.00 {vault.asset}</span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-vault-border bg-vault-surface/40 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-vault-text">
                      <Ticket className="h-4 w-4 text-red-500" aria-hidden="true" />
                      Draw Eligibility
                    </div>
                    <div className="mt-3 space-y-2">
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-vault-muted">Active Tickets</span>
                        <span className="font-bold text-vault-text">125 tickets</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-vault-muted">Draw Win Chance</span>
                        <span className="font-bold text-emerald-500">~ 0.023%</span>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-xl border border-dashed border-vault-border bg-vault-bg/30 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-vault-text">
                      <Clock className="h-4 w-4 text-vault-muted" aria-hidden="true" />
                      History
                    </div>
                    <p className="mt-2 text-sm text-vault-muted">
                      No user-specific vault events are loaded in this placeholder account view.
                    </p>
                  </div>
                </div>

                <div className="border-t border-vault-border/40 pt-6 space-y-3">
                  <button
                    type="button"
                    onClick={() => setIsDepositOpen(true)}
                    className="vq-btn-primary w-full"
                  >
                    Deposit Funds
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      toast.success(
                        <div className="flex flex-col gap-1">
                          <span>Withdrawal confirmed!</span>
                          <a 
                            href={buildStellarExplorerUrl({ type: "transaction", reference: "0x9b5c32af1e57c83f949e29ae8fa9" }, defaultVaultDataConfig.network.name) ?? undefined} 
                            target="_blank" 
                            rel="noreferrer" 
                            className="text-xs underline text-emerald-500 hover:text-emerald-400"
                          >
                            View transaction
                          </a>
                        </div>,
                        { duration: 5000 }
                      );
                    }}
                    className="vq-btn-ghost w-full"
                  >
                    Withdraw Principal
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-6 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-vault-surface border border-vault-border/60 text-vault-muted">
                  <Wallet size={24} />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-vault-text">Connect Wallet to Begin</p>
                  <p className="text-xs text-vault-muted leading-relaxed">
                    Link your Web3 wallet to check your eligibility, view your deposit balance, and enter pooled draws.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => openConnectModal?.()}
                  className="vq-btn-primary w-full py-2.5"
                >
                  Connect Wallet
                </button>
              </div>
            )}
          </section>
        </aside>
      </div>

      <DepositModal isOpen={isDepositOpen} onClose={() => setIsDepositOpen(false)} />

      <div className="flex justify-center">
        <VaultRewardsExplanationModal />
      </div>

      <VaultKeyboardNavAudit />
    </div>
  );
}
