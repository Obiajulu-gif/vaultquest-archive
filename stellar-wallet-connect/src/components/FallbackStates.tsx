import type { FC, ReactNode } from "react";
import { AlertTriangle, Inbox, Loader2, RefreshCw, Wallet, WifiOff } from "lucide-react";

/**
 * Unified empty / loading / error state components for VaultQuest (#61).
 *
 * Provides a consistent fallback UI across account, vault, prize, dashboard,
 * and marketplace surfaces so the app feels polished and contributors do not
 * re-implement the same patterns on every page.
 *
 * All components share:
 *  - The dark VaultQuest theme (`bg-[#1A0505]` etc.)
 *  - Accessible labels (`role`, `aria-live`)
 *  - Optional action / retry CTAs
 *  - Mobile-first responsive layout
 *
 * Usage:
 * ```tsx
 * if (isLoading) return <LoadingState label="Loading vaults…" />;
 * if (error)     return <ErrorState message={error.message} onRetry={refetch} />;
 * if (!vaults)   return <EmptyState title="No vaults yet" />;
 * if (!wallet)   return <WalletDisconnectedState onConnect={connect} />;
 * ```
 */

// ── Shared shell ─────────────────────────────────────────────────────────────

interface ShellProps {
  children: ReactNode;
  className?: string;
  role?: "status" | "alert";
  ariaLive?: "polite" | "assertive";
}

const Shell: FC<ShellProps> = ({ children, className = "", role, ariaLive }) => (
  <div
    role={role}
    aria-live={ariaLive}
    className={`flex flex-col items-center justify-center gap-4 rounded-2xl border border-red-900/30 bg-[#1A0505]/60 px-6 py-12 text-center sm:px-10 sm:py-16 ${className}`}
  >
    {children}
  </div>
);

// ── Loading ──────────────────────────────────────────────────────────────────

export interface LoadingStateProps {
  /** Short label announced to screen readers. */
  label?: string;
  /** Optional sub-text shown beneath the spinner. */
  description?: string;
  className?: string;
}

export const LoadingState: FC<LoadingStateProps> = ({
  label = "Loading",
  description,
  className,
}) => (
  <Shell role="status" ariaLive="polite" className={className}>
    <Loader2 className="h-8 w-8 animate-spin text-red-400" aria-hidden="true" />
    <p className="text-base font-medium text-white">{label}</p>
    {description && <p className="text-sm text-gray-400">{description}</p>}
    <span className="sr-only">{label}…</span>
  </Shell>
);

// ── Empty ────────────────────────────────────────────────────────────────────

export interface EmptyStateProps {
  /** Optional custom icon. Defaults to an inbox glyph. */
  icon?: ReactNode;
  title: string;
  description?: string;
  /** Optional action button (e.g. "Create a vault"). */
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export const EmptyState: FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className,
}) => (
  <Shell className={className}>
    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-900/20 text-red-400">
      {icon ?? <Inbox className="h-7 w-7" aria-hidden="true" />}
    </div>
    <div className="space-y-1">
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      {description && (
        <p className="max-w-md text-sm text-gray-400">{description}</p>
      )}
    </div>
    {action && (
      <button
        type="button"
        onClick={action.onClick}
        className="mt-2 inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
      >
        {action.label}
      </button>
    )}
  </Shell>
);

// ── Error ────────────────────────────────────────────────────────────────────

export interface ErrorStateProps {
  message: string;
  title?: string;
  /** Optional retry callback — renders a Retry button when provided. */
  onRetry?: () => void;
  className?: string;
}

export const ErrorState: FC<ErrorStateProps> = ({
  message,
  title = "Something went wrong",
  onRetry,
  className,
}) => (
  <Shell role="alert" ariaLive="assertive" className={className}>
    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-600/20 text-red-400 border border-red-500/30">
      <AlertTriangle className="h-7 w-7" aria-hidden="true" />
    </div>
    <div className="space-y-1">
      <h3 className="text-lg font-semibold text-white">{title}</h3>
      <p className="max-w-md text-sm text-gray-400">{message}</p>
    </div>
    {onRetry && (
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 inline-flex items-center gap-2 rounded-xl border border-red-500/40 bg-red-900/30 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-900/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Try again
      </button>
    )}
  </Shell>
);

// ── Wallet-disconnected ──────────────────────────────────────────────────────

export interface WalletDisconnectedStateProps {
  /** Optional callback wired to your Connect Wallet flow. */
  onConnect?: () => void;
  className?: string;
}

export const WalletDisconnectedState: FC<WalletDisconnectedStateProps> = ({
  onConnect,
  className,
}) => (
  <Shell className={className}>
    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-900/20 text-red-400">
      <Wallet className="h-7 w-7" aria-hidden="true" />
    </div>
    <div className="space-y-1">
      <h3 className="text-lg font-semibold text-white">Wallet not connected</h3>
      <p className="max-w-md text-sm text-gray-400">
        Connect your Stellar wallet to view your vaults, prizes, and transaction history.
      </p>
    </div>
    {onConnect && (
      <button
        type="button"
        onClick={onConnect}
        className="mt-2 inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A0505]"
      >
        <Wallet className="h-4 w-4" aria-hidden="true" />
        Connect wallet
      </button>
    )}
  </Shell>
);

// ── Stale-data indicator (inline, not full-shell) ────────────────────────────

export interface StaleIndicatorProps {
  label?: string;
  className?: string;
}

/**
 * Inline pill shown when stale data is visible during a background refresh.
 * Use alongside existing data — do not replace data with this component.
 */
export const StaleIndicator: FC<StaleIndicatorProps> = ({
  label = "Refreshing…",
  className = "",
}) => (
  <span
    role="status"
    aria-live="polite"
    className={`inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300 ${className}`}
  >
    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
    {label}
  </span>
);

// ── Offline banner ───────────────────────────────────────────────────────────

export interface OfflineStateProps {
  className?: string;
}

export const OfflineState: FC<OfflineStateProps> = ({ className }) => (
  <Shell role="alert" ariaLive="assertive" className={className}>
    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-900/20 text-red-400">
      <WifiOff className="h-7 w-7" aria-hidden="true" />
    </div>
    <div className="space-y-1">
      <h3 className="text-lg font-semibold text-white">You're offline</h3>
      <p className="max-w-md text-sm text-gray-400">
        Check your internet connection and try again. We'll automatically retry once you're back online.
      </p>
    </div>
  </Shell>
);

// ── Emergency-paused banner (#645) ──────────────────────────────────────────

export interface EmergencyPausedBannerProps {
  className?: string;
}

/**
 * Inline banner shown when a pool's on-chain `is_emergency` circuit breaker
 * is active. Unlike the full-shell states above, this is meant to sit above
 * existing pool data (not replace it) — reads, balances, and history stay
 * visible while the pool is paused.
 */
export const EmergencyPausedBanner: FC<EmergencyPausedBannerProps> = ({ className = "" }) => (
  <div
    role="alert"
    aria-live="assertive"
    className={`flex items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 sm:px-5 sm:py-4 ${className}`}
  >
    <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
    <div className="space-y-1">
      <h3 className="text-sm font-semibold text-amber-200">Pool paused for recovery</h3>
      <p className="text-sm text-amber-100/80">
        Joining, deposits, and prize draws are disabled while maintainers respond to an emergency.
        Withdrawing and claiming rewards remain available, and your balances and history stay visible.
      </p>
    </div>
  </div>
);
