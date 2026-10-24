"use client";

import { useAccount } from "wagmi";
import { useEffect, useState } from "react";
import { Sparkles, Wallet, Copy, Check } from "lucide-react";

function truncateAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function DashboardWelcomeCard() {
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => setMounted(true), []);

  const displayName = isConnected && address
    ? truncateAddress(address)
    : "Guest";

  const handleCopy = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (!mounted) return null;

  return (
    <div className="vq-glass relative overflow-hidden p-6 sm:p-8">
      <div className="absolute -right-16 -top-16 h-32 w-32 rounded-full bg-red-500/10 blur-2xl" />
      <div className="absolute -bottom-16 -left-16 h-32 w-32 rounded-full bg-amber-500/10 blur-2xl" />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-vault-border bg-vault-surface px-3 py-1 text-xs font-medium text-vault-muted backdrop-blur-md">
            <Sparkles className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />
            Welcome back
          </div>
          <h1 className="text-2xl font-extrabold tracking-tight text-vault-text sm:text-3xl">
            {displayName}
          </h1>
          <p className="text-sm text-vault-muted">
            Here&apos;s your savings overview and recent activity.
          </p>
        </div>

        {isConnected && address && (
          <button
            type="button"
            onClick={handleCopy}
            className="vq-btn-ghost inline-flex items-center gap-2 text-xs"
            aria-label={copied ? "Address copied" : "Copy wallet address"}
          >
            <Wallet className="h-4 w-4" aria-hidden="true" />
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-green-500" />
                Copied
              </>
            ) : (
              truncateAddress(address)
            )}
          </button>
        )}
      </div>
    </div>
  );
}
