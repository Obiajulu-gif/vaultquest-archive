import { atom } from "nanostores";
import type { NetworkType } from "../lib/wallets.js";
import type { MultisigStatus } from "./multisig.js";

export const connectedPublicKey = atom<string>("");
export const connectedNetwork = atom<NetworkType | null>(null);
export const isNetworkMismatch = atom<boolean>(false);

/** Multisig/thresholded account detection result for the connected wallet (#736). Null until checked. */
export const multisigStatus = atom<MultisigStatus | null>(null);

/**
 * Wallet session-liveness status (#733): "unknown" before the first probe,
 * "checking" mid-probe, "alive" on a confirmed-live heartbeat/preflight,
 * "lost" once a probe fails or the wallet reports a different account than
 * the one this session connected with. Drives reconnect-prompt UI so a
 * dead session surfaces before the user commits to a signing flow.
 */
export type SessionLivenessStatus = "unknown" | "checking" | "alive" | "lost";
export const sessionStatus = atom<SessionLivenessStatus>("unknown");

/**
 * Tracks whether the client-side wallet store has finished its initial read
 * from persistent storage (`localStorage`) and environment defaults (#734).
 * True on browser initialization completion; false during initial SSR or before init.
 */
export const isWalletInitialized = atom<boolean>(false);

/** Complete immutable snapshot of cross-island wallet state (#734). */
export interface WalletStateSnapshot {
  publicKey: string;
  network: NetworkType | null;
  isNetworkMismatch: boolean;
  multisigStatus: MultisigStatus | null;
  sessionStatus: SessionLivenessStatus;
  isInitialized: boolean;
  isConnected: boolean;
}

/**
 * Reads a synchronous snapshot of the current wallet store state.
 * Space: O(1), Time: O(1).
 */
export function getWalletStateSnapshot(): WalletStateSnapshot {
  const pk = connectedPublicKey.get();
  return {
    publicKey: pk,
    network: connectedNetwork.get(),
    isNetworkMismatch: isNetworkMismatch.get(),
    multisigStatus: multisigStatus.get(),
    sessionStatus: sessionStatus.get(),
    isInitialized: isWalletInitialized.get(),
    isConnected: Boolean(pk && pk.length > 0),
  };
}

/**
 * Framework-agnostic subscription helper for Astro page scripts, vanilla JS, or non-React shells (#734).
 * Calls the listener immediately with current state and on every subsequent state mutation.
 * Returns an unsubscribe cleanup function.
 */
export function subscribeWalletState(listener: (state: WalletStateSnapshot) => void): () => void {
  // Call immediately with initial snapshot
  listener(getWalletStateSnapshot());

  const unsubs = [
    connectedPublicKey.listen(() => listener(getWalletStateSnapshot())),
    connectedNetwork.listen(() => listener(getWalletStateSnapshot())),
    isNetworkMismatch.listen(() => listener(getWalletStateSnapshot())),
    multisigStatus.listen(() => listener(getWalletStateSnapshot())),
    sessionStatus.listen(() => listener(getWalletStateSnapshot())),
    isWalletInitialized.listen(() => listener(getWalletStateSnapshot())),
  ];

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}


