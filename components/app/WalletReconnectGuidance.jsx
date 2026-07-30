"use client";

import { useState } from "react";
import { AlertTriangle, Wifi, RefreshCw, X } from "lucide-react";
import { useTranslation } from "next-i18next";

export default function WalletReconnectGuidance({ isDisconnected, isNetworkMismatch, onRetry }) {
  const { t } = useTranslation("common");
  const [isDismissed, setIsDismissed] = useState(false);

  if (isDismissed || (!isDisconnected && !isNetworkMismatch)) {
    return null;
  }

  return (
    <div className="mb-6">
      <div className={`rounded-2xl border p-4 sm:p-6 flex gap-4 ${
        isNetworkMismatch
          ? "border-amber-500/30 bg-amber-500/10"
          : "border-red-500/30 bg-red-500/10"
      }`}>
        <div className="flex-shrink-0">
          {isNetworkMismatch ? (
            <Wifi className="h-6 w-6 text-amber-500 sm:h-7 sm:w-7" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-6 w-6 text-red-500 sm:h-7 sm:w-7" aria-hidden="true" />
          )}
        </div>

        <div className="flex-1">
          <h3 className={`text-base font-semibold ${
            isNetworkMismatch ? "text-amber-100" : "text-red-100"
          }`}>
            {isNetworkMismatch ? t("wallet.reconnect.networkMismatchTitle") : t("wallet.reconnect.interruptedTitle")}
          </h3>

          <p className="mt-1 text-sm text-gray-300">
            {isNetworkMismatch ? t("wallet.reconnect.networkMismatchBody") : t("wallet.reconnect.interruptedBody")}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {isDisconnected && onRetry && (
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-red-950/50"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t("wallet.reconnect.reconnect")}
              </button>
            )}
            <button
              onClick={() => setIsDismissed(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-400/30 px-4 py-2 text-sm font-semibold text-gray-300 transition-colors hover:border-gray-400/50 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-red-950/50"
            >
              {t("common.close")}
            </button>
          </div>
        </div>

        <button
          onClick={() => setIsDismissed(true)}
          className="flex-shrink-0 rounded-lg p-1 text-gray-400 hover:bg-white/10 hover:text-gray-300"
          aria-label="Close message"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
