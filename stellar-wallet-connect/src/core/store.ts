import { atom } from "nanostores";
import type { NetworkType } from "../lib/wallets.js";
import type { MultisigStatus } from "./multisig.js";

export const connectedPublicKey = atom<string>("");
export const connectedNetwork = atom<NetworkType | null>(null);
export const isNetworkMismatch = atom<boolean>(false);

/** Multisig/thresholded account detection result for the connected wallet (#736). Null until checked. */
export const multisigStatus = atom<MultisigStatus | null>(null);

