"use client";

import { ArrowLeftRight, Gift, Shield, Wallet } from "lucide-react";

const STEPS = [
  {
    icon: Shield,
    title: "No-loss prize savings",
    description:
      "Deposit into pooled vaults. Yield funds weekly prizes while your principal stays fully withdrawable.",
    accent: "from-red-500/20 to-orange-500/10",
  },
  {
    icon: Wallet,
    title: "Connect your wallet",
    description:
      "Link a Stellar or EVM wallet to view positions, sign pool actions, and track your savings journey.",
    accent: "from-violet-500/20 to-indigo-500/10",
  },
  {
    icon: ArrowLeftRight,
    title: "Bridge & fund",
    description:
      "Move assets to the supported network, then drip into a pool. Minimum balances apply on Stellar accounts.",
    accent: "from-cyan-500/20 to-blue-500/10",
  },
  {
    icon: Gift,
    title: "Win while you save",
    description:
      "Accrued yield powers the prize pool. One saver wins each round—everyone else keeps their deposit intact.",
    accent: "from-emerald-500/20 to-teal-500/10",
  },
];

export default function OnboardingCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map((step, index) => {
        const Icon = step.icon;
        return (
          <article
            key={step.title}
            className="vq-glass-hover group relative overflow-hidden p-5"
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${step.accent} opacity-60 transition-opacity duration-300 group-hover:opacity-100`}
              aria-hidden="true"
            />
            <div className="relative">
              <span className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-red-500 shadow-glass ring-2 ring-red-400/20 transition-all duration-300 group-hover:shadow-glow dark:text-red-400">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <p className="text-xs font-medium uppercase tracking-wider text-vault-muted">
                Step {index + 1}
              </p>
              <h3 className="mt-1 text-base font-semibold text-vault-text">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-vault-muted">{step.description}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
