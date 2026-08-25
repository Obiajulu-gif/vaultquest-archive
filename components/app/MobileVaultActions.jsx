"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Gift,
  CheckCircle2,
  X,
} from "lucide-react";

export default function MobileVaultActions({ vaultName, onAction }) {
  const [showConfirm, setShowConfirm] = useState(null);

  const actions = [
    {
      id: "deposit",
      label: "Deposit",
      icon: ArrowDownToLine,
      color: "emerald",
    },
    {
      id: "withdraw",
      label: "Withdraw",
      icon: ArrowUpFromLine,
      color: "amber",
    },
    { id: "claim", label: "Claim", icon: Gift, color: "purple" },
  ];

  const handleAction = (actionId) => {
    setShowConfirm(actionId);
  };

  const confirmAction = () => {
    onAction?.(showConfirm);
    setShowConfirm(null);
  };

  return (
    <>
      <div className="grid grid-cols-3 gap-3 sm:hidden">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              onClick={() => handleAction(action.id)}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all active:scale-95
                bg-${action.color}-500/5 border-${action.color}-500/20 text-${action.color}-600 dark:text-${action.color}-400
                hover:bg-${action.color}-500/10`}
              style={{ minHeight: "80px" }}
            >
              <Icon size={24} />
              <span className="text-sm font-medium">{action.label}</span>
            </button>
          );
        })}
      </div>

      <AnimatePresence>
        {showConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 z-50 flex items-end sm:items-center justify-center p-4"
            onClick={() => setShowConfirm(null)}
          >
            <motion.div
              initial={{ y: 100, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 100, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-vault-surface border border-vault-border rounded-2xl p-6 space-y-4"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-vault-text">
                    Confirm {showConfirm}
                  </h3>
                  <p className="text-sm text-vault-muted mt-1">
                    {vaultName || "Selected vault"}
                  </p>
                </div>
                <button
                  onClick={() => setShowConfirm(null)}
                  className="text-vault-muted hover:text-vault-text"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirm(null)}
                  className="flex-1 vq-btn-ghost"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmAction}
                  className="flex-1 vq-btn-primary flex items-center justify-center gap-2"
                >
                  <CheckCircle2 size={16} />
                  Confirm
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
