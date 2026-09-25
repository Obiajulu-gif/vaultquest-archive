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

