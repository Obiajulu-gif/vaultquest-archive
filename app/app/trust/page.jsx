"use client";

import {
  Shield, Scale, AlertTriangle, BookOpen, 
  CheckCircle2, ExternalLink, Users, Lock
} from "lucide-react";

const SECTIONS = [
  {
    id: "how-it-works",
    icon: BookOpen,
    title: "How VaultQuest Works",
    content: [
      "VaultQuest is a no-loss prize savings platform. Your deposits are held in smart contracts that generate yield through lending, staking, or other DeFi strategies.",
      "The yield generated from pooled deposits funds periodic prize drawings. Your original deposit (principal) remains fully withdrawable at any time — only the yield is at risk of being allocated to winners.",
      "Each round operates on a fixed schedule. During a round, deposits accumulate yield. At the end of the round, the accrued yield is distributed as prizes to randomly selected participants.",
    ]
  },
  {
    id: "key-assumptions",
    icon: Scale,
    title: "Key Assumptions",
    content: [
      "Smart contracts are secure and have been audited by reputable third-party firms. No contract is entirely immune to exploits.",
      "Yield generation strategies will produce positive returns. In rare market conditions, yield may be reduced or negative.",
      "The random selection process for prize winners is fair and verifiable. VaultQuest uses verifiable random functions (VRF) for prize draws.",
      "Blockchain networks (Stellar, Avalanche) will remain operational and accessible. Network outages may temporarily affect transactions.",
      "Oracle price feeds, if used, provide accurate and timely data within acceptable deviation thresholds.",
    ]
  },
  {
    id: "user-responsibilities",
    icon: Users,
    title: "User Responsibilities",
    content: [
      "Safeguard your wallet's private keys and recovery phrases. VaultQuest can never recover lost or stolen keys.",
      "Verify all transaction details before signing. Check amounts, gas fees, and recipient addresses in your wallet.",
      "Maintain sufficient native token balance (XLM on Stellar, AVAX on Avalanche) to cover network fees for transactions.",
      "Stay informed about the protocols and strategies used by vaults you deposit into. Read pool descriptions and documentation.",
      "Report suspicious activity or potential vulnerabilities to the VaultQuest team through the support channel.",
    ]
  },
  {
    id: "risk-considerations",
    icon: AlertTriangle,
    title: "Risk Considerations",
    content: [
      "Smart Contract Risk: Despite audits, smart contracts may contain bugs or vulnerabilities that could result in loss of funds.",
      "Market Risk: Crypto markets are volatile. The value of deposited assets may fluctuate independently of VaultQuest operations.",
      "Yield Risk: Yield generation is not guaranteed. APY rates are estimates and can change based on market conditions and strategy performance.",
      "Liquidity Risk: In certain market conditions, withdrawals from underlying protocols may be delayed or restricted.",
      "Technology Risk: Blockchain networks, oracles, and infrastructure providers may experience outages, congestion, or attacks.",
      "Regulatory Risk: The regulatory landscape for DeFi and prize-linked savings is evolving and may impact platform operations.",
    ]
  },
  {
    id: "security-measures",
    icon: Shield,
    title: "Security Measures",
    content: [
      "All smart contracts are audited by third-party security firms before deployment. Audit reports are published for community review.",
      "Funds are held in non-custodial smart contracts. VaultQuest never has direct control over user deposits.",
      "Critical operations require multi-signature approval from trusted parties, reducing the risk of unauthorized access.",
      "Real-time monitoring systems track contract activity and alert the team to unusual patterns or potential threats.",
      "Bug bounty programs incentivize responsible disclosure of vulnerabilities.",
    ]
  },
];

export default function TrustPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="text-center sm:text-left">
        <div className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1 text-xs font-medium text-vault-muted">
          <Shield className="h-3.5 w-3.5 text-red-500" />
          Trust & Transparency
        </div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-vault-text sm:text-4xl">
          Trust and Risk Information
        </h1>
        <p className="mt-3 max-w-3xl text-vault-muted">
          VaultQuest is built on principles of transparency, security, and user empowerment.
          This page outlines how the platform works, the assumptions underpinning its design,
          your responsibilities as a user, and the risks you should consider before participating.
        </p>
      </header>

      <div className="space-y-6">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <section key={section.id} className="vq-glass p-6 sm:p-8" id={section.id}>
              <div className="flex items-center gap-3 mb-5">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-red-500">
                  <Icon className="h-5 w-5" />
                </span>
                <h2 className="text-xl font-semibold text-vault-text">{section.title}</h2>
              </div>
              <div className="space-y-4">
                {section.content.map((paragraph, idx) => (
                  <div key={idx} className="flex gap-3">
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-red-500/70" />
                    <p className="text-sm leading-relaxed text-vault-muted">{paragraph}</p>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <section className="vq-glass p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-red-500">
            <ExternalLink className="h-5 w-5" />
          </span>
          <h2 className="text-xl font-semibold text-vault-text">Additional Resources</h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <a
            href="https://docs.vaultquest.io"
            target="_blank"
            rel="noopener noreferrer"
            className="vq-glass-hover flex items-center justify-between p-4"
          >
            <span className="text-sm font-medium text-vault-text">Documentation</span>
            <ExternalLink className="h-4 w-4 text-vault-muted" />
          </a>
          <a
            href="https://github.com/Obiajulu-gif/vaultquest"
            target="_blank"
            rel="noopener noreferrer"
            className="vq-glass-hover flex items-center justify-between p-4"
          >
            <span className="text-sm font-medium text-vault-text">GitHub Repository</span>
            <ExternalLink className="h-4 w-4 text-vault-muted" />
          </a>
        </div>
      </section>
    </div>
  );
}
