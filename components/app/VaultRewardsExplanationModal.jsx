"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Trophy, Calendar, UserCheck, BookOpen, Gift, Sparkles, DollarSign } from "lucide-react";
import Link from "next/link";

const REWARD_SECTIONS = [
  {
    icon: Calendar,
    title: "Reward timing",
    body: "Prize draws happen every Friday at 18:00 UTC. After each draw, winners are notified and rewards are distributed within 24 hours. You can track upcoming draws and past results from the dashboard.",
  },
  {
    icon: UserCheck,
    title: "Eligibility",
    body: "Anyone with an active deposit in a vault is automatically entered into the weekly prize draw. Your chances scale with your deposit size — the more you save, the more tickets you earn. No additional action is needed to participate.",
  },
  {
    icon: Gift,
    title: "Prize distribution",
    body: "Each vault distributes a portion of its generated yield as prizes. The prize pool is funded entirely by protocol yield — your principal is never at risk. Multiple winners are selected each round.",
  },
  {
    icon: Sparkles,
    title: "Bonus rewards",
    body: "Occasional bonus rounds, referral rewards, and milestone bonuses boost your earning potential beyond the weekly draws. Check the Prizes page for active bonus opportunities.",
  },
];

export default function VaultRewardsExplanationModal() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="vq-btn-ghost inline-flex items-center gap-2"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <Trophy className="h-4 w-4" aria-hidden="true" />
        How rewards work
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              key="reward-modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[9000] bg-black/60 backdrop-blur-md"
              onClick={() => setIsOpen(false)}
              aria-hidden="true"
            />

            <motion.div
              key="reward-modal"
              role="dialog"
              aria-modal="true"
              aria-label="How vault rewards work"
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              transition={{ type: "spring", damping: 24, stiffness: 300 }}
              className="fixed inset-4 z-[9001] mx-auto max-w-lg overflow-y-auto rounded-2xl border border-vault-border bg-vault-bg shadow-2xl sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-h-[85vh]"
            >
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-vault-border/30 bg-vault-bg/95 backdrop-blur-md px-6 py-4">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-500/15 text-amber-500">
                    <Trophy className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <h2 className="text-lg font-bold text-vault-text">
                    Vault Rewards Explained
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label="Close modal"
                  className="rounded-lg p-1.5 text-vault-muted transition-colors hover:bg-vault-surface hover:text-vault-text"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <div className="px-6 py-5 space-y-6">
                <p className="text-sm leading-relaxed text-vault-muted">
                  VaultQuest rewards you for saving. Here&apos;s how the reward system works.
                </p>

                <div className="space-y-4">
                  {REWARD_SECTIONS.map((section) => {
                    const Icon = section.icon;
                    return (
                      <div
                        key={section.title}
                        className="flex gap-3 rounded-xl border border-vault-border/50 bg-vault-surface/30 p-4"
                      >
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-vault-border bg-vault-surface text-vault-accent">
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div>
                          <h3 className="text-sm font-semibold text-vault-text">
                            {section.title}
                          </h3>
                          <p className="mt-1 text-sm leading-relaxed text-vault-muted">
                            {section.body}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-xl border border-amber-400/20 bg-amber-500/5 p-4">
                  <div className="flex items-start gap-3">
                    <DollarSign className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-semibold text-vault-text">
                        Your principal is always safe
                      </p>
                      <p className="mt-1 text-sm text-vault-muted">
                        Rewards are paid from the yield your deposit generates — your original deposit is never used for prizes. You can withdraw it anytime (subject to vault lockup periods).
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-4 pt-2">
                  <Link
                    href="/docs"
                    className="text-sm font-medium text-vault-accent hover:underline inline-flex items-center gap-1"
                  >
                    <BookOpen className="h-4 w-4" aria-hidden="true" />
                    Read full documentation
                  </Link>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className="vq-btn-primary"
                  >
                    Got it
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
