"use client";

import * as Accordion from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";

const FAQ_ITEMS = [
  {
    id: "no-loss",
    question: "What is no-loss prize savings?",
    content: (
      <>
        <p>
          VaultQuest pools saver deposits on Stellar. Yield from the pool funds periodic prize
          drawings while your <strong>principal stays fully withdrawable</strong> at any time.
        </p>
        <p className="mt-3">
          You never risk your deposit to enter a draw—only accrued yield is allocated to winners.
        </p>
      </>
    ),
  },
  {
    id: "vault-mechanics",
    question: "How do vault mechanics work?",
    content: (
      <>
        <p>
          Each vault is a Soroban smart contract. You <strong>join</strong> a pool with a deposit;
          the contract tracks your position on-chain as the source of truth for balances and
          eligibility.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5">
          <li>
            <strong>Create</strong> — an admin opens a new prize pool.
          </li>
          <li>
            <strong>Join</strong> — you deposit assets into the pool.
          </li>
          <li>
            <strong>Drip</strong> — yield is routed into the prize pool on schedule.
          </li>
          <li>
            <strong>Claim / Withdraw</strong> — winners claim prizes; anyone can withdraw principal
            in full.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "drawings",
    question: "How are prize drawings conducted?",
    content: (
      <>
        <p>
          When a round ends, accrued yield in the prize pool is awarded to a selected participant.
          Non-winners keep their deposits intact—there is no loss of principal from the draw itself.
        </p>
        <p className="mt-3">
          Draw timing and cadence depend on each vault&apos;s configuration. Check the pool detail
          view for the next draw window and prize pool size before you join.
        </p>
      </>
    ),
  },
  {
    id: "safety",
    question: "What safety measures protect my deposit?",
    content: (
      <>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>On-chain state</strong> — balances and withdraw rights live in the Soroban
            contract, not only in the app UI.
          </li>
          <li>
            <strong>No-loss design</strong> — prize funding comes from yield, not from seizing
            principal.
          </li>
          <li>
            <strong>Intent ledger</strong> — the backend records your transaction intents and
            reconciles them against contract events so status stays accurate after reconnects.
          </li>
        </ul>
        <p className="mt-3">
          Always verify transaction details in your wallet before signing, and use official network
          passphrases for testnet vs mainnet.
        </p>
      </>
    ),
  },
  {
    id: "fees",
    question: "What network fees should I expect?",
    content: (
      <>
        <p>
          Stellar charges a small <strong>base fee per operation</strong> (typically 100 stroops =
          0.00001 XLM per operation unless the network is congested). Soroban contract invocations
          may include additional resource fees based on CPU, memory, and ledger entry usage.
        </p>
        <p className="mt-3">
          Accounts must maintain the Stellar minimum balance (base reserve plus subentries). EVM
          flows on Avalanche use separate gas fees paid in AVAX. VaultQuest does not add a protocol
          deposit fee beyond on-chain network costs.
        </p>
      </>
    ),
  },
];

export default function FaqAccordion() {
  return (
    <section className="vq-glass mx-auto w-full max-w-3xl p-6 sm:p-8" aria-labelledby="faq-heading">
      <h2 id="faq-heading" className="text-xl font-semibold text-vault-text sm:text-2xl">
        Frequently asked questions
      </h2>
      <p className="mt-2 text-sm text-vault-muted">
        Learn how vaults, drawings, and fees work before you deposit.
      </p>

      <Accordion.Root type="single" collapsible className="mt-6 space-y-2">
        {FAQ_ITEMS.map((item) => (
          <Accordion.Item
            key={item.id}
            value={item.id}
            className="overflow-hidden rounded-xl border border-vault-border bg-vault-surface/60"
          >
            <Accordion.Header>
              <Accordion.Trigger className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-vault-text transition-colors hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-vault-bg dark:hover:text-red-400">
                {item.question}
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-vault-muted transition-transform duration-200 group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className="vq-accordion-content vq-faq-content text-sm leading-relaxed">
              <div className="px-4 pb-4 pt-0">{item.content}</div>
            </Accordion.Content>
          </Accordion.Item>
        ))}
      </Accordion.Root>
    </section>
  );
}
