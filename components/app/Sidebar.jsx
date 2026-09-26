"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDisconnect } from "wagmi";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  User,
  Settings,
  LogOut,
  Vault,
  X,
  Menu,
} from "lucide-react";

const NAV_ITEMS = [
  { href: "/app", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/app/account", label: "Profile", icon: User },
  { href: "/app/admin/settings", label: "Settings", icon: Settings },
];

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href;
  return pathname.startsWith(href);
}

export default function Sidebar() {
  const pathname = usePathname();
  const { disconnect } = useDisconnect();
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!mobileOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [mobileOpen]);

  // Close on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Focus trap in mobile drawer
  useEffect(() => {
    if (!mobileOpen || !drawerRef.current) return;
    const drawer = drawerRef.current;
    const focusable = drawer.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length > 0) focusable[0].focus();
  }, [mobileOpen]);

  const handleLogout = useCallback(() => {
    disconnect();
  }, [disconnect]);

  const renderNavLink = (item: (typeof NAV_ITEMS)[0]) => {
    const active = isActive(pathname, item.href, item.exact);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-all duration-300 ${
          active
            ? "bg-red-500/15 text-red-600 ring-1 ring-red-400/30 dark:text-red-400"
            : "text-vault-muted hover:bg-vault-surface hover:text-vault-text"
        }`}
        aria-current={active ? "page" : undefined}
      >
        <item.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
        {item.label}
      </Link>
    );
  };

  const sidebarContent = (
    <nav
      className="flex h-full flex-col gap-1 p-4"
      aria-label="Sidebar navigation"
    >
      {/* Logo */}
      <Link
        href="/app"
        className="mb-4 flex items-center gap-2 rounded-xl px-4 py-3 text-lg font-bold tracking-tight text-vault-text transition-colors duration-300 hover:text-red-500"
      >
        <Vault className="h-6 w-6" aria-hidden="true" />
        VaultQuest
      </Link>

      {/* Nav links */}
      {NAV_ITEMS.map(renderNavLink)}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Logout */}
      <button
        type="button"
        onClick={handleLogout}
        className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-vault-muted transition-all duration-300 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
        aria-label="Disconnect wallet and logout"
      >
        <LogOut className="h-5 w-5 shrink-0" aria-hidden="true" />
        Logout
      </button>
    </nav>
  );

  return (
    <>
      {/* Mobile toggle button */}
      <button
        ref={toggleRef}
        type="button"
        aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={mobileOpen}
        className="fixed bottom-4 left-4 z-50 flex h-12 w-12 items-center justify-center rounded-xl border border-vault-border bg-vault-surface text-vault-text shadow-glass backdrop-blur-xl transition-all duration-300 hover:shadow-glow md:hidden"
        onClick={() => setMobileOpen((o) => !o)}
      >
        {mobileOpen ? (
          <X className="h-5 w-5" aria-hidden="true" />
        ) : (
          <Menu className="h-5 w-5" aria-hidden="true" />
        )}
      </button>

      {/* Mobile drawer overlay */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.aside
            ref={drawerRef}
            initial={{ x: -300 }}
            animate={{ x: 0 }}
            exit={{ x: -300 }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-y-0 left-0 z-50 w-72 border-r border-vault-border bg-vault-bg md:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
          >
            {sidebarContent}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-vault-border bg-vault-bg md:block">
        <div className="sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto">
          {sidebarContent}
        </div>
      </aside>
    </>
  );
}
