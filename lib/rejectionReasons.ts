/**
 * VaultQuest Rejection Reason Codes and Explanation Objects
 *
 * This module provides user-facing explanation objects for rejected operations
 * across VaultQuest vault operations (deposit, withdraw, claim, draw_winner, etc.).
 *
 * Rejection categories:
 * - validation: Input/parameter validation failures
 * - permission: Authorization and permission failures
 * - policy: Protocol-level policy violations (caps, deadlines, lockups)
 * - stale_state: State consistency issues (concurrent modifications, stale data)
 * - external: External dependency failures (network, RPC, wallet)
 *
 * Each rejection reason includes:
 * - Stable reason code (for API contracts and logging)
 * - User-safe message (what went wrong)
 * - Recovery hint (what the user can do)
 * - Retryable flag (whether retrying without changes may succeed)
 */

export type RejectionCategory =
  | "validation"
  | "permission"
  | "policy"
  | "stale_state"
  | "external";

export interface RejectionExplanation {
  /** Stable reason code for API contracts and logging */
  reasonCode: string;
  /** Human-readable category for grouping */
  category: RejectionCategory;
  /** User-safe message explaining what went wrong */
  userMessage: string;
  /** Actionable next step for the user */
  recoveryHint: string;
  /** Whether retrying the same request may succeed without changes */
  retryable: boolean;
  /** Technical context for debugging (optional, not shown to users) */
  technicalContext?: string;
}

/**
 * VaultQuest-specific rejection reason codes
 *
 * These codes are stable and should not change without a migration plan.
 * They are used in API responses and should be treated as part of the public contract.
 */
export const VAULT_REJECTION_REASONS = {
  // Validation failures
  INVALID_AMOUNT: "VAULT_INVALID_AMOUNT",
  INVALID_POOL_ID: "VAULT_INVALID_POOL_ID",
  INVALID_WALLET_ADDRESS: "VAULT_INVALID_WALLET_ADDRESS",
  INVALID_ASSET: "VAULT_INVALID_ASSET",
  INVALID_TIMESTAMP: "VAULT_INVALID_TIMESTAMP",

  // Permission failures
  UNAUTHORIZED_OPERATION: "VAULT_UNAUTHORIZED_OPERATION",
  FORBIDDEN_OPERATION: "VAULT_FORBIDDEN_OPERATION",
  WALLET_NOT_CONNECTED: "VAULT_wallet_NOT_CONNECTED",
  SIGNATURE_REQUIRED: "VAULT_SIGNATURE_REQUIRED",

  // Policy violations
  POOL_CLOSED: "VAULT_POOL_CLOSED",
  POOL_LOCKED: "VAULT_POOL_LOCKED",
  POOL_CANCELLED: "VAULT_POOL_CANCELLED",
  POOL_EMERGENCY: "VAULT_POOL_EMERGENCY",
  DEPOSIT_CAP_EXCEEDED: "VAULT_DEPOSIT_CAP_EXCEEDED",
  POOL_CAP_EXCEEDED: "VAULT_POOL_CAP_EXCEEDED",
  LOCKUP_ACTIVE: "VAULT_LOCKUP_ACTIVE",
  CLAIM_DEADLINE_PASSED: "VAULT_CLAIM_DEADLINE_PASSED",
  INSUFFICIENT_LIQUIDITY: "VAULT_INSUFFICIENT_LIQUIDITY",
  INSUFFICIENT_BALANCE: "VAULT_INSUFFICIENT_BALANCE",
  ALREADY_CLAIMED: "VAULT_ALREADY_CLAIMED",
  NOT_PARTICIPANT: "VAULT_NOT_PARTICIPANT",
  INSUFFICIENT_YIELD_RESERVE: "VAULT_INSUFFICIENT_YIELD_RESERVE",
  INVALID_ACTION_STATE: "VAULT_INVALID_ACTION_STATE",

  // Stale state issues
  STALE_POOL_DATA: "VAULT_STALE_POOL_DATA",
  STALE_POSITION_DATA: "VAULT_STALE_POSITION_DATA",
  CONCURRENT_MODIFICATION: "VAULT_CONCURRENT_MODIFICATION",
  VERSION_MISMATCH: "VAULT_VERSION_MISMATCH",

  // External failures
  WALLET_REJECTED: "VAULT_WALLET_REJECTED",
  WALLET_TIMEOUT: "VAULT_WALLET_TIMEOUT",
  NETWORK_ERROR: "VAULT_NETWORK_ERROR",
  RPC_FAILURE: "VAULT_RPC_FAILURE",
  CONTRACT_REVERTED: "VAULT_CONTRACT_REVERTED",
  TRANSACTION_TIMEOUT: "VAULT_TRANSACTION_TIMEOUT",
  INDEXER_UNAVAILABLE: "VAULT_INDEXER_UNAVAILABLE",
} as const;

