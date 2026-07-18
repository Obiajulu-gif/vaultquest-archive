"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { WagmiProvider } from "wagmi";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { useEffect, useState } from "react";
import { readStoredRpc, RPC_UPDATED_EVENT } from "@/lib/customRpc";
import { createWagmiConfig } from "@/lib/wagmi";

function ProvidersInner({ children }) {
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

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="vaultquest-theme">
      <WagmiProvider key={configVersion} config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider>{children}</RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}

export default ProvidersInner;
