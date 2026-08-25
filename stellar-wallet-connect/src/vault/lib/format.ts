/**
 * Display helpers for VaultQuest pool UI (#73, #75).
 *
 * Privacy-aware address truncation, amount/date formatting, and Stellar
 * explorer links. Pure functions so they are trivially unit-testable.
 */

import {
  formatAssetAmount,
  formatDateOnly,
} from "../../../../../lib/formatting";
import {
  explorerTransactionUrl,
  type StellarExplorerNetwork,
} from "../../../../../lib/stellar-explorer";

export type StellarNetwork = StellarExplorerNetwork;

/**
 * Truncate a Stellar address for privacy-aware display, e.g.
 * `GBBD47IF…FLA5`. Short strings are returned unchanged.
 */
export function truncateAddress(address: string, lead = 6, tail = 4): string {
  if (!address) return "";
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** Format an amount with its asset code, e.g. `1,250.00 USDC`. */
export function formatAmount(
  value: string | number,
  asset?: string,
  locale?: string,
): string {
  return formatAssetAmount(value, asset, { locale });
}

/** Format an ISO timestamp as a short human date, e.g. `May 28, 2026`. */
export function formatDate(iso: string | null | undefined, locale?: string): string {
  return formatDateOnly(iso, { locale });
}

/** Build a Stellar Expert explorer URL for a transaction hash. */
export function explorerTxUrl(txHash: string, network: StellarNetwork = "testnet"): string | null {
  return explorerTransactionUrl(txHash, network);
}
