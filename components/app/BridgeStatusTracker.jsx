"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, Circle, Clock, ExternalLink, AlertCircle, RefreshCw } from "lucide-react";
import { buildStellarExplorerUrl } from "@/lib/stellar-explorer";
import { defaultVaultDataConfig } from "@vaultquest/stellar-wallet-connect/src/vault/data/config";

const BRIDGE_STEPS = [
  { id: "deposit", label: "Deposit Verification", chain: "origin" },
  { id: "lockup", label: "Lockup on Origin Chain", chain: "origin" },
  { id: "relay", label: "Cross-Chain Relay", chain: "both" },
  { id: "mint", label: "Mint/Release on Destination", chain: "destination" },
  { id: "complete", label: "Transaction Complete", chain: "destination" },
];

export default function BridgeStatusTracker({
  sourceTxHash = null,
  destinationTxHash = null,
  currentStep = 0,
  sourceChain = "Avalanche",
  destinationChain = "Stellar",
  estimatedTime = 180,
  onRetry = null,
}) {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isStalled, setIsStalled] = useState(false);

  useEffect(() => {
    if (currentStep >= BRIDGE_STEPS.length - 1) {
      setIsStalled(false);
      return;
    }

    const timer = setInterval(() => {
      setElapsedTime((prev) => {
        const next = prev + 1;
        if (next > estimatedTime * 1.5) {
          setIsStalled(true);
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [currentStep, estimatedTime]);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getExplorerUrl = (txHash, chain) => {
    if (chain !== "Stellar") {
      return null;
    }

    return buildStellarExplorerUrl(
      { type: "transaction", reference: txHash },
      defaultVaultDataConfig.network.name,
    );
  };

  const getStepStatus = (index) => {
    if (index < currentStep) return "complete";
    if (index === currentStep) return "active";
    return "pending";
  };

  return (
    <div className="vq-glass w-full max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-vault-text">
            Bridge Status Tracker
          </h3>
          <p className="mt-1 text-sm text-vault-muted">
            {sourceChain} → {destinationChain}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Clock className="h-4 w-4 text-vault-muted" aria-hidden="true" />
          <span className="text-vault-muted">
            {currentStep >= BRIDGE_STEPS.length - 1
              ? "Completed"
              : `${formatTime(elapsedTime)} / ${formatTime(estimatedTime)}`}
          </span>
        </div>
      </div>

      <div className="relative space-y-4">
        {BRIDGE_STEPS.map((step, index) => {
          const status = getStepStatus(index);
          const isActive = status === "active";
          const isComplete = status === "complete";

          return (
            <motion.div
              key={step.id}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
              className="relative flex items-start gap-4"
            >
              <div className="relative flex flex-col items-center">
                <motion.div
                  className={`z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all duration-300 ${
                    isComplete
                      ? "border-green-500 bg-green-500/20"
                      : isActive
                        ? "border-red-500 bg-red-500/20"
                        : "border-vault-border bg-vault-surface"
                  }`}
                  animate={
                    isActive
                      ? {
                          boxShadow: [
                            "0 0 0 0 rgba(239, 68, 68, 0.4)",
                            "0 0 0 8px rgba(239, 68, 68, 0)",
                          ],
                        }
                      : {}
                  }
                  transition={{
                    duration: 1.5,
                    repeat: isActive ? Infinity : 0,
                    repeatType: "loop",
                  }}
                >
                  {isComplete ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  ) : isActive ? (
                    <RefreshCw className="h-5 w-5 animate-spin text-red-500" />
                  ) : (
                    <Circle className="h-5 w-5 text-vault-muted" />
                  )}
                </motion.div>
                {index < BRIDGE_STEPS.length - 1 && (
                  <div
                    className={`mt-1 h-12 w-0.5 transition-all duration-500 ${
                      isComplete ? "bg-green-500/50" : "bg-vault-border"
                    }`}
                  />
                )}
              </div>

              <div className="flex-1 pb-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h4
                      className={`text-sm font-medium transition-colors duration-300 ${
                        isActive
                          ? "text-red-500"
                          : isComplete
                            ? "text-green-500"
                            : "text-vault-muted"
                      }`}
                    >
                      {step.label}
                    </h4>
                    <p className="mt-1 text-xs text-vault-muted">
                      {step.chain === "origin"
                        ? sourceChain
                        : step.chain === "destination"
                          ? destinationChain
                          : "Cross-Chain"}
                    </p>
                  </div>
                  <AnimatePresence mode="wait">
                    {isActive && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.8 }}
                        className="rounded-full bg-red-500/10 px-3 py-1 text-xs font-medium text-red-500"
                      >
                        In Progress
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="space-y-3 border-t border-vault-border pt-4">
        {sourceTxHash && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs font-medium text-vault-muted">
              Source Transaction:
            </span>
            {getExplorerUrl(sourceTxHash, sourceChain) ? (
              <a
                href={getExplorerUrl(sourceTxHash, sourceChain)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-vault-surface px-3 py-1.5 text-xs font-mono text-vault-text transition-all duration-300 hover:bg-red-500/10 hover:text-red-500"
              >
                <span className="truncate max-w-[200px]">{sourceTxHash}</span>
                <ExternalLink className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              </a>
            ) : (
              <span className="rounded-lg bg-vault-surface px-3 py-1.5 font-mono text-xs text-vault-text">
                {sourceTxHash}
              </span>
            )}
          </div>
        )}
        {destinationTxHash && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs font-medium text-vault-muted">
              Destination Transaction:
            </span>
            {getExplorerUrl(destinationTxHash, destinationChain) ? (
              <a
                href={getExplorerUrl(destinationTxHash, destinationChain)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-vault-surface px-3 py-1.5 text-xs font-mono text-vault-text transition-all duration-300 hover:bg-red-500/10 hover:text-red-500"
              >
                <span className="truncate max-w-[200px]">{destinationTxHash}</span>
                <ExternalLink className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
              </a>
            ) : (
              <span className="rounded-lg bg-vault-surface px-3 py-1.5 font-mono text-xs text-vault-text">
                {destinationTxHash}
              </span>
            )}
          </div>
        )}
      </div>

      <AnimatePresence>
        {isStalled && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 flex-shrink-0 text-yellow-500" />
              <div className="flex-1 space-y-2">
                <h4 className="text-sm font-semibold text-yellow-500">
                  Transaction Stalled
                </h4>
                <p className="text-xs text-vault-muted">
                  This transaction is taking longer than expected. This can happen
                  during high network congestion. You can wait for automatic retry or
                  check the transaction status on the block explorer.
                </p>
                {onRetry && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-2 inline-flex items-center gap-2 rounded-lg bg-yellow-500/20 px-3 py-1.5 text-xs font-medium text-yellow-500 transition-all duration-300 hover:bg-yellow-500/30"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry Transaction
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
