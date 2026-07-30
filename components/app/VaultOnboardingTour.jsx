"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronRight, RotateCcw, LayoutDashboard, CreditCard, UserCircle, SkipForward } from "lucide-react";

const STORAGE_KEY = "vq_onboarding_tour_done";

const TOUR_STEPS = [
  {
    icon: LayoutDashboard,
    title: "Welcome to VaultQuest",
    body: "This is your dashboard. It shows live protocol stats, your savings progress, and the next prize draw countdown. Everything you need is right here.",
    accent: "from-red-500/15 to-orange-500/10",
  },
  {
    icon: CreditCard,
    title: "Vault cards explained",
    body: "Each vault card shows the pool's APY, the current prize pool size, and your share. Your principal is always withdrawable in full — you cannot lose what you put in.",
    accent: "from-violet-500/15 to-indigo-500/10",
  },
  {
    icon: UserCircle,
    title: "Your account page",
    body: "The Account page tracks your live yield, prize history, and badges. You can also edit your profile and manage notification preferences there.",
    accent: "from-emerald-500/15 to-teal-500/10",
  },
];

export default function VaultOnboardingTour() {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) !== "true") {
        setVisible(true);
      }
    } catch {
      setVisible(true);
    }
  }, []);

  const finish = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // storage unavailable
    }
    setVisible(false);
  };

  const next = () => {
    if (step < TOUR_STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      finish();
    }
  };

  const isLast = step === TOUR_STEPS.length - 1;
  const current = TOUR_STEPS[step];
  const Icon = current.icon;

  return (
    <AnimatePresence>
      {visible && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9000] bg-black/50 backdrop-blur-sm"
            onClick={finish}
            aria-hidden="true"
          />

          {/* Tour card */}
          <motion.div
            key={`step-${step}`}
            role="dialog"
            aria-modal="true"
            aria-label={`Onboarding tour — step ${step + 1} of ${TOUR_STEPS.length}`}
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 12 }}
            transition={{ type: "spring", damping: 24, stiffness: 300 }}
            className="fixed inset-x-4 bottom-6 z-[9001] mx-auto max-w-md rounded-2xl border border-vault-border bg-vault-bg shadow-2xl sm:bottom-8 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2"
          >
            {/* Step gradient accent */}
            <div
              className={`absolute inset-0 rounded-2xl bg-gradient-to-br ${current.accent} pointer-events-none`}
              aria-hidden="true"
            />

            <div className="relative p-6">
              {/* Header */}
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-red-500 dark:text-red-400">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <button
                  type="button"
                  onClick={finish}
                  aria-label="Close tour"
                  className="rounded-lg p-1.5 text-vault-muted transition-colors hover:bg-vault-surface hover:text-vault-text"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              {/* Content */}
              <h2 className="mt-4 text-base font-bold text-vault-text">
                {current.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-vault-muted">
                {current.body}
              </p>

              {/* Step dots */}
              <div className="mt-5 flex items-center gap-1.5" aria-hidden="true">
                {TOUR_STEPS.map((_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      i === step
                        ? "w-5 bg-red-500"
                        : i < step
                          ? "w-1.5 bg-red-500/40"
                          : "w-1.5 bg-vault-border"
                    }`}
                  />
                ))}
              </div>

              {/* Actions */}
              <div className="mt-5 flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={finish}
                  className="flex items-center gap-1.5 text-xs font-medium text-vault-muted hover:text-vault-text transition-colors"
                >
                  <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
                  Skip tour
                </button>

                <button
                  type="button"
                  onClick={next}
                  className="vq-btn-primary"
                >
                  {isLast ? "Done" : "Next"}
                  {!isLast && (
                    <ChevronRight className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/**
 * Utility to reset the tour so users can replay it from the account page.
 * Returns a handler function to attach to a button.
 */
export function useRestartTour(onRestart) {
  return () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage unavailable
    }
    onRestart?.();
  };
}