export type VaultRejectionReason = (typeof VAULT_REJECTION_REASONS)[keyof typeof VAULT_REJECTION_REASONS];

/**
 * Rejection explanation catalog
 *
 * Maps each rejection reason to a user-facing explanation with recovery hints.
 */
export const REJECTION_EXPLANATIONS: Record<VaultRejectionReason, RejectionExplanation> = {
  // Validation failures
  [VAULT_REJECTION_REASONS.INVALID_AMOUNT]: {
    reasonCode: VAULT_REJECTION_REASONS.INVALID_AMOUNT,
    category: "validation",
    userMessage: "The amount provided is not valid.",
    recoveryHint: "Enter a positive amount greater than zero and try again.",
    retryable: false,
    technicalContext: "Amount must be > 0 for deposits, withdrawals, and prize draws",
  },
  [VAULT_REJECTION_REASONS.INVALID_POOL_ID]: {
    reasonCode: VAULT_REJECTION_REASONS.INVALID_POOL_ID,
    category: "validation",
    userMessage: "The pool identifier is not valid.",
    recoveryHint: "Verify the pool ID and try again. If the issue persists, contact support.",
    retryable: false,
    technicalContext: "Pool ID must be a valid contract address or identifier",
  },
  [VAULT_REJECTION_REASONS.INVALID_WALLET_ADDRESS]: {
    reasonCode: VAULT_REJECTION_REASONS.INVALID_WALLET_ADDRESS,
    category: "validation",
    userMessage: "The wallet address is not valid.",
    recoveryHint: "Ensure your wallet is connected and has a valid Stellar address.",
    retryable: false,
    technicalContext: "Wallet address must be a valid Stellar public key",
  },
  [VAULT_REJECTION_REASONS.INVALID_ASSET]: {
    reasonCode: VAULT_REJECTION_REASONS.INVALID_ASSET,
    category: "validation",
    userMessage: "The asset type is not supported by this pool.",
    recoveryHint: "Check the pool's accepted assets and use a supported asset.",
    retryable: false,
    technicalContext: "Asset must match the pool's accepted asset code",
  },
  [VAULT_REJECTION_REASONS.INVALID_TIMESTAMP]: {
    reasonCode: VAULT_REJECTION_REASONS.INVALID_TIMESTAMP,
    category: "validation",
    userMessage: "The timestamp provided is not valid.",
    recoveryHint: "Ensure your device's clock is correct and try again.",
    retryable: false,
    technicalContext: "Timestamp must be within acceptable bounds",
  },

  // Permission failures
  [VAULT_REJECTION_REASONS.UNAUTHORIZED_OPERATION]: {
    reasonCode: VAULT_REJECTION_REASONS.UNAUTHORIZED_OPERATION,
    category: "permission",
    userMessage: "You are not authorized to perform this operation.",
    recoveryHint: "Connect your wallet and sign in with the correct account.",
    retryable: false,
    technicalContext: "Operation requires authentication with a valid wallet",
  },
  [VAULT_REJECTION_REASONS.FORBIDDEN_OPERATION]: {
    reasonCode: VAULT_REJECTION_REASONS.FORBIDDEN_OPERATION,
    category: "permission",
    userMessage: "You do not have permission to perform this operation.",
    recoveryHint: "Use an account with the required permissions, or contact support if you believe this is an error.",
    retryable: false,
    technicalContext: "Operation requires specific role or permissions",
  },
  [VAULT_REJECTION_REASONS.WALLET_NOT_CONNECTED]: {
    reasonCode: VAULT_REJECTION_REASONS.WALLET_NOT_CONNECTED,
    category: "permission",
    userMessage: "Your wallet is not connected.",
    recoveryHint: "Connect your wallet to proceed with this operation.",
    retryable: false,
    technicalContext: "Wallet connection required for the operation",
  },
  [VAULT_REJECTION_REASONS.SIGNATURE_REQUIRED]: {
    reasonCode: VAULT_REJECTION_REASONS.SIGNATURE_REQUIRED,
    category: "permission",
    userMessage: "A signature is required to complete this operation.",
    recoveryHint: "Approve the transaction in your wallet when prompted.",
    retryable: true,
    technicalContext: "User must sign the transaction with their wallet",
  },

  // Policy violations
  [VAULT_REJECTION_REASONS.POOL_CLOSED]: {
    reasonCode: VAULT_REJECTION_REASONS.POOL_CLOSED,
    category: "policy",
    userMessage: "This pool is closed and no longer accepts deposits.",
    recoveryHint: "Choose a different pool that is currently open for deposits.",
    retryable: false,
    technicalContext: "Pool status is 'closed' - deposits are not accepted",
  },
  [VAULT_REJECTION_REASONS.POOL_LOCKED]: {
    reasonCode: VAULT_REJECTION_REASONS.POOL_LOCKED,
    category: "policy",
    userMessage: "This pool is locked for the current prize draw cycle.",
    recoveryHint: "Deposits will be accepted again after the prize draw completes. Check the pool's lock time.",
    retryable: false,
    technicalContext: "Pool status is 'locked' - deposits are frozen until draw completes",
  },
  [VAULT_REJECTION_REASONS.POOL_CANCELLED]: {
    reasonCode: VAULT_REJECTION_REASONS.POOL_CANCELLED,
    category: "policy",
    userMessage: "This pool has been cancelled.",
    recoveryHint: "Withdraw your funds from this pool. Choose a different pool for future deposits.",
    retryable: false,
    technicalContext: "Pool status is 'cancelled' - no new operations accepted",
  },
  [VAULT_REJECTION_REASONS.POOL_EMERGENCY]: {
    reasonCode: VAULT_REJECTION_REASONS.POOL_EMERGENCY,
    category: "policy",
    userMessage: "This pool is in emergency mode.",
    recoveryHint: "Withdrawals and claims are still available, but deposits are paused. Contact support for details.",
    retryable: false,
    technicalContext: "Pool emergency circuit breaker is active - deposits blocked",
  },
  [VAULT_REJECTION_REASONS.DEPOSIT_CAP_EXCEEDED]: {
    reasonCode: VAULT_REJECTION_REASONS.DEPOSIT_CAP_EXCEEDED,
    category: "policy",
    userMessage: "This deposit would exceed your personal cap for this pool.",
    recoveryHint: "Deposit a smaller amount, or choose a different pool with a higher cap.",
    retryable: false,
    technicalContext: "Deposit exceeds max_wallet_deposit limit",
  },
  [VAULT_REJECTION_REASONS.POOL_CAP_EXCEEDED]: {
    reasonCode: VAULT_REJECTION_REASONS.POOL_CAP_EXCEEDED,
    category: "policy",
    userMessage: "This pool has reached its total deposit capacity.",
    recoveryHint: "Choose a different pool with available capacity, or wait for this pool to have space.",
    retryable: false,
    technicalContext: "Pool TVL exceeds max_pool_deposit limit",
  },
  [VAULT_REJECTION_REASONS.LOCKUP_ACTIVE]: {
    reasonCode: VAULT_REJECTION_REASONS.LOCKUP_ACTIVE,
    category: "policy",
    userMessage: "Your funds are still in the lockup period.",
    recoveryHint: `Wait until the lockup period ends before withdrawing. Check your position for the exact unlock time.`,
    retryable: false,
    technicalContext: "Withdrawal attempted before locked_until timestamp",
  },
  [VAULT_REJECTION_REASONS.CLAIM_DEADLINE_PASSED]: {
    reasonCode: VAULT_REJECTION_REASONS.CLAIM_DEADLINE_PASSED,
    category: "policy",
    userMessage: "The claim deadline for this prize has passed.",
    recoveryHint: "This prize can no longer be claimed. Contact support if you believe this is an error.",
    retryable: false,
    technicalContext: "Claim attempted after pool deadline",
  },
  [VAULT_REJECTION_REASONS.INSUFFICIENT_LIQUIDITY]: {
    reasonCode: VAULT_REJECTION_REASONS.INSUFFICIENT_LIQUIDITY,
    category: "policy",
    userMessage: "The pool does not have enough available liquidity for this withdrawal.",
    recoveryHint: "Your withdrawal request has been queued and will be processed when liquidity becomes available.",
    retryable: false,
    technicalContext: "Withdrawal exceeds idle liquidity - queued for processing",
  },
  [VAULT_REJECTION_REASONS.INSUFFICIENT_BALANCE]: {
    reasonCode: VAULT_REJECTION_REASONS.INSUFFICIENT_BALANCE,
    category: "policy",
    userMessage: "You do not have enough balance to perform this operation.",
    recoveryHint: "Check your balance and ensure you have sufficient funds before trying again.",
    retryable: false,
    technicalContext: "Operation amount exceeds available balance",
  },
  [VAULT_REJECTION_REASONS.ALREADY_CLAIMED]: {
    reasonCode: VAULT_REJECTION_REASONS.ALREADY_CLAIMED,
    category: "policy",
    userMessage: "This prize has already been claimed.",
    recoveryHint: "Check your reward history to see your claimed prizes.",
    retryable: false,
    technicalContext: "Prize already claimed - duplicate claim rejected",
  },
  [VAULT_REJECTION_REASONS.NOT_PARTICIPANT]: {
    reasonCode: VAULT_REJECTION_REASONS.NOT_PARTICIPANT,
    category: "policy",
    userMessage: "You are not a participant in this pool.",
    recoveryHint: "Join the pool by making a deposit before attempting this operation.",
    retryable: false,
    technicalContext: "Operation requires active participation in the pool",
  },
  [VAULT_REJECTION_REASONS.INSUFFICIENT_YIELD_RESERVE]: {
    reasonCode: VAULT_REJECTION_REASONS.INSUFFICIENT_YIELD_RESERVE,
    category: "policy",
    userMessage: "The pool does not have enough yield reserve for this operation.",
    recoveryHint: "This operation cannot be completed at this time. Contact support for details.",
    retryable: false,
    technicalContext: "Yield credit exceeds distributable reserve",
  },
  [VAULT_REJECTION_REASONS.INVALID_ACTION_STATE]: {
    reasonCode: VAULT_REJECTION_REASONS.INVALID_ACTION_STATE,
    category: "policy",
    userMessage: "This action is not allowed in the current pool state.",
    recoveryHint: "Refresh the pool status and try again. If the issue persists, contact support.",
    retryable: false,
    technicalContext: "Action not valid for current pool round state",
  },

  // Stale state issues
  [VAULT_REJECTION_REASONS.STALE_POOL_DATA]: {
    reasonCode: VAULT_REJECTION_REASONS.STALE_POOL_DATA,
    category: "stale_state",
    userMessage: "The pool data is out of date.",
    recoveryHint: "Refresh the page and try again.",
    retryable: true,
    technicalContext: "Pool data fetched from stale cache or indexer",
  },
  [VAULT_REJECTION_REASONS.STALE_POSITION_DATA]: {
    reasonCode: VAULT_REJECTION_REASONS.STALE_POSITION_DATA,
    category: "stale_state",
    userMessage: "Your position data is out of date.",
    recoveryHint: "Refresh the page and try again.",
    retryable: true,
    technicalContext: "Position data fetched from stale cache or indexer",
  },
  [VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION]: {
    reasonCode: VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION,
    category: "stale_state",
    userMessage: "This item was modified by another operation.",
    recoveryHint: "Refresh the page and try again.",
    retryable: true,
    technicalContext: "Concurrent modification detected - optimistic lock failed",
  },
  [VAULT_REJECTION_REASONS.VERSION_MISMATCH]: {
    reasonCode: VAULT_REJECTION_REASONS.VERSION_MISMATCH,
    category: "stale_state",
    userMessage: "There is a version mismatch between your client and the pool.",
    recoveryHint: "Refresh the page to get the latest version.",
    retryable: true,
    technicalContext: "Client version does not match pool metadata version",
  },

  // External failures
  [VAULT_REJECTION_REASONS.WALLET_REJECTED]: {
    reasonCode: VAULT_REJECTION_REASONS.WALLET_REJECTED,
    category: "external",
    userMessage: "The wallet rejected the transaction.",
    recoveryHint: "Approve the transaction in your wallet, or start again if you meant to cancel.",
    retryable: true,
    technicalContext: "User rejected the signature request in their wallet",
  },
  [VAULT_REJECTION_REASONS.WALLET_TIMEOUT]: {
    reasonCode: VAULT_REJECTION_REASONS.WALLET_TIMEOUT,
    category: "external",
    userMessage: "The wallet did not respond in time.",
    recoveryHint: "Open your wallet, check for a pending prompt, then try again.",
    retryable: true,
    technicalContext: "Wallet signature request timed out",
  },
  [VAULT_REJECTION_REASONS.NETWORK_ERROR]: {
    reasonCode: VAULT_REJECTION_REASONS.NETWORK_ERROR,
    category: "external",
    userMessage: "We could not reach the Stellar network.",
    recoveryHint: "Check your internet connection and retry in a few moments.",
    retryable: true,
    technicalContext: "Network connectivity issue with Stellar RPC/Horizon",
  },
  [VAULT_REJECTION_REASONS.RPC_FAILURE]: {
    reasonCode: VAULT_REJECTION_REASONS.RPC_FAILURE,
    category: "external",
    userMessage: "The Stellar RPC service returned an error.",
    recoveryHint: "Retry the operation. If it keeps failing, contact support with your error ID.",
    retryable: true,
    technicalContext: "Stellar RPC call failed",
  },
  [VAULT_REJECTION_REASONS.CONTRACT_REVERTED]: {
    reasonCode: VAULT_REJECTION_REASONS.CONTRACT_REVERTED,
    category: "external",
    userMessage: "The transaction was reverted on-chain.",
    recoveryHint: "Review the transaction details and create a new action if you still want to proceed.",
    retryable: false,
    technicalContext: "Smart contract execution reverted",
  },
  [VAULT_REJECTION_REASONS.TRANSACTION_TIMEOUT]: {
    reasonCode: VAULT_REJECTION_REASONS.TRANSACTION_TIMEOUT,
    category: "external",
    userMessage: "The transaction timed out waiting for confirmation.",
    recoveryHint: "Check your wallet for the transaction, then start a new action if it did not go through.",
    retryable: true,
    technicalContext: "Transaction confirmation timeout exceeded",
  },
  [VAULT_REJECTION_REASONS.INDEXER_UNAVAILABLE]: {
    reasonCode: VAULT_REJECTION_REASONS.INDEXER_UNAVAILABLE,
    category: "external",
    userMessage: "The pool indexer service is temporarily unavailable.",
    recoveryHint: "Retry the operation in a few moments. If it keeps failing, contact support.",
    retryable: true,
    technicalContext: "Pool indexer service unavailable",
  },
};

