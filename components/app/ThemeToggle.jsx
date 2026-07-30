"use client";

import { useTheme } from "next-themes";
import { motion, AnimatePresence } from "framer-motion";
import { Moon, Sun, Monitor } from "lucide-react";
import { useEffect, useState } from "react";

const THEMES = ["dark", "light", "system"];
const ICONS = { dark: Moon, light: Sun, system: Monitor };
const LABELS = {
  dark: "Dark theme",
  light: "Light theme",
  system: "System theme",
};

export default function ThemeToggle({ className = "" }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <button
        type="button"
        aria-label="Toggle theme"
        className={`vq-btn-ghost h-10 w-10 p-0 ${className}`}
        disabled
      />
    );
  }

  const currentIdx = THEMES.indexOf(theme ?? "dark");
  const nextTheme = THEMES[(currentIdx + 1) % THEMES.length];
  const isDark = (resolvedTheme ?? theme) === "dark";
  const Icon = isDark ? Moon : theme === "system" ? Monitor : Sun;

  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme)}
      aria-label={LABELS[theme ?? "dark"]}
      title={LABELS[theme ?? "dark"]}
      className={`relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl border border-vault-border bg-vault-surface shadow-glass transition-all duration-300 hover:border-red-400/40 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-vault-bg ${className}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={theme ?? "dark"}
          initial={{ rotate: -90, scale: 0, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          exit={{ rotate: 90, scale: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
          className={`absolute inset-0 flex items-center justify-center ${
            isDark ? "text-amber-300" : theme === "system" ? "text-vault-muted" : "text-amber-500"
          }`}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
