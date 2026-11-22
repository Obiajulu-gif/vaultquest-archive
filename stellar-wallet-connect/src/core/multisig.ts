/**
 * Multisig / thresholded account detection (#736).
 *
 * Nothing in this module previously distinguished a plain single-signature
 * Stellar account from a multisig/shared-custody one — the wallet-connect
 * flow assumed a single-signature happy path throughout. This module adds
 * the "at minimum" scope from the issue: detect the case up front and
 * expose a clear, typed signal so callers can present an explicit
 * "not yet supported" state instead of a confusing low-level signing or
 * threshold error surfacing later. The stretch goal (an async
 * pending-signatures submission flow) is intentionally out of scope here.
 */
import type { HorizonPool } from "./horizonPool.js";

export interface AccountThresholds {
  low: number;
  med: number;
  high: number;
}

export interface MultisigStatus {
  /**
   * True when the account requires more than the connected key's own
   * signature to reach at least the medium threshold — i.e. a payment or
   * contract invocation from this app cannot be authorized by this wallet
   * connection alone.
   */
  isMultisig: boolean;
  signerCount: number;
  /** This connection's own signer weight on the account, or null if it isn't listed as a signer (unusual, but possible mid-rotation). */
  ownSignerWeight: number | null;
  thresholds: AccountThresholds;
}

export class MultisigDetectionError extends Error {
  readonly kind = "multisig_detection_failed";
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "MultisigDetectionError";
  }
}

interface HorizonSigner {
  key: string;
  weight: number;
  type: string;
}

interface HorizonAccountRecord {
  signers: HorizonSigner[];
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
}

/**
 * Queries the account's signer set and thresholds and determines whether
 * this wallet connection alone is sufficient to authorize a typical
 * (medium-threshold) transaction — payments and Soroban contract
 * invocations both default to the medium threshold on Stellar.
 *
 * A brand-new, not-yet-funded account (404 from Horizon) is reported as
 * not multisig — there's nothing to detect yet, and the existing
 * account-funding flow already handles that case.
 */
const UNFUNDED_ACCOUNT_STATUS: MultisigStatus = {
  isMultisig: false,
  signerCount: 0,
  ownSignerWeight: null,
  thresholds: { low: 0, med: 0, high: 0 },
};

export async function checkMultisigStatus(
  pool: HorizonPool,
  publicKey: string,
): Promise<MultisigStatus> {
  let account: HorizonAccountRecord;
  try {
    // Horizon returns 404 as a normal (non-5xx, non-429) response body —
    // HorizonPool.request() treats that as a successful fetch, so it must
    // be checked on the Response itself rather than caught as a rejection.
    const res = await pool.request(`/accounts/${publicKey}`, {
      headers: { Accept: "application/json" },
      criticality: "critical",
    });
    if (res.status === 404) {
      return UNFUNDED_ACCOUNT_STATUS;
    }
    account = (await res.json()) as HorizonAccountRecord;
  } catch (err) {
    throw new MultisigDetectionError(
      "Could not verify whether this account requires multiple signatures.",
      err,
    );
  }

  const thresholds: AccountThresholds = {
    low: account.thresholds.low_threshold,
    med: account.thresholds.med_threshold,
    high: account.thresholds.high_threshold,
  };

  const ownSigner = account.signers.find((s) => s.key === publicKey);
  const ownSignerWeight = ownSigner ? ownSigner.weight : null;

  // Multisig if there's more than one signer, or the single known signer's
  // weight can't clear the medium threshold on its own (a "1-of-1 but
  // weighted below threshold" account is functionally multisig too).
  const isMultisig =
    account.signers.length > 1 || (ownSignerWeight !== null && ownSignerWeight < thresholds.med);

  return {
    isMultisig,
    signerCount: account.signers.length,
    ownSignerWeight,
    thresholds,
  };
}

export const MULTISIG_UNSUPPORTED_MESSAGE =
  "This wallet is a multisig/shared-custody account. VaultQuest doesn't yet support collecting additional co-signer approvals, so this action can't be completed from here.";
