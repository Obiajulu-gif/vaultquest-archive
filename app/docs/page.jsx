"use client";

import Link from "next/link";
import { BookOpen, Shield, RefreshCw, Code } from "lucide-react";

export default function ProtocolDocsPage() {
  return (
    <div className="container mx-auto max-w-4xl py-12 px-6">
      <div className="mb-10 space-y-4 border-b border-vault-border pb-10">
        <div className="flex items-center gap-3 text-vault-accent">
          <BookOpen size={32} />
          <h1 className="text-4xl font-bold text-vault-text">Protocol Documentation</h1>
        </div>
        <p className="text-lg text-vault-muted">
          Learn how VaultQuest works, from the no-loss prize savings model to contributing to the core protocol.
        </p>
      </div>

      <div className="space-y-16">
        <section id="product-overview" className="scroll-mt-24 space-y-6">
          <h2 className="flex items-center gap-2 text-2xl font-semibold text-vault-text">
            <Shield className="text-vault-accent" /> Product Overview
          </h2>
          <div className="prose prose-invert max-w-none text-vault-muted">
            <p>
              VaultQuest is a no-loss prize savings protocol. Users deposit funds into a prize vault, and instead of earning standard interest, they stand a chance to win prizes through regular prize draws. The yield generated from all deposits is aggregated and distributed as prizes to randomly selected winners.
            </p>
            <h3>Vault Lifecycle</h3>
            <p>
              Vaults are created by protocol administrators or DAOs. They accept deposits in specific assets (e.g., USDC, XLM) and deploy those assets into yield-generating strategies.
            </p>
            <h3>Deposit and Withdrawal Flow</h3>
            <p>
              Users can deposit funds at any time. Depending on the vault, there may be a lockup period (e.g., 7 days) before funds can be withdrawn without penalty. This ensures the protocol has enough capital to generate meaningful yield for the prize pool.
            </p>
          </div>
        </section>

        <section id="round-lifecycle" className="scroll-mt-24 space-y-6">
          <h2 className="flex items-center gap-2 text-2xl font-semibold text-vault-text">
            <RefreshCw className="text-vault-accent" /> Round Lifecycle
          </h2>
          <div className="prose prose-invert max-w-none text-vault-muted">
            <p>
              The protocol operates in <strong>Rounds</strong>. At the end of each round:
            </p>
            <ol className="list-decimal pl-6 space-y-2">
              <li>The total yield generated across all strategies is calculated.</li>
              <li>A verifiable random function (VRF) is used to select winners based on their deposit size and duration (time-weighted balance).</li>
              <li>Prizes are distributed to the winners&apos; wallets or added to their vault balances.</li>
              <li>A new round begins immediately.</li>
            </ol>
          </div>
        </section>

        <section className="space-y-6">
          <h2 className="flex items-center gap-2 text-2xl font-semibold text-vault-text">
            <Code className="text-vault-accent" /> Contributor Guide
          </h2>
          <div className="prose prose-invert max-w-none text-vault-muted">
            <h3>Local Development Setup</h3>
            <p>To run VaultQuest locally:</p>
            <pre className="mt-2 rounded-lg bg-black/50 p-4 font-mono text-sm">
              <code>
                git clone https://github.com/yours-anjikon/vaultquest.git<br/>
                cd vaultquest<br/>
                pnpm install<br/>
                pnpm dev
              </code>
            </pre>
            <h3 className="mt-6">Contribution Workflow</h3>
            <p>
              We welcome contributions! Please branch off <code>main</code> and submit a Pull Request. Ensure you run <code>pnpm test</code> and <code>pnpm build</code> before submitting.
            </p>
          </div>
        </section>
      </div>

      <div className="mt-16 pt-8 border-t border-vault-border flex justify-between">
        <Link href="/" className="text-vault-accent hover:underline">
          &larr; Back to Home
        </Link>
        <Link href="/app" className="text-vault-accent hover:underline">
          Go to App &rarr;
        </Link>
      </div>
    </div>
  );
}
