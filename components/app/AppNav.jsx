"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Activity, Bell, Contrast, Gift, Menu, Server, Shield, User, Wallet, X } from "lucide-react";
import { Settings } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import ThemeToggle from "./ThemeToggle";
import BalanceAutoRefresh from "./BalanceAutoRefresh";
import CustomRpcModal from "./CustomRpcModal";
import HeaderWalletStatus from "./HeaderWalletStatus";

const HIGH_CONTRAST_KEY = "vaultquest-high-contrast";

const LINKS = [
  { href: "/app/prizes", label: "Prizes", icon: Gift },
  { href: "/app/vaults", label: "Vaults", icon: Wallet },
  { href: "/app/account", label: "Account", icon: User },
  { href: "/app/admin/settings", label: "Admin", icon: Settings },
  { href: "/app/activity", label: "Activity", icon: Activity },
  { href: "/app/notifications", label: "Notifications", icon: Bell },
  { href: "/app/trust", label: "Trust", icon: Shield },
  { href: "/app/admin/proposals", label: "Admin", icon: Menu },
];

function applyHighContrast(enabled) {
  document.documentElement.classList.toggle("high-contrast", enabled);
}

export default function AppNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [rpcOpen, setRpcOpen] = useState(false);
  const [highContrast, setHighContrast] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(HIGH_CONTRAST_KEY) === "true";
    setHighContrast(stored);
    applyHighContrast(stored);
  }, []);

  const toggleHighContrast = useCallback(() => {
    setHighContrast((prev) => {
      const next = !prev;
      localStorage.setItem(HIGH_CONTRAST_KEY, String(next));
      applyHighContrast(next);
      return next;
    });
  }, []);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-vault-border bg-vault-surface/80 backdrop-blur-xl transition-all duration-300">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            href="/app"
            className="text-lg font-bold tracking-tight text-vault-text transition-colors duration-300 hover:text-red-500"
          >
            VaultQuest
          </Link>

          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {LINKS.map(({ href, label }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-all duration-300 ${
                    active
                      ? "bg-red-500/15 text-red-600 ring-1 ring-red-400/30 dark:text-red-400"
                      : "text-vault-muted hover:bg-vault-surface hover:text-vault-text"
                  }`}
                  aria-current={active ? "page" : undefined}
                >
                  {label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <div
              className="hidden items-center gap-1 sm:flex"
              role="group"
              aria-label="Accessibility and network settings"
            >
              <button
                type="button"
                onClick={toggleHighContrast}
                aria-pressed={highContrast}
                aria-label={highContrast ? "Disable high contrast mode" : "Enable high contrast mode"}
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-text transition-all duration-300 hover:border-red-400/40 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-vault-bg"
              >
                <Contrast className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setRpcOpen(true)}
                aria-label="Configure custom RPC endpoints"
                className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-text transition-all duration-300 hover:border-red-400/40 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-vault-bg"
              >
                <Server className="h-5 w-5" aria-hidden="true" />
              </button>
              <BalanceAutoRefresh />
              <ThemeToggle />
            </div>
            <div className="hidden sm:block">
              <HeaderWalletStatus variant="desktop" />
            </div>
            <button
              type="button"
              aria-label="Toggle menu"
              aria-expanded={menuOpen}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-text transition-all duration-300 hover:shadow-glow md:hidden"
              onClick={() => setMenuOpen((o) => !o)}
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className="overflow-hidden border-t border-vault-border md:hidden"
            >
              <nav className="flex flex-col gap-1 px-4 py-4" aria-label="Mobile">
                {LINKS.map(({ href, label, icon: Icon }) => {
                  const active = pathname === href;
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMenuOpen(false)}
                      className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-300 ${
                        active ? "bg-red-500/15 text-red-600 dark:text-red-400" : "text-vault-muted"
                      }`}
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                      {label}
                    </Link>
                  );
                })}
                <div className="mt-3 space-y-3 border-t border-vault-border pt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-vault-muted">
                    Accessibility
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={toggleHighContrast}
                      aria-pressed={highContrast}
                      className={`vq-btn-ghost ${highContrast ? "ring-2 ring-yellow-400" : ""}`}
                    >
                      <Contrast className="h-4 w-4" aria-hidden="true" />
                      High contrast
                    </button>
                    <button type="button" onClick={() => setRpcOpen(true)} className="vq-btn-ghost">
                      <Server className="h-4 w-4" aria-hidden="true" />
                      RPC settings
                    </button>
                    <ThemeToggle />
                  </div>
                </div>
                <div className="mt-3">
                  <HeaderWalletStatus variant="mobile" />
                </div>
              </nav>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      <CustomRpcModal open={rpcOpen} onClose={() => setRpcOpen(false)} />
    </>
  );
}
