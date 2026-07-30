export const ACTION_TYPES = ["deposit", "withdraw", "create_vault", "claim", "select_winner"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const ACTION_STATUSES = ["pending", "submitted", "confirmed", "failed", "reverted", "orphaned"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["submitted", "failed"],
  submitted: ["confirmed", "reverted", "orphaned", "failed"],
  confirmed: [],
  failed: [],
  reverted: [],
  orphaned: ["submitted"],
};

export function canTransition(from: ActionStatus, to: string): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to);
}

export const ERROR_CODES = {
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
  ILLEGAL_TRANSITION: "ILLEGAL_TRANSITION",
  TX_HASH_ALREADY_ATTACHED: "TX_HASH_ALREADY_ATTACHED",
  REVERTED_ON_CHAIN: "REVERTED_ON_CHAIN",
  ORPHAN_TTL_EXPIRED: "ORPHAN_TTL_EXPIRED",
  NOT_FOUND: "NOT_FOUND",
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  SETTLEMENT_RETRIES_EXHAUSTED: "SETTLEMENT_RETRIES_EXHAUSTED",
  SETTLEMENT_SUBMIT_FAILED: "SETTLEMENT_SUBMIT_FAILED",
  INVALID_CURSOR: "INVALID_CURSOR",
  EXPIRED_CURSOR: "EXPIRED_CURSOR",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const RETRYABLE_RESULT_CODES = [
  "tx_bad_seq",
  "tx_too_late",
  "tx_no_source_account",
  "tx_internal_error",
] as const;

export const SETTLEMENT_RETRY = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
} as const;

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
