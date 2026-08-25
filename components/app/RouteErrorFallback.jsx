"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Copy, Home, RefreshCw, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useTranslation } from "next-i18next";

function makeDiagnosticId(error) {
  return error?.digest || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "vq-error");
}

export default function RouteErrorFallback({ error, reset, title = "Something went wrong" }) {
  const { t } = useTranslation("common");
  const diagnosticId = useMemo(() => makeDiagnosticId(error), [error]);
  const [copyState, setCopyState] = useState("Copy");

  useEffect(() => {
    setCopyState("Copy");
  }, [diagnosticId]);

  const copyDiagnosticId = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticId);
      setCopyState("Copied");
    } catch {
      setCopyState("Copy failed");
    }
  };

  const reloadSection = () => window.location.reload();

  return (
    <div className="flex min-h-[420px] w-full flex-col items-center justify-center rounded-2xl border border-red-500/20 bg-red-500/5 p-8 text-center backdrop-blur-md">
      <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full border border-red-500/30 bg-red-500/20 text-red-400">
        <AlertTriangle size={32} />
      </div>
      <h2 className="mb-2 text-2xl font-bold text-vault-text">{title}</h2>
      <p className="mb-6 max-w-md text-vault-muted">
        {t("errors.routeFallbackDescription")}
      </p>

      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={() => reset?.()}
          className="flex items-center gap-2 rounded-lg bg-red-500/20 px-4 py-2.5 font-semibold text-red-400 transition-colors hover:bg-red-500/30"
        >
          <RotateCcw size={18} />
          {t("buttons.retry")}
        </button>
        <button
          type="button"
          onClick={reloadSection}
          className="flex items-center gap-2 rounded-lg border border-vault-border bg-vault-surface px-4 py-2.5 font-semibold text-vault-text transition-colors hover:bg-white/5"
        >
          <RefreshCw size={18} />
          {t("buttons.reload")}
        </button>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-lg border border-vault-border bg-vault-surface px-4 py-2.5 font-semibold text-vault-text transition-colors hover:bg-white/5"
        >
          <Home size={18} />
          {t("buttons.returnHome")}
        </Link>
      </div>

      <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-vault-border/60 bg-vault-surface/50 px-4 py-3 text-left">
        <div className="text-xs uppercase tracking-[0.24em] text-vault-muted">{t("errors.diagnosticId")}</div>
        <div className="font-mono text-sm text-vault-text">{diagnosticId}</div>
        <button
          type="button"
          onClick={copyDiagnosticId}
          className="inline-flex items-center gap-2 rounded-lg border border-vault-border px-3 py-1.5 text-xs font-semibold text-vault-text transition-colors hover:bg-white/5"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          {copyState === "Copied" ? t("buttons.copied") : copyState === "Copy failed" ? t("buttons.copyFailed") : t("buttons.copy")}
        </button>
      </div>
    </div>
  );
}