/**
 * Get explanation for a rejection reason
 *
 * @param reasonCode - The rejection reason code
 * @returns The explanation object, or a fallback if the code is unknown
 */
export function getRejectionExplanation(reasonCode: string): RejectionExplanation {
  if (isVaultRejectionReason(reasonCode)) {
    return REJECTION_EXPLANATIONS[reasonCode];
  }

  // Fallback for unknown reasons
  return {
    reasonCode: "UNKNOWN",
    category: "external",
    userMessage: "An unexpected error occurred.",
    recoveryHint: "Retry the operation. If it keeps failing, contact support with your error ID.",
    retryable: true,
    technicalContext: `Unknown rejection reason: ${reasonCode}`,
  };
}

/**
 * Type guard for vault rejection reasons
 */
export function isVaultRejectionReason(code: string): code is VaultRejectionReason {
  return Object.values(VAULT_REJECTION_REASONS).includes(code as VaultRejectionReason);
}

/**
 * Map contract behavior errors to vault rejection reasons
 *
 * This bridges the gap between contract-level errors (from conformance-spec.ts)
 * and user-facing rejection explanations.
 */
export function mapContractErrorToRejection(
  contractError: string
): VaultRejectionReason | null {
  const errorMap: Record<string, VaultRejectionReason> = {
    InvalidAmount: VAULT_REJECTION_REASONS.INVALID_AMOUNT,
    LockupActive: VAULT_REJECTION_REASONS.LOCKUP_ACTIVE,
    InvalidAction: VAULT_REJECTION_REASONS.INVALID_ACTION_STATE,
    ClaimDeadlinePassed: VAULT_REJECTION_REASONS.CLAIM_DEADLINE_PASSED,
  };

  return errorMap[contractError] || null;
}

