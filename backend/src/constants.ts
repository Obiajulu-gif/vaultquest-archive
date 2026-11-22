export const ACTION_TYPES = ["deposit", "withdraw", "create_vault", "claim", "select_winner", "compensating"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ["pending", "submitted", "confirmed", "failed", "reverted", "orphaned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const FINALITY_STATUSES = ["provisional", "finalized", "invalidated"] as const;
export type FinalityStatus = (typeof FINALITY_STATUSES)[number];

export const TERMINAL_STATUSES: readonly ActionStatus[] = ["confirmed", "failed", "reverted", "orphaned"];

const TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  pending: ["submitted", "failed"],
  submitted: ["confirmed", "reverted", "orphaned", "failed"],
  confirmed: [],
  failed: [],
  reverted: [],
  orphaned: []
};

export function canTransition(from: ActionStatus, to: string): boolean {
  return (TRANSITIONS[from] ?? []).includes(to as ActionStatus);
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
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  OPERATION_LIMIT_EXCEEDED: "OPERATION_LIMIT_EXCEEDED",
  INVALID_CURSOR: "INVALID_CURSOR",
  EXPIRED_CURSOR: "EXPIRED_CURSOR",
  // Escrow settlement pipeline (#settlement)
  SETTLEMENT_SUBMIT_FAILED: "SETTLEMENT_SUBMIT_FAILED",
  SETTLEMENT_RETRIES_EXHAUSTED: "SETTLEMENT_RETRIES_EXHAUSTED",
  SETTLEMENT_ALREADY_RESOLVED: "SETTLEMENT_ALREADY_RESOLVED",
  SETTLEMENT_IN_PROGRESS: "SETTLEMENT_IN_PROGRESS",
  // #509 — submission succeeded on-chain but independent verification
  // against the finalized event could not confirm the payout facts.
  SETTLEMENT_PAYOUT_UNVERIFIED: "SETTLEMENT_PAYOUT_UNVERIFIED",
  // #768 — codes previously emitted as bare strings by the error handler.
  INTERNAL: "INTERNAL",
  DATABASE_ERROR: "DATABASE_ERROR",
  CONFLICT: "CONFLICT",
  HTTP_ERROR: "HTTP_ERROR",
  // VaultQuest-specific rejection reasons (vault operations)
  VAULT_INVALID_AMOUNT: "VAULT_INVALID_AMOUNT",
  VAULT_INVALID_POOL_ID: "VAULT_INVALID_POOL_ID",
  VAULT_INVALID_WALLET_ADDRESS: "VAULT_INVALID_WALLET_ADDRESS",
  VAULT_INVALID_ASSET: "VAULT_INVALID_ASSET",
  VAULT_INVALID_TIMESTAMP: "VAULT_INVALID_TIMESTAMP",
  VAULT_UNAUTHORIZED_OPERATION: "VAULT_UNAUTHORIZED_OPERATION",
  VAULT_FORBIDDEN_OPERATION: "VAULT_FORBIDDEN_OPERATION",
  VAULT_WALLET_NOT_CONNECTED: "VAULT_WALLET_NOT_CONNECTED",
  VAULT_SIGNATURE_REQUIRED: "VAULT_SIGNATURE_REQUIRED",
  VAULT_POOL_CLOSED: "VAULT_POOL_CLOSED",
  VAULT_POOL_LOCKED: "VAULT_POOL_LOCKED",
  VAULT_POOL_CANCELLED: "VAULT_POOL_CANCELLED",
  VAULT_POOL_EMERGENCY: "VAULT_POOL_EMERGENCY",
  VAULT_DEPOSIT_CAP_EXCEEDED: "VAULT_DEPOSIT_CAP_EXCEEDED",
  VAULT_POOL_CAP_EXCEEDED: "VAULT_POOL_CAP_EXCEEDED",
  VAULT_LOCKUP_ACTIVE: "VAULT_LOCKUP_ACTIVE",
  VAULT_CLAIM_DEADLINE_PASSED: "VAULT_CLAIM_DEADLINE_PASSED",
  VAULT_INSUFFICIENT_LIQUIDITY: "VAULT_INSUFFICIENT_LIQUIDITY",
  VAULT_INSUFFICIENT_BALANCE: "VAULT_INSUFFICIENT_BALANCE",
  VAULT_ALREADY_CLAIMED: "VAULT_ALREADY_CLAIMED",
  VAULT_NOT_PARTICIPANT: "VAULT_NOT_PARTICIPANT",
  VAULT_INSUFFICIENT_YIELD_RESERVE: "VAULT_INSUFFICIENT_YIELD_RESERVE",
  VAULT_INVALID_ACTION_STATE: "VAULT_INVALID_ACTION_STATE",
  VAULT_STALE_POOL_DATA: "VAULT_STALE_POOL_DATA",
  VAULT_STALE_POSITION_DATA: "VAULT_STALE_POSITION_DATA",
  VAULT_CONCURRENT_MODIFICATION: "VAULT_CONCURRENT_MODIFICATION",
  VAULT_VERSION_MISMATCH: "VAULT_VERSION_MISMATCH",
  VAULT_WALLET_REJECTED: "VAULT_WALLET_REJECTED",
  VAULT_WALLET_TIMEOUT: "VAULT_WALLET_TIMEOUT",
  VAULT_NETWORK_ERROR: "VAULT_NETWORK_ERROR",
  VAULT_RPC_FAILURE: "VAULT_RPC_FAILURE",
  VAULT_CONTRACT_REVERTED: "VAULT_CONTRACT_REVERTED",
  VAULT_TRANSACTION_TIMEOUT: "VAULT_TRANSACTION_TIMEOUT",
  VAULT_INDEXER_UNAVAILABLE: "VAULT_INDEXER_UNAVAILABLE",
  // Webhook verification and replay-window enforcement (#799)
  WEBHOOK_SIGNATURE_INVALID: "WEBHOOK_SIGNATURE_INVALID",
  WEBHOOK_SIGNATURE_MISSING: "WEBHOOK_SIGNATURE_MISSING",
  WEBHOOK_TIMESTAMP_STALE: "WEBHOOK_TIMESTAMP_STALE",
  WEBHOOK_TIMESTAMP_MISSING: "WEBHOOK_TIMESTAMP_MISSING",
  WEBHOOK_DUPLICATE_EVENT: "WEBHOOK_DUPLICATE_EVENT",
  WEBHOOK_EVENT_MALFORMED: "WEBHOOK_EVENT_MALFORMED",
  WEBHOOK_PROVIDER_UNSUPPORTED: "WEBHOOK_PROVIDER_UNSUPPORTED",
  // Queue backpressure (#974)
  QUEUE_BACKPRESSURE: "QUEUE_BACKPRESSURE",
  // Invariant checks (#979)
  INVARIANT_VIOLATION: "INVARIANT_VIOLATION",
  BALANCE_INVARIANT_VIOLATION: "BALANCE_INVARIANT_VIOLATION",
  OWNERSHIP_INVARIANT_VIOLATION: "OWNERSHIP_INVARIANT_VIOLATION",
  ENTITLEMENT_INVARIANT_VIOLATION: "ENTITLEMENT_INVARIANT_VIOLATION",
  // Degraded mode & dependency unavailable (#978)
  SERVICE_DEGRADED: "SERVICE_DEGRADED",
  DEPENDENCY_UNAVAILABLE: "DEPENDENCY_UNAVAILABLE",
  // Problem Details Taxonomy additions (#946)
  // Vault deposits
  VAULT_DEPOSIT_BELOW_MIN: "VAULT_DEPOSIT_BELOW_MIN",
  VAULT_DEPOSIT_REVERTED: "VAULT_DEPOSIT_REVERTED",
  // Prize rounds
  ROUND_NOT_OPEN: "ROUND_NOT_OPEN",
  ROUND_LOCKED: "ROUND_LOCKED",
  ROUND_RANDOMNESS_PENDING: "ROUND_RANDOMNESS_PENDING",
  ROUND_ALREADY_DRAWN: "ROUND_ALREADY_DRAWN",
  ROUND_REVEAL_TIMEOUT: "ROUND_REVEAL_TIMEOUT",
  DRAW_PROOF_INVALID: "DRAW_PROOF_INVALID",
  // Quests
  QUEST_NOT_FOUND: "QUEST_NOT_FOUND",
  QUEST_NOT_JOINABLE: "QUEST_NOT_JOINABLE",
  QUEST_UNFUNDED: "QUEST_UNFUNDED",
  QUEST_ALREADY_COMPLETED: "QUEST_ALREADY_COMPLETED",
  QUEST_PROGRESS_INVALID: "QUEST_PROGRESS_INVALID",
  // Wallet flows
  WALLET_UNSUPPORTED_NETWORK: "WALLET_UNSUPPORTED_NETWORK",
  WALLET_INSUFFICIENT_FUNDS: "WALLET_INSUFFICIENT_FUNDS",
  WALLET_SESSION_EXPIRED: "WALLET_SESSION_EXPIRED",
  WALLET_SIGNATURE_INVALID: "WALLET_SIGNATURE_INVALID",
  // Indexer reconciliation
  INDEXER_CURSOR_STALE: "INDEXER_CURSOR_STALE",
  INDEXER_REORG_DETECTED: "INDEXER_REORG_DETECTED",
  RECONCILIATION_MISMATCH: "RECONCILIATION_MISMATCH",
  EVENT_QUARANTINED: "EVENT_QUARANTINED",
  POISON_EVENT_DETECTED: "POISON_EVENT_DETECTED",
  // Expiring capability tokens (#984)
  CAPABILITY_TOKEN_REQUIRED: "CAPABILITY_TOKEN_REQUIRED",
  CAPABILITY_TOKEN_EXPIRED: "CAPABILITY_TOKEN_EXPIRED",
  CAPABILITY_TOKEN_INVALID: "CAPABILITY_TOKEN_INVALID",
  CAPABILITY_TOKEN_CONSUMED: "CAPABILITY_TOKEN_CONSUMED",
  CAPABILITY_TOKEN_SCOPE_MISMATCH: "CAPABILITY_TOKEN_SCOPE_MISMATCH",
  CAPABILITY_TOKEN_ACTOR_MISMATCH: "CAPABILITY_TOKEN_ACTOR_MISMATCH",
  CAPABILITY_TOKEN_REVOKED: "CAPABILITY_TOKEN_REVOKED",
  // Strict allowlist validation (#990)
  URL_NOT_ALLOWED: "URL_NOT_ALLOWED",
  FILE_TYPE_NOT_ALLOWED: "FILE_TYPE_NOT_ALLOWED",
  DESTINATION_NOT_ALLOWED: "DESTINATION_NOT_ALLOWED",
  // Safe cancellation (#987)
  OPERATION_CANCELLED: "OPERATION_CANCELLED",
  CANCELLATION_NOT_ALLOWED: "CANCELLATION_NOT_ALLOWED",
  // Deterministic sorting (#997)
  INVALID_SORT_KEY: "INVALID_SORT_KEY",
  CURSOR_ORDER_MISMATCH: "CURSOR_ORDER_MISMATCH",
  // Versioned projection rebuild (#989): the indexer lease is held right now.
  PROJECTION_REBUILD_BUSY: "PROJECTION_REBUILD_BUSY"
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
  "tx_no_source_account",
  "tx_internal_error",
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

/**
 * Schema stamps for the versioned API and the deployment preflight check (#803).
 *
 * Both stamps are derived from Prisma migration names: the 14-digit prefix of a
 * migration directory (e.g. `20260725000002_add_wallet_auth` -> `20260725000002`).
 * Because they share one coordinate system, the database stamp and the stamp the
 * indexer reports can be compared directly.
 *
 * - `DATABASE` – migration stamp this build expects the database to be at.
 * - `INDEXER`  – stamp the indexer writes into its checkpoint on startup.
 * - `OLDEST`   – oldest migration stamp this build can still serve. Anything
 *   older predates a schema the current code depends on and must be migrated first.
 * - `SUPPORTED_*` – the migration stamps inside the supported window, published
 *   through `GET /schema-version` so integrators can see what is servable.
 *   Compatibility itself is a range check (see `getVersionMismatch`), so a stamp
 *   inside the window that is not enumerated here is still compatible.
 *
 * Versioning rules:
 * - Adding a migration that changes the shape of read/write paths bumps
 *   `DATABASE` and `INDEXER` together and appends the stamp to `SUPPORTED_*`.
 * - Extending the window backwards (raising `OLDEST`) is a breaking change for
 *   anyone pinned to an older deployment and must be announced in
 *   `backend/docs/SCHEMA_VERSIONS.md`.
 */
export const SCHEMA_VERSIONS = {
  DATABASE: "20261001000001",
  INDEXER: "20261001000001",
  OLDEST: "20260725000002",
  SUPPORTED_DATABASE_VERSIONS: [
    "20260725000002",
    "20260728000000",
    "20260728000001",
    "20260728010000",
    "20260729000000",
    "20260729000001",
    "20260729000002",
    "20260825000000",
    "20260830000000",
    "20260924000000",
    "20260925000000",
    "20260926000000",
    "20260926000001",
    "20260926000002",
    "20260927000000",
    "20260927000001",
    "20260929000000",
    "20260930000000",
    "20261001000000",
    "20261001000001",
  ],
  SUPPORTED_INDEXER_VERSIONS: [
    "20260725000002",
    "20260728000000",
    "20260728000001",
    "20260728010000",
    "20260729000000",
    "20260729000001",
    "20260729000002",
    "20260825000000",
    "20260830000000",
    "20260924000000",
    "20260925000000",
    "20260926000000",
    "20260926000001",
    "20260926000002",
    "20260927000000",
    "20260927000001",
    "20260929000000",
    "20260930000000",
    "20261001000000",
    "20261001000001",
  ],
} as const;

/**
 * Compare a reported schema stamp against the window this build supports.
 *
 * Both stamps live on the same 14-digit migration coordinate system, so the
 * window check is a lexicographic range check. `unknown` means the stamp could
 * not be read at all (no migrations applied / no indexer checkpoint yet) and is
 * reported as its own issue so a deployment never guesses.
 */
export function getVersionMismatch(
  databaseVersion: string,
  indexerVersion: string,
): { compatible: boolean; issues: string[] } {
  const issues: string[] = [];

  const check = (
    label: "Database" | "Indexer",
    version: string,
    expected: string,
  ): void => {
    if (version === "unknown") {
      issues.push(
        `${label} schema version could not be determined; apply pending migrations or start the indexer before deploying.`,
      );
      return;
    }
    if (version < SCHEMA_VERSIONS.OLDEST) {
      issues.push(
        `${label} schema version ${version} is not supported: it is older than the oldest supported version ${SCHEMA_VERSIONS.OLDEST}.`,
      );
      return;
    }
    if (version > expected) {
      issues.push(
        `${label} schema version ${version} is not supported by this build (expected ${expected}); roll the deployment back to a build that understands it.`,
      );
    }
  };

  check("Database", databaseVersion, SCHEMA_VERSIONS.DATABASE);
  check("Indexer", indexerVersion, SCHEMA_VERSIONS.INDEXER);

  return { compatible: issues.length === 0, issues };
}
