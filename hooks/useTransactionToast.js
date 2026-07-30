"use client";

import { createContext, useContext, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, CheckCircle2, Info, X, Terminal, Loader2 } from "lucide-react";
import ErrorDebugger from "@/components/app/ErrorDebugger";

const TransactionToastContext = createContext();

const PROGRESS_MESSAGES = {
  deposit: {
    pending: { title: "Depositing...", description: "Sending deposit transaction to the network." },
    success: { title: "Deposit Confirmed", description: "Your deposit has been successfully processed." },
    error: { title: "Deposit Failed", description: "The deposit transaction could not be completed." },
  },
  withdraw: {
    pending: { title: "Withdrawing...", description: "Sending withdrawal transaction to the network." },
    success: { title: "Withdrawal Confirmed", description: "Your withdrawal has been successfully processed." },
    error: { title: "Withdrawal Failed", description: "The withdrawal transaction could not be completed." },
  },
  claim: {
    pending: { title: "Claiming Prize...", description: "Sending claim transaction to the network." },
    success: { title: "Prize Claimed", description: "Your prize has been successfully claimed." },
    error: { title: "Claim Failed", description: "The claim transaction could not be completed." },
  },
  wallet: {
    pending: { title: "Confirm in Wallet", description: "Check your wallet to confirm the transaction." },
    success: { title: "Wallet Connected", description: "Wallet connection successful." },
    error: { title: "Wallet Action Failed", description: "The wallet action could not be completed." },
  },
};

export function TransactionToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [debugError, setDebugError] = useState(null);
  const [isDebuggerOpen, setIsDebuggerOpen] = useState(false);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((type, title, description, error = null) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, type, title, description, error }]);

    if (type === "pending") {
      setTimeout(() => {
        removeToast(id);
      }, 30000);
    } else if (type !== "error" || !error) {
      setTimeout(() => {
        removeToast(id);
      }, 6000);
    }
  }, [removeToast]);

  const addProgressToast = useCallback((action, stage, error = null) => {
    const messages = PROGRESS_MESSAGES[action] || PROGRESS_MESSAGES.wallet;
    const msg = messages[stage] || messages.pending;
    const type = stage === "pending" ? "pending" : stage === "success" ? "success" : "error";
    addToast(type, msg.title, msg.description, error);
  }, [addToast]);

  const openDebugger = useCallback((error) => {
    setDebugError(error);
    setIsDebuggerOpen(true);
  }, []);

  const closeDebugger = useCallback(() => {
    setIsDebuggerOpen(false);
  }, []);

  return (
    <TransactionToastContext.Provider value={{ addToast, removeToast, openDebugger, addProgressToast }}>
      {children}

      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-3 pointer-events-none">
        <AnimatePresence mode="popLayout">
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, x: 40, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 20, scale: 0.95 }}
              className={`pointer-events-auto flex w-80 items-start gap-3 rounded-2xl border p-4 shadow-glass backdrop-blur-xl transition-colors ${
                toast.type === "error"
                  ? "border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400"
                  : toast.type === "success"
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                  : toast.type === "pending"
                  ? "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400"
                  : "border-vault-border bg-vault-surface/90 text-vault-text"
              }`}
            >
              <div className="mt-0.5 shrink-0">
                {toast.type === "error" && <AlertCircle className="h-5 w-5" />}
                {toast.type === "success" && <CheckCircle2 className="h-5 w-5" />}
                {toast.type === "pending" && <Loader2 className="h-5 w-5 animate-spin" />}
                {toast.type === "info" && <Info className="h-5 w-5 text-vault-muted" />}
              </div>

              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold tracking-tight leading-none">{toast.title}</div>
                <div className="mt-1.5 text-xs opacity-70 leading-relaxed line-clamp-2">
                  {toast.description}
                </div>

                {toast.error && (
                  <button
                    onClick={() => {
                      openDebugger(toast.error);
                      removeToast(toast.id);
                    }}
                    className="mt-3 flex items-center gap-1.5 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all hover:bg-red-500/20 active:scale-95"
                  >
                    <Terminal className="h-3 w-3" />
                    Debug Error
                  </button>
                )}
              </div>

              <button
                onClick={() => removeToast(toast.id)}
                className="mt-0.5 rounded-lg p-1 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                aria-label="Dismiss toast"
              >
                <X className="h-3.5 w-3.5 opacity-40" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <ErrorDebugger
        isOpen={isDebuggerOpen}
        error={debugError}
        onClose={closeDebugger}
      />
    </TransactionToastContext.Provider>
  );
}

export function useTransactionToast() {
  const context = useContext(TransactionToastContext);
  if (!context) {
    throw new Error("useTransactionToast must be used within a TransactionToastProvider");
  }
  return context;
}
