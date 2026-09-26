export const ACTION_TYPES = ["deposit", "withdraw", "create_vault", "claim", "select_winner", "compensating"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ["pending", "submitted", "confirmed", "failed", "reverted", "orphaned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const FINALITY_STATUSES = ["provisional", "finalized", "invalidated"] as const;
export type FinalityStatus = (typeof FINALITY_STATUSES)[number];

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
  SETTLEMENT_IN_PROGRESS: "SETTLEMENT_IN_PROGRESS"
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Lifecycle of a vault payout. A vault starts `Unresolved`; the settlement
 * pipeline moves it to `Resolving` while a transaction is in flight and to a
 * terminal state on success. On any submission failure the vault is rolled
 * back to `Unresolved` so it can be retried safely.
 */
export const VAULT_STATES = ["Unresolved", "Resolving", "Resolved", "Refunded"] as const;
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

/**
 * Finality policy configuration.
 * Stellar/Soroban uses probabilistic finality; the default of 32 ledgers (~5 min)
 * matches the recommended safety margin for high-value transactions.
 * Override via env FINALITY_CONFIRMATION_DEPTH for different risk profiles.
 */
export const FINALITY_POLICY = {
  /** Default confirmation depth in ledgers (32 = ~5 minutes on Stellar). */
  defaultConfirmationDepth: 32,
  /** Maximum depth we track for finality validation. */
  maxTrackedDepth: 500,
  /** How often to check and finalize provisional entries (ms). */
  checkIntervalMs: 30_000,
} as const;

export type FinalityPolicy = typeof FINALITY_POLICY;
