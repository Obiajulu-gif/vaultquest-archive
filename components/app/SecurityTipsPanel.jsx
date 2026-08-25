"use client";

import { useState, useEffect } from "react";
import { X, ShieldCheck, KeyRound, Eye, LinkIcon } from "lucide-react";

const TIPS = [
  {
    icon: KeyRound,
    title: "Never share your seed phrase",
    body: "Your 12 or 24-word recovery phrase is the master key to your wallet. No legitimate app or support team will ever ask for it.",
  },
  {
    icon: ShieldCheck,
    title: "Double-check the URL",
    body: "Before connecting your wallet, confirm you are on the correct site. Bookmark it to avoid phishing copies.",
  },
  {
    icon: Eye,
    title: "Review every transaction",
    body: "Read the full details in your wallet before approving. If something looks unfamiliar, cancel and ask for help first.",
  },
  {
    icon: LinkIcon,
    title: "Use trusted bridges only",
    body: "Only move assets through official bridge integrations listed in the app. Third-party bridges can put your funds at risk.",
  },
];

const STORAGE_KEY = "vq_security_tips_dismissed";

export default function SecurityTipsPanel() {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === "true");
    } catch {
      setDismissed(false);
    }
  }, []);

  const handleDismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      // storage unavailable — dismiss in memory only
    }
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <section
      aria-label="Account security tips"
      className="vq-glass border-amber-400/30 bg-amber-500/5 p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-500/15 text-amber-500 dark:text-amber-400">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          </span>
          <h2 className="text-sm font-semibold text-vault-text">
            Keep your account safe
          </h2>
        </div>

        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss security tips"
          className="rounded-lg p-1.5 text-vault-muted transition-colors hover:bg-vault-surface hover:text-vault-text"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {TIPS.map((tip) => {
          const Icon = tip.icon;
          return (
            <div
              key={tip.title}
              className="flex gap-3 rounded-xl border border-vault-border/50 bg-vault-surface/30 p-3"
            >
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-vault-border bg-vault-surface text-vault-muted">
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <div>
                <p className="text-xs font-semibold text-vault-text">
                  {tip.title}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-vault-muted">
                  {tip.body}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-4">
        <a
          href="https://docs.vaultquest.io/security"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-vault-muted underline underline-offset-2 hover:text-vault-text"
        >
          Read the full safety guide →
        </a>
        <button
          type="button"
          onClick={handleDismiss}
          className="vq-btn-ghost h-8 px-3 text-xs"
        >
          Got it, dismiss
        </button>
      </div>
    </section>
  );
}
