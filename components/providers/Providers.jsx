"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { useEffect, useState } from "react";
import { appWithTranslation, useTranslation } from "next-i18next";
import { readStoredRpc, RPC_UPDATED_EVENT } from "@/lib/customRpc";
import { getStoredLocale, setStoredLocale, normalizeLocale } from "@/lib/locale";
import { createWagmiConfig } from "@/lib/wagmi";
import { TransactionToastProvider } from "@/hooks/useTransactionToast";

import { ToastProvider } from "@/components/providers/ToastProvider";

export default function Providers({ children }) {
function ProvidersInner({ children }) {
  const { i18n } = useTranslation("common");
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
      }),
  );

  const [wagmiConfig, setWagmiConfig] = useState(() => createWagmiConfig());
  const [configVersion, setConfigVersion] = useState(0);

  useEffect(() => {
    const stored = readStoredRpc();
    if (stored) {
      setWagmiConfig(createWagmiConfig(stored));
      setConfigVersion((v) => v + 1);
    }

    const onRpcUpdated = (event) => {
      setWagmiConfig(createWagmiConfig(event.detail));
      setConfigVersion((v) => v + 1);
    };
    window.addEventListener(RPC_UPDATED_EVENT, onRpcUpdated);
    return () => window.removeEventListener(RPC_UPDATED_EVENT, onRpcUpdated);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedLocale = getStoredLocale(window.localStorage);
    const nextLocale = normalizeLocale(i18n.resolvedLanguage || i18n.language || storedLocale);

    if (i18n.language !== nextLocale) {
      void i18n.changeLanguage(nextLocale);
    }

    setStoredLocale(window.localStorage, nextLocale);
    document.documentElement.lang = nextLocale;
  }, [i18n]);

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem storageKey="vaultquest-theme">
      <WagmiProvider key={configVersion} config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider>
            <TransactionToastProvider>
              <ToastProvider>{children}</ToastProvider>
            </TransactionToastProvider>
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}

export default appWithTranslation(ProvidersInner);
