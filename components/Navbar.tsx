"use client";

// components/Navbar.tsx
// Refactored navbar that:
//   • Maps over navConfig.ts instead of hardcoding links  (#248)
//   • Includes a dark-mode toggle persisted in localStorage (#249)
//   • Supports OS-level prefers-color-scheme on first load  (#249)
//   • Uses Tailwind dark: variants throughout              (#249)

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Vault,
  Trophy,
  History,
  Settings,
  Sun,
  Moon,
  Menu,
  X,
} from "lucide-react";
import navItems, { type NavItem } from "./navConfig";

// ── Icon resolver ──────────────────────────────────────────────────────
const ICONS: Record<string, React.ElementType> = {
  LayoutDashboard,
  Vault,
  Trophy,
  History,
  Settings,
};

function NavIcon({ name }: { name?: string }) {
  if (!name) return null;
  const Icon = ICONS[name];
  return Icon ? <Icon className="w-4 h-4 shrink-0" /> : null;
}

// ── Dark-mode hook ─────────────────────────────────────────────────────
function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState<boolean>(() => {
    // SSR guard
    if (typeof window === "undefined") return false;
    // 1. Respect persisted user preference
    const stored = localStorage.getItem("theme");
    if (stored === "dark") return true;
    if (stored === "light") return false;
    // 2. Fall back to OS preference
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [dark]);

  return [dark, () => setDark((d) => !d)];
}

// ── Active-link helper ─────────────────────────────────────────────────
function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}

// ── Navbar component ───────────────────────────────────────────────────
export default function Navbar() {
  const pathname = usePathname();
  const [dark, toggleDark] = useDarkMode();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-700 dark:bg-slate-900/80">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2 text-xl font-bold text-violet-600 dark:text-violet-400"
        >
          <Vault className="h-6 w-6" />
          VaultQuest
        </Link>

        {/* Desktop links */}
        <ul className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => {
            const active = isActive(pathname, item);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={[
                    "flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
                  ].join(" ")}
                  aria-current={active ? "page" : undefined}
                >
                  <NavIcon name={item.icon} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Right-side controls */}
        <div className="flex items-center gap-2">
          {/* Dark mode toggle (#249) */}
          <button
            onClick={toggleDark}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="rounded-md p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          >
            {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>

          {/* Mobile hamburger */}
          <button
            className="rounded-md p-2 text-slate-500 md:hidden dark:text-slate-400"
            onClick={() => setMobileOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            {mobileOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="border-t border-slate-200 bg-white px-4 pb-4 pt-2 dark:border-slate-700 dark:bg-slate-900 md:hidden">
          <ul className="flex flex-col gap-1">
            {navItems.map((item) => {
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    className={[
                      "flex items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                        : "text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                    ].join(" ")}
                    aria-current={active ? "page" : undefined}
                  >
                    <NavIcon name={item.icon} />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </nav>
  );
}
