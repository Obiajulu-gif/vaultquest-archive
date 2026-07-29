"use client";

import Link from "next/link";
import { 
  ChevronLeft, 
  Shield, 
  Compass, 
  ArrowRight, 
  Activity, 
  TrendingUp, 
  Lock, 
  Coins 
} from "lucide-react";

const STRATEGIES = [
  {
    id: "stable-yield",
    name: "Stable Yield",
    icon: Shield,
    colorClass: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
    summary: "A low-risk strategy focused on principal preservation and consistent yield generation using premium dollar-pegged stablecoins.",
    explanation: "Perfect for beginners who want to keep their dollar value stable while growing their savings. This strategy deposits funds into highly secure lending protocols to earn steady interest without price fluctuations.",
    expectedActions: [
      "Deposit USD stablecoins (like USDC or USDT).",
      "Earn a predictable interest rate.",
      "Stay eligible for the weekly prize draws without losing any principal."
    ],
    relatedVaults: [
      { name: "USDC Stable Pool", id: 1, asset: "USDC" },
      { name: "USDT Liquidity", id: 5, asset: "USDT" }
    ]
  },
  {
    id: "flexible-drip",
    name: "Flexible Drip",
    icon: Compass,
    colorClass: "text-blue-500 bg-blue-500/10 border-blue-500/20",
    summary: "A liquid savings strategy with no lockup periods, allowing you to withdraw your assets instantly at any time.",
    explanation: "Designed for savers who want absolute freedom. You can add or withdraw funds whenever you want, making it ideal for maintaining a rainy-day fund while still getting a chance to win yield prizes.",
    expectedActions: [
      "Deposit native network assets (like XLM).",
      "Enjoy 0-day flexible lockups (instant withdrawals).",
      "Accrue prize tickets continuously for every day your funds remain in the pool."
    ],
    relatedVaults: [
      { name: "XLM Drip Vault", id: 2, asset: "XLM" }
    ]
  },
  {
    id: "growth",
    name: "Growth",
    icon: TrendingUp,
    colorClass: "text-purple-500 bg-purple-500/10 border-purple-500/20",
    summary: "A medium-term locking strategy targeting blue-chip crypto assets to compound your principal size over time.",
    explanation: "Ideal for long-term believers in major assets like Ethereum who want to grow their base holdings. By committing to a moderate lockup period, your deposits earn enhanced yields which translate to larger weekly prizes.",
    expectedActions: [
      "Deposit blue-chip crypto assets (like ETH).",
      "Commit to a standard lockup period (e.g., 30 days).",
      "Earn higher APY and compound your savings automatically."
    ],
    relatedVaults: [
      { name: "ETH Growth Pool", id: 3, asset: "ETH" }
    ]
  },
  {
    id: "high-yield",
    name: "High Yield",
    icon: Activity,
    colorClass: "text-red-500 bg-red-500/10 border-red-500/20",
    summary: "An aggressive yield strategy that leverages liquid staking and dynamic pool routing for maximum yield generation.",
    explanation: "Best suited for active participants looking for the highest possible yield and larger prize pools. This strategy routes funds through optimized staking strategies, which carries slightly higher smart contract interaction risk in exchange for stellar reward rates.",
    expectedActions: [
      "Deposit staking-enabled assets (like SOL).",
      "Lock assets for short-to-medium durations.",
      "Benefit from highest available APY and maximized ticket counts per dollar deposited."
    ],
    relatedVaults: [
      { name: "SOL Yield Max", id: 4, asset: "SOL" }
    ]
  },
  {
    id: "conservative",
    name: "Conservative",
    icon: Lock,
    colorClass: "text-orange-500 bg-orange-500/10 border-orange-500/20",
    summary: "A maximum-security strategy targeting foundational assets with longer-term lockups for absolute safety.",
    explanation: "For the patient saver who demands institutional-grade security. By locking your foundational reserve assets for longer cycles, you earn robust yields under strict risk management filters.",
    expectedActions: [
      "Deposit major reserve assets (like BTC).",
      "Commit to longer lockup durations (e.g., 90 days) for maximum security.",
      "Secure robust yield prizes with zero market exposure or risk to your principal."
    ],
    relatedVaults: [
      { name: "BTC Reserve", id: 6, asset: "BTC" }
    ]
  }
];

export default function StrategiesPage() {
  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Navigation & Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-sm text-vault-muted">
          <Link href="/app/vaults" className="hover:text-vault-text transition-colors">
            Vaults
          </Link>
          <span>/</span>
          <span className="text-vault-text font-medium">Strategies</span>
        </div>
        <Link href="/app/vaults" className="vq-btn-ghost py-1.5 px-3 self-start flex items-center gap-1">
          <ChevronLeft size={16} /> Back to Vaults
        </Link>
      </div>

      <header className="space-y-3">
        <h1 className="text-3xl font-extrabold text-vault-text sm:text-4xl">Vault Strategies Overview</h1>
        <p className="max-w-2xl text-vault-muted leading-relaxed">
          We offer a range of savings strategies tailored to your risk preference, asset types, and lockup timelines. Learn how each strategy works and choose the right vault for you.
        </p>
      </header>

      {/* Strategies List */}
      <div className="grid gap-6">
        {STRATEGIES.map((strategy) => {
          const IconComponent = strategy.icon;
          return (
            <section 
              key={strategy.id} 
              className="vq-glass p-6 sm:p-8 space-y-6 hover:shadow-glow hover:border-red-400/20 transition-all duration-300"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-4">
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${strategy.colorClass}`}>
                    <IconComponent className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="text-2xl font-bold text-vault-text">{strategy.name}</h2>
                    <p className="mt-1 text-sm font-semibold text-red-500/80 dark:text-red-400/80">
                      {strategy.summary}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid gap-6 md:grid-cols-2 pt-2 border-t border-vault-border/30">
                <div className="space-y-3">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-vault-text">How it works</h3>
                  <p className="text-sm text-vault-muted leading-relaxed">
                    {strategy.explanation}
                  </p>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-vault-text">Expected User Actions</h3>
                  <ul className="space-y-2">
                    {strategy.expectedActions.map((action, index) => (
                      <li key={index} className="flex items-start gap-2.5 text-sm text-vault-muted">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500 text-xs font-bold mt-0.5">
                          {index + 1}
                        </span>
                        <span>{action}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="pt-4 border-t border-vault-border/30 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-xs font-semibold text-vault-muted uppercase tracking-wider">
                  Available Vaults
                </span>
                <div className="flex flex-wrap gap-2">
                  {strategy.relatedVaults.map((vault) => (
                    <Link
                      key={vault.id}
                      href={`/app/vaults/${vault.id}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-2 rounded-xl border border-vault-border bg-vault-surface text-vault-text hover:border-red-400/40 hover:text-red-500 hover:shadow-glow transition-all"
                    >
                      {vault.name} ({vault.asset})
                      <ArrowRight size={12} className="opacity-75" />
                    </Link>
                  ))}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      <div className="flex justify-center pt-4">
        <Link href="/app/vaults" className="vq-btn-ghost">
          ← Return to Vaults List
        </Link>
      </div>
    </div>
  );
}