/**
 * Map wallet/transaction errors to vault rejection reasons
 *
 * This bridges the gap between wallet/transaction errors (from txStateMachine.ts)
 * and user-facing rejection explanations.
 */
export function mapWalletErrorToRejection(errorKind: string): VaultRejectionReason | null {
  const errorMap: Record<string, VaultRejectionReason> = {
    wallet_disconnected: VAULT_REJECTION_REASONS.WALLET_NOT_CONNECTED,
    signature_rejected: VAULT_REJECTION_REASONS.WALLET_REJECTED,
    rpc_failure: VAULT_REJECTION_REASONS.RPC_FAILURE,
    contract_error: VAULT_REJECTION_REASONS.CONTRACT_REVERTED,
    stale_data: VAULT_REJECTION_REASONS.STALE_POOL_DATA,
    lockup_active: VAULT_REJECTION_REASONS.LOCKUP_ACTIVE,
    insufficient_liquidity: VAULT_REJECTION_REASONS.INSUFFICIENT_LIQUIDITY,
    network_mismatch: VAULT_REJECTION_REASONS.INVALID_ASSET,
    multisig_unsupported: VAULT_REJECTION_REASONS.FORBIDDEN_OPERATION,
    confirmation_timeout: VAULT_REJECTION_REASONS.TRANSACTION_TIMEOUT,
  };

  return errorMap[errorKind] || null;
}
