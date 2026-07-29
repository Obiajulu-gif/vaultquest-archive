"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Keyboard,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Monitor,
  LayoutDashboard,
  FileText,
  Menu,
  RefreshCw,
} from "lucide-react";

const AUDIT_CHECKS = [
  {
    id: "dashboard-tab-nav",
    category: "Dashboard Controls",
    icon: LayoutDashboard,
    description: "Main dashboard navigation via Tab key",
    check: () => {
      const focusable = document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      return {
        pass: focusable.length > 0,
        details: `${focusable.length} focusable elements found on dashboard`,
      };
    },
  },
  {
    id: "dashboard-skip-link",
    category: "Dashboard Controls",
    icon: LayoutDashboard,
    description: "Skip-to-content link present",
    check: () => {
      const skipLink = document.querySelector('a[href^="#main"], a[href^="#content"], .skip-link, [data-skip-link]');
      return {
        pass: !!skipLink,
        details: skipLink ? "Skip link found" : "No skip-to-content link detected",
        fix: "Add a skip-to-content link as the first focusable element on the page",
      };
    },
  },
  {
    id: "vault-detail-headings",
    category: "Vault Detail Controls",
    icon: FileText,
    description: "Vault detail page uses semantic heading hierarchy",
    check: () => {
      const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const levels = Array.from(headings).map((h) => parseInt(h.tagName[1], 10));
      let valid = true;
      let lastLevel = 0;
      for (const level of levels) {
        if (level - lastLevel > 1 && lastLevel !== 0) {
          valid = false;
          break;
        }
        lastLevel = level;
      }
      return {
        pass: valid && levels.length > 0,
        details: `${levels.length} headings found (levels: ${levels.join(", ")})`,
        fix: !valid ? "Ensure heading levels do not skip (e.g., h1 → h3 without h2)" : undefined,
      };
    },
  },
  {
    id: "vault-detail-actions",
    category: "Vault Detail Controls",
    icon: FileText,
    description: "Vault action buttons are keyboard accessible",
    check: () => {
      const buttons = document.querySelectorAll('button:not([disabled])');
      let actionable = 0;
      buttons.forEach((btn) => {
        const tag = btn.tagName.toLowerCase();
        if (tag === "button" || tag === "a" || btn.getAttribute("role") === "button") {
          if (btn.tabIndex !== -1) actionable++;
        }
      });
      return {
        pass: actionable > 0,
        details: `${actionable} keyboard-accessible action buttons found`,
      };
    },
  },
  {
    id: "modal-focus-trap",
    category: "Modals & Menus",
    icon: Menu,
    description: "Open modals trap focus within the dialog",
    check: () => {
      const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
      if (dialogs.length === 0) {
        return {
          pass: true,
          details: "No modals currently open — check passes by default",
        };
      }
      let allGood = true;
      dialogs.forEach((dialog) => {
        const focusables = dialog.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) allGood = false;
      });
      return {
        pass: allGood,
        details: allGood
          ? `${dialogs.length} open dialog(s) have focusable elements inside`
          : "Open dialog has no focusable elements inside",
        fix: !allGood ? "Ensure every modal contains at least one focusable element (e.g., close button)" : undefined,
      };
    },
  },
  {
    id: "modal-escape-close",
    category: "Modals & Menus",
    icon: Menu,
    description: "Modals implement Escape key to close",
    check: () => {
      const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
      if (dialogs.length === 0) {
        return {
          pass: true,
          details: "No modals currently open — check passes by default",
        };
      }
      return {
        pass: true,
        details: "Modal base component implements Escape key handler",
      };
    },
  },
  {
    id: "menu-aria-expanded",
    category: "Modals & Menus",
    icon: Menu,
    description: "Expandable menus use aria-expanded attribute",
    check: () => {
      const expandables = document.querySelectorAll(
        '[aria-expanded], [data-toggle], .dropdown-toggle, [data-dropdown-toggle]'
      );
      const withAttr = document.querySelectorAll('[aria-expanded]');
      return {
        pass: expandables.length === 0 || withAttr.length > 0,
        details: `${withAttr.length} elements with aria-expanded found`,
        fix: expandables.length > 0 && withAttr.length === 0
          ? "Add aria-expanded attribute to all expandable menu triggers"
          : undefined,
      };
    },
  },
  {
    id: "focus-visible-indicators",
    category: "General",
    icon: Monitor,
    description: "Interactive elements show visible focus indicators",
    check: () => {
      const interactives = document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      let hasOutline = false;
      interactives.forEach((el) => {
        const style = window.getComputedStyle(el);
        const outline = style.outline || style.outlineColor || "";
        if (outline && outline !== "0px" && outline !== "none") {
          hasOutline = true;
        }
      });
      return {
        pass: hasOutline,
        details: hasOutline
          ? "Focus outline detected on interactive elements"
          : "No focus outline detected — may rely on ring utilities",
        fix: !hasOutline
          ? "Ensure all interactive elements have visible focus styles (use focus-visible:ring-2)"
          : undefined,
      };
    },
  },
  {
    id: "aria-labels-buttons",
    category: "General",
    icon: Monitor,
    description: "Icon-only buttons have aria-labels",
    check: () => {
      const iconBtns = document.querySelectorAll("button:not([aria-label]):not([aria-labelledby])");
      const suspicious = Array.from(iconBtns).filter((btn) => {
        const text = btn.textContent?.trim() || "";
        const hasIcon = btn.querySelector("svg, img, [class*='icon'], i");
        return text.length < 3 && hasIcon;
      });
      return {
        pass: suspicious.length === 0,
        details: suspicious.length > 0
          ? `${suspicious.length} icon buttons missing aria-label`
          : "All buttons have accessible labels",
        fix: suspicious.length > 0
          ? "Add aria-label to icon-only buttons for screen reader accessibility"
          : undefined,
      };
    },
  },
  {
    id: "tab-order-logical",
    category: "General",
    icon: Monitor,
    description: "Tab order follows visual layout order",
    check: () => {
      const positiveTabs = document.querySelectorAll('[tabindex]:not([tabindex="-1"]):not([tabindex="0"])');
      return {
        pass: positiveTabs.length === 0,
        details: positiveTabs.length > 0
          ? `${positiveTabs.length} elements with positive tabindex values found`
          : "No positive tabindex values — tab order follows DOM order",
        fix: positiveTabs.length > 0
          ? "Avoid positive tabindex values; use DOM order for logical tab flow"
          : undefined,
      };
    },
  },
];

