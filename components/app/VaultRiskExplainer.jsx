"use client";

import Link from "next/link";
import { BookOpenCheck, ShieldCheck, UserCheck } from "lucide-react";

const RISK_CARDS = [
  {
    icon: ShieldCheck,
    title: "How vaults work",
    body: "Your deposit stays yours. VaultQuest pools deposits, routes the yield they generate into a prize pool, and pays your principal back in full whenever you withdraw.",
  },
  {
    icon: UserCheck,
    title: "What you're responsible for",
    body: "You choose which vault to join, how much to deposit, and when to withdraw. Lockup periods, network fees, and APY estimates vary by vault — check the details before confirming a deposit.",
  },
  {
    icon: BookOpenCheck,
    title: "Want the full picture?",
    body: "Read the protocol documentation for the complete round lifecycle, smart contract details, and how prizes are calculated.",
    link: { href: "/docs", label: "View full documentation" },
  },
];

export default function VaultRiskExplainer() {
  return (
    <section aria-label="Vault risks and responsibilities" className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-vault-text">Before you deposit</h2>
        <p className="text-sm text-vault-muted">
          A quick, beginner-friendly look at how vaults work and what&apos;s on you.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {RISK_CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <article key={card.title} className="vq-glass-hover flex flex-col gap-3 p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-accent">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="font-semibold text-vault-text">{card.title}</h3>
              <p className="text-sm leading-relaxed text-vault-muted">{card.body}</p>
              {card.link && (
                <Link
                  href={card.link.href}
                  className="mt-auto text-sm font-medium text-vault-accent hover:underline"
                >
                  {card.link.label} →
                </Link>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
