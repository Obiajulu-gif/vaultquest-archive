"use client";

import { useState } from "react";
import { ChevronDown, HelpCircle, ExternalLink } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const FAQ_ITEMS = [
  {
    category: "Wallet",
    question: "How do I connect my wallet?",
    answer:
      "Click the 'Connect Wallet' button in the top right corner and select your preferred wallet provider. We support all major Stellar wallets including Freighter and Lobstr.",
  },
  {
    category: "Wallet",
    question: "Is my wallet secure?",
    answer:
      "Your wallet remains fully under your control. We never store your private keys. All transactions require your explicit approval through your wallet.",
  },
  {
    category: "Vaults",
    question: "What is a vault?",
    answer:
      "A vault is a savings pool where your deposits earn yield while automatically entering you into prize drawings. The longer you hold, the more tickets you earn.",
  },
  {
    category: "Vaults",
    question: "Can I withdraw anytime?",
    answer:
      "Most vaults offer flexible withdrawals. Some vaults have lockup periods for higher APY. Check the vault details before depositing.",
  },
  {
    category: "Rounds",
    question: "How do prize rounds work?",
    answer:
      "Prize rounds typically run weekly. Your deposit balance determines your ticket count. Winners are selected randomly, and prizes are distributed automatically.",
  },
  {
    category: "Rounds",
    question: "When are prizes distributed?",
    answer:
      "Prizes are distributed automatically within 24 hours after each round closes. You'll receive a notification when you win.",
  },
  {
    category: "Actions",
    question: "How long do transactions take?",
    answer:
      "Most transactions complete within 5-10 seconds on Stellar. You can track transaction status in your activity feed.",
  },
  {
    category: "Actions",
    question: "What are the fees?",
    answer:
      "Network fees are minimal (usually less than $0.01). There are no platform fees for deposits or withdrawals. Prize winnings are fee-free.",
  },
];

export default function VaultFaqSection() {
  const [openIndex, setOpenIndex] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState("All");

  const categories = [
    "All",
    ...new Set(FAQ_ITEMS.map((item) => item.category)),
  ];

  const filteredItems =
    selectedCategory === "All"
      ? FAQ_ITEMS
      : FAQ_ITEMS.filter((item) => item.category === selectedCategory);

  return (
    <section className="vq-glass p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vault-accent/10 text-vault-accent border border-vault-accent/20">
          <HelpCircle size={20} />
        </div>
        <div>
          <h2 className="text-xl font-bold text-vault-text">
            Frequently Asked Questions
          </h2>
          <p className="text-sm text-vault-muted">
            Quick answers to common questions
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((category) => (
          <button
            key={category}
            onClick={() => setSelectedCategory(category)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors
              ${
                selectedCategory === category
                  ? "bg-vault-accent text-white"
                  : "bg-vault-surface text-vault-muted hover:text-vault-text border border-vault-border"
              }`}
          >
            {category}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {filteredItems.map((item, index) => {
          const isOpen = openIndex === index;
          return (
            <div
              key={index}
              className="border border-vault-border rounded-lg overflow-hidden bg-vault-surface"
            >
              <button
                onClick={() => setOpenIndex(isOpen ? null : index)}
                className="w-full px-4 py-4 flex items-start justify-between gap-4 text-left hover:bg-vault-surface/50 transition-colors"
              >
                <div className="flex-1">
                  <span className="text-xs font-medium text-vault-accent uppercase tracking-wider">
                    {item.category}
                  </span>
                  <p className="text-vault-text font-medium mt-1">
                    {item.question}
                  </p>
                </div>
                <ChevronDown
                  size={20}
                  className={`flex-shrink-0 text-vault-muted transition-transform ${
                    isOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0 }}
                    animate={{ height: "auto" }}
                    exit={{ height: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 text-sm text-vault-muted border-t border-vault-border pt-4">
                      {item.answer}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-vault-border">
        <p className="text-sm text-vault-muted">Need more help?</p>
        <a
          href="/docs"
          className="vq-btn-ghost flex items-center gap-2 text-sm"
        >
          View Documentation
          <ExternalLink size={14} />
        </a>
      </div>
    </section>
  );
}
