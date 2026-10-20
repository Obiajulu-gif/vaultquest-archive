import type { FC } from "react";
import { Gift, Home, User, Wallet } from "lucide-react";

const NAV_ITEMS = [
  { label: "Home", href: "/app", icon: Home },
  { label: "Prizes", href: "/app/prizes", icon: Gift },
  { label: "Vaults", href: "/app/vaults", icon: Wallet },
  { label: "Account", href: "/app/account", icon: User },
] as const;

export interface MobileBottomNavProps {
  currentPath: string;
  onNavigate: (href: string) => void;
  /**
   * When true, the user is mid-transaction (signing, submitting, confirming).
   * Navigation taps show a warning dialog asking the user to confirm they want
   * to leave — the transaction state will be persisted and can be recovered on
   * return (#633).
   */
  txBusy?: boolean;
  /**
   * Human-readable label for the active transaction stage, shown in the
   * navigation-guard prompt (e.g. "awaiting-signature").  Falls back to a
   * generic message when absent.
   */
  txStageLabel?: string;
}

export const MobileBottomNav: FC<MobileBottomNavProps> = ({
  currentPath,
  onNavigate,
  txBusy = false,
  txStageLabel,
}) => {
  function handleNavClick(href: string) {
    if (txBusy) {
      const stage = txStageLabel ? ` (${txStageLabel})` : "";
      const confirmed = window.confirm(
        `You have a transaction in progress${stage}.\n\n` +
          "Navigating away will not cancel it — your progress will be saved and you can recover it when you return.\n\n" +
          "Leave anyway?"
      );
      if (!confirmed) return;
    }
    onNavigate(href);
  }

  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
    >
      <div
        className="flex items-center justify-around border-t border-red-900/30 bg-[#0A0202]/90 px-2 pb-safe-or-2 pt-2"
        style={{
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)",
        }}
      >
        {NAV_ITEMS.map(({ label, href, icon: Icon }) => {
          const isActive = currentPath === href || currentPath.startsWith(href + "/");
          return (
            <button
              key={href}
              type="button"
              onClick={() => handleNavClick(href)}
              className="group relative flex flex-col items-center gap-0.5 px-3 py-1 transition-all"
              aria-current={isActive ? "page" : undefined}
            >
              {isActive && (
                <span className="absolute -top-1 left-1/2 h-1 w-6 -translate-x-1/2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]" />
              )}
              <Icon
                className={`h-5 w-5 transition-all ${
                  isActive
                    ? "scale-110 text-red-400"
                    : "text-gray-500 group-hover:text-gray-300"
                }`}
                aria-hidden="true"
              />
              <span
                className={`text-[10px] font-medium transition-colors ${
                  isActive ? "text-red-400" : "text-gray-500"
                }`}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default MobileBottomNav;
