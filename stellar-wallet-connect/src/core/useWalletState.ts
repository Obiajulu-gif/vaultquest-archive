import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import {
  connectedPublicKey,
  connectedNetwork,
  isNetworkMismatch,
  multisigStatus,
  sessionStatus,
  isWalletInitialized,
  getWalletStateSnapshot,
  type WalletStateSnapshot,
} from "./store.js";
import {
  connectWallet,
  disconnectWallet,
  reconnectSession,
  initializeConnection,
} from "./walletService.js";
import type { WalletType } from "../lib/wallets.js";

/**
 * React hook for consuming synchronized cross-island wallet state (#734).
 *
 * Guarantees:
 * 1. Consistent SSR initial state — returns deterministic server snapshot during SSR
 *    and pre-hydration, eliminating flash-of-incorrect-state or React hydration mismatch.
 * 2. Instant cross-island synchronization — any mutation (connect, disconnect,
 *    network switch) made from ANY island or the Astro shell immediately
 *    propagates to all other React island roots via the shared nanostore.
 *
 * Space Complexity: O(1)
 * Time Complexity: O(1)
 */
export function useWalletState(): WalletStateSnapshot & {
  connect: (provider: WalletType) => Promise<void>;
  disconnect: (provider?: WalletType) => Promise<void>;
  reconnect: () => Promise<void>;
} {
  const [isMounted, setIsMounted] = useState(false);

  // Read atoms reactively via nanostores React binding
  const pubKey = useStore(connectedPublicKey);
  const net = useStore(connectedNetwork);
  const mismatch = useStore(isNetworkMismatch);
  const multisig = useStore(multisigStatus);
  const session = useStore(sessionStatus);
  const isInit = useStore(isWalletInitialized);

  useEffect(() => {
    setIsMounted(true);
    // Ensure the wallet connection is initialized from storage on client mount
    if (!isWalletInitialized.get()) {
      initializeConnection();
    }
  }, []);

  const isConnected = Boolean(pubKey && pubKey.length > 0);

  const connect = async (provider: WalletType) => {
    await connectWallet(provider);
  };

  const disconnect = async (provider?: WalletType) => {
    await disconnectWallet(provider);
  };

  const reconnect = async () => {
    await reconnectSession();
  };

  return {
    publicKey: isMounted ? pubKey : "",
    network: isMounted ? net : null,
    isNetworkMismatch: isMounted ? mismatch : false,
    multisigStatus: isMounted ? multisig : null,
    sessionStatus: isMounted ? session : "unknown",
    isInitialized: isMounted ? isInit : false,
    isConnected: isMounted ? isConnected : false,
    connect,
    disconnect,
    reconnect,
  };
}
