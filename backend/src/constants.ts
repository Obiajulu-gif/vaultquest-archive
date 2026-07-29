/**
 * Schema version tracking for deployment validation
 */
export const SCHEMA_VERSIONS = {
  // Current database schema version (from latest migration)
  DATABASE: "20260725000002",

  // Current indexer checkpoint schema version
  INDEXER: "1.2.0",

  // Supported version ranges for this release
  SUPPORTED_DATABASE_VERSIONS: [
    "20260725000002",
    "20260725000001",
    "20260725000000",
  ],

  SUPPORTED_INDEXER_VERSIONS: ["1.2.0", "1.1.0"],
};

/**
 * Version compatibility check
 */
export function isVersionSupported(
  current: string,
  supported: string[]
): boolean {
  return supported.includes(current);
}

/**
 * Get version mismatch details
 */
export function getVersionMismatch(
  currentDb: string,
  currentIndexer: string
): {
  compatible: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (!isVersionSupported(currentDb, SCHEMA_VERSIONS.SUPPORTED_DATABASE_VERSIONS)) {
    issues.push(
      `Database schema version ${currentDb} is not supported. Expected one of: ${SCHEMA_VERSIONS.SUPPORTED_DATABASE_VERSIONS.join(", ")}`
    );
  }

  if (!isVersionSupported(currentIndexer, SCHEMA_VERSIONS.SUPPORTED_INDEXER_VERSIONS)) {
    issues.push(
      `Indexer schema version ${currentIndexer} is not supported. Expected one of: ${SCHEMA_VERSIONS.SUPPORTED_INDEXER_VERSIONS.join(", ")}`
    );
  }

  return {
    compatible: issues.length === 0,
    issues,
  };
}

export const ACTION_TYPES = ["deposit", "withdraw", "create_vault", "claim", "select_winner"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ["pending", "submitted", "confirmed", "failed", "reverted", "orphaned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ActionStatus[] = ["confirmed", "failed", "reverted", "orphaned"];

const TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  pending: ["submitted", "failed"],
  submitted: ["confirmed", "reverted", "orphaned"],
  confirmed: [],
  failed: [],
  reverted: [],
  orphaned: []
};

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const ERROR_CODES = {
  WALLET_REJECTED: "WALLET_REJECTED",
  WALLET_TIMEOUT: "WALLET_TIMEOUT",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  NETWORK_ERROR: "NETWORK_ERROR",
  REVERTED_ON_CHAIN: "REVERTED_ON_CHAIN",
  ORPHAN_TTL_EXPIRED: "ORPHAN_TTL_EXPIRED",
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
  TX_HASH_ALREADY_ATTACHED: "TX_HASH_ALREADY_ATTACHED",
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  // Escrow settlement pipeline (#settlement)
  SETTLEMENT_SUBMIT_FAILED: "SETTLEMENT_SUBMIT_FAILED",
  SETTLEMENT_RETRIES_EXHAUSTED: "SETTLEMENT_RETRIES_EXHAUSTED",
  SETTLEMENT_ALREADY_RESOLVED: "SETTLEMENT_ALREADY_RESOLVED",
  SETTLEMENT_IN_PROGRESS: "SETTLEMENT_IN_PROGRESS",
  // #509 — submission succeeded on-chain but independent verification
  // against the finalized event could not confirm the payout facts.
  SETTLEMENT_PAYOUT_UNVERIFIED: "SETTLEMENT_PAYOUT_UNVERIFIED"
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Lifecycle of a vault payout. A vault starts `Unresolved`; the settlement
 * pipeline moves it to `Resolving` while a transaction is in flight and to a
 * terminal state on success. On any submission failure the vault is rolled
 * back to `Unresolved` so it can be retried safely.
 *
 * `PendingVerification` (#509) is distinct from `Unresolved`: it means the
 * transaction *did* submit successfully on-chain (Horizon returned
 * `tx_success`), but an independent PayoutVerifier could not yet confirm the
 * finalized transfer event matches the intended recipient/amount — either
 * because the event isn't indexed yet, or because it genuinely disagrees.
 * Unlike `Unresolved`, this state must never be auto-retried by
 * `settleVault` (retrying a transaction that already succeeded on-chain
 * risks a double payout); it requires either the verifier catching up on a
 * later poll, or manual investigation.
 */
export const VAULT_STATES = [
  "Unresolved",
  "Resolving",
  "Resolved",
  "Refunded",
  "PendingVerification"
] as const;
export type VaultState = (typeof VAULT_STATES)[number];

/** How a resolved vault disburses its balance on-chain. */
export const SETTLEMENT_TYPES = ["release", "distribute", "refund"] as const;
export type SettlementType = (typeof SETTLEMENT_TYPES)[number];

/**
 * Horizon / Soroban RPC result codes that are transient and therefore safe to
 * retry. `tx_bad_seq` is a stale sequence number (reload and resubmit);
 * `tx_too_late` / timeouts are network-level and clear on their own.
 */
export const RETRYABLE_RESULT_CODES: readonly string[] = [
  "tx_bad_seq",
  "tx_too_late",
  "timeout",
  "ETIMEDOUT",
  "ECONNRESET",
  "504",
  "503",
  "429"
];

export const SETTLEMENT_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8000
} as const;
