"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X, AlertCircle, Copy, ExternalLink, HelpCircle, ChevronRight, Check } from "lucide-react";
import { useState } from "react";

/**
 * Common error mappings for EVM and generic blockchain errors.
 */
const ERROR_DETAILS = {
  // EVM Revert Hashes
  "0x08c379a0": {
    title: "Contract Revert",
    description: "The smart contract rejected the transaction. This usually happens if a specific condition wasn't met (e.g., minimum deposit amount).",
    solution: "Check if you're trying to deposit below the minimum or if the pool has reached its capacity.",
    link: "https://docs.vaultquest.io/troubleshooting/reverts"
  },
  "0x4e487b71": {
    title: "Arithmetic Over/Underflow",
    description: "A mathematical error occurred within the contract logic.",
    solution: "This is likely a bug. Please report this error code to the support team.",
    link: "https://docs.vaultquest.io/troubleshooting/panic"
  },
  "INSUFFICIENT_FUNDS": {
    title: "Insufficient Balance",
    description: "You don't have enough tokens or native gas (AVAX) to complete this transaction.",
    solution: "Ensure your wallet has enough balance to cover both the deposit amount and the network gas fees.",
    link: "https://docs.vaultquest.io/troubleshooting/gas"
  },
  "USER_REJECTED": {
    title: "Transaction Cancelled",
    description: "You declined the transaction request in your wallet.",
    solution: "If this was a mistake, try the transaction again and approve it in your wallet.",
    link: "https://docs.vaultquest.io/troubleshooting/wallet"
  },
  "REVERTED_ON_CHAIN": {
    title: "On-Chain Revert",
    description: "The transaction was processed but failed on the blockchain.",
    solution: "Check the transaction hash on Explorer for more details. It could be due to slippage or pool changes.",
    link: "https://docs.vaultquest.io/troubleshooting/on-chain-failure"
  },
  // Stellar XDR return codes (Generic examples)
  "tx_bad_seq": {
    title: "Bad Sequence Number",
    description: "The transaction sequence number is incorrect.",
    solution: "Refresh the app to sync your wallet's sequence number and try again.",
    link: "https://docs.vaultquest.io/troubleshooting/stellar-sequence"
  },
  "op_underfunded": {
    title: "Account Underfunded",
    description: "Your Stellar account doesn't have enough XLM to cover the operation.",
    solution: "Add more XLM to your wallet to cover the minimum balance and transaction fees.",
    link: "https://docs.vaultquest.io/troubleshooting/stellar-fees"
  }
};

const getErrorData = (error) => {
  if (!error) return null;
  
  const rawCode = typeof error === 'string' ? error : (error?.code || error?.message || error?.name || "");
  const lowerCode = rawCode.toLowerCase();
  
  for (const [key, data] of Object.entries(ERROR_DETAILS)) {
    if (lowerCode.includes(key.toLowerCase())) return { ...data, rawCode };
  }
  
  return {
    title: "Transaction Failed",
    description: "An unexpected error occurred while processing your transaction.",
    solution: "Try refreshing the page or checking your internet connection. If it persists, use the details below to contact support.",
    link: "https://docs.vaultquest.io/troubleshooting/unknown",
    rawCode
  };
};

/**
 * ErrorDebugger Component
 * 
 * A slide-out drawer that decodes raw blockchain errors and provides solutions.
 */
export default function ErrorDebugger({ error, isOpen, onClose }) {
  const [copied, setCopied] = useState(false);
  const data = getErrorData(error);

  const handleCopy = () => {
    const textToCopy = typeof error === 'object' ? JSON.stringify(error, null, 2) : String(error);
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!data) return null;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 z-[10000] bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-y-0 right-0 z-[10001] w-full max-w-md border-l border-vault-border bg-vault-bg p-0 shadow-2xl"
          >
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between border-b border-vault-border p-6 bg-vault-surface/20">
                <div className="flex items-center gap-2 text-red-500">
                  <AlertCircle className="h-5 w-5" />
                  <h2 className="text-lg font-bold tracking-tight">Error Debugger</h2>
                </div>
                <button
                  onClick={onClose}
                  className="rounded-xl p-2 text-vault-muted hover:bg-vault-surface hover:text-vault-text transition-all active:scale-95"
                  aria-label="Close debugger"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8">
                <div>
                  <h3 className="mb-2 text-xl font-bold text-vault-text">{data.title}</h3>
                  <p className="text-sm leading-relaxed text-vault-muted">{data.description}</p>
                </div>

                <div className="rounded-2xl bg-vault-surface border border-vault-border p-6 shadow-sm">
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-vault-text">
                    <HelpCircle className="h-4 w-4 text-red-500" />
                    Helpful Solution
                  </div>
                  <p className="text-sm text-vault-muted mb-6 leading-relaxed">
                    {data.solution}
                  </p>
                  <a
                    href={data.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between rounded-xl bg-vault-bg px-4 py-3 text-xs font-semibold text-vault-text border border-vault-border hover:border-red-500/50 hover:bg-red-500/5 transition-all group"
                  >
                    Troubleshooting Guide
                    <ExternalLink className="h-3.5 w-3.5 text-vault-muted group-hover:text-red-500 transition-colors" />
                  </a>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-vault-text">Technical Details</div>
                    <button
                      onClick={handleCopy}
                      className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-vault-muted hover:text-red-500 transition-colors"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3 w-3" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          Copy Context
                        </>
                      )}
                    </button>
                  </div>
                  <div className="relative group">
                    <pre className="max-h-60 overflow-auto rounded-xl bg-black/30 p-4 text-[11px] font-mono text-vault-muted border border-vault-border leading-tight">
                      {typeof error === 'object' ? JSON.stringify(error, null, 2) : String(error)}
                    </pre>
                  </div>
                </div>
              </div>

              <div className="border-t border-vault-border p-6 bg-vault-surface/40 backdrop-blur-md">
                <button
                  onClick={onClose}
                  className="w-full rounded-xl bg-red-600 py-3.5 font-bold text-white shadow-lg shadow-red-500/20 transition-all hover:bg-red-700 active:scale-[0.98]"
                >
                  Close & Try Again
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