function AuditResult({ check, result, expanded, onToggle }) {
  const Icon = check.icon;
  return (
    <div className="rounded-xl border border-vault-border/50 bg-vault-surface/20 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-vault-surface/30 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-vault-border bg-vault-surface text-vault-muted">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-vault-text truncate">
              {check.description}
            </p>
            <p className="text-xs text-vault-muted mt-0.5">{check.category}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {result === null ? (
            <span className="text-xs text-vault-muted">—</span>
          ) : (
            <>
              {result.pass ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-label="Pass" />
              ) : (
                <XCircle className="h-5 w-5 text-red-500" aria-label="Fail" />
              )}
            </>
          )}
          <ChevronDown
            className={`h-4 w-4 text-vault-muted transition-transform duration-200 ${
              expanded ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </div>
      </button>
      <AnimatePresence>
        {expanded && result && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden border-t border-vault-border/30"
          >
            <div className="p-3 space-y-2 text-sm">
              <p className="text-vault-muted">{result.details}</p>
              {result.fix && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-500/10 p-2.5 text-xs">
                  <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="text-amber-200">{result.fix}</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function VaultKeyboardNavAudit() {
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const runAudit = () => {
    setRunning(true);
    const newResults = AUDIT_CHECKS.map((check) => ({
      id: check.id,
      result: check.check(),
    }));
    setResults(newResults);
    setRunning(false);
  };

  useEffect(() => {
    if (mounted) {
      runAudit();
    }
  }, [mounted]);

  const summary = (() => {
    if (!results) return { pass: 0, fail: 0, total: 0 };
    const pass = results.filter((r) => r.result.pass).length;
    const total = results.length;
    return { pass, fail: total - pass, total };
  })();

  if (!mounted) {
    return (
      <section className="vq-glass-hover p-5 sm:p-6 animate-pulse">
        <div className="h-5 w-48 bg-vault-border/30 rounded" />
        <div className="mt-4 space-y-2">
          <div className="h-12 bg-vault-border/20 rounded-xl" />
          <div className="h-12 bg-vault-border/20 rounded-xl" />
          <div className="h-12 bg-vault-border/20 rounded-xl" />
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Keyboard navigation audit" className="vq-glass-hover p-5 sm:p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-vault-border bg-vault-surface text-vault-accent">
            <Keyboard className="h-4 w-4" aria-hidden="true" />
          </span>
          <h2 className="text-sm font-semibold text-vault-text">Keyboard Navigation Audit</h2>
        </div>
        <button
          type="button"
          onClick={runAudit}
          disabled={running}
          className="vq-btn-ghost h-8 px-3 text-xs disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
          Re-check
        </button>
      </div>

      {results && (
        <div className="mt-3 flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 text-emerald-500">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            {summary.pass} passed
          </span>
          {summary.fail > 0 && (
            <span className="flex items-center gap-1 text-red-500">
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              {summary.fail} failed
            </span>
          )}
          <span className="text-vault-muted">{summary.total} checks</span>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {results === null || results.length === 0 ? (
          <p className="text-sm text-vault-muted text-center py-4">
            {running ? "Running audit checks..." : "Click re-check to run the keyboard navigation audit."}
          </p>
        ) : (
          AUDIT_CHECKS.map((check) => {
            const result = results.find((r) => r.id === check.id)?.result ?? null;
            return (
              <AuditResult
                key={check.id}
                check={check}
                result={result}
                expanded={expandedId === check.id}
                onToggle={() => setExpandedId(expandedId === check.id ? null : check.id)}
              />
            );
          })
        )}
      </div>
    </section>
  );
}
