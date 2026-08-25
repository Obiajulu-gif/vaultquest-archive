"use client";

import { AlertTriangle } from "lucide-react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { DEFAULT_CHAIN, SUPPORTED_CHAINS } from "@/lib/wagmi";

export default function UnsupportedNetworkBanner() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) return null;

  const supported = SUPPORTED_CHAINS.some((c) => c.id === chainId);
  if (supported) return null;

  const target = DEFAULT_CHAIN;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="vq-glass mb-6 flex flex-col gap-3 border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-400 ring-2 ring-amber-400/30">
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-vault-text">Unsupported network</h2>
          <p className="mt-0.5 text-sm text-vault-muted">
            VaultQuest runs on {target.name}. Switch networks to deposit, save, and claim prizes.
          </p>
        </div>
      </div>
      <button
        type="button"
        disabled={isPending}
        onClick={() => switchChain?.({ chainId: target.id })}
        className="vq-btn-primary shrink-0 disabled:opacity-60"
      >
        {isPending ? "Switching…" : `Switch to ${target.name}`}
      </button>
    </div>
  );
}
