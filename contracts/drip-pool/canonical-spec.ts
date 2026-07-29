/**
 * Canonical contract specification for cross-stack conformance testing.
 *
 * This module exports the authoritative contract schema derived from
 * contracts/drip-pool/src/lib.rs. Changes to the contract MUST be
 * reflected here first; CI validates backend and wallet types against
 * this spec.
 *
 * @module
 */

// ── Contract Error Codes (Rust Error enum) ──────────────────────────────────

export const CONTRACT_ERRORS = {
  AlreadyInitialized: 1,
  NotInitialized: 2,
  AlreadyJoined: 3,
  NotJoined: 4,
  InvalidAmount: 5,
  Locked: 6,
  LockupActive: 7,
  Unauthorized: 8,
  ThresholdNotMet: 9,
  AlreadySigned: 10,
  ProposalNotFound: 11,
  ProposalExpired: 12,
  InvalidAction: 13,
} as const;

export type ContractErrorCode = keyof typeof CONTRACT_ERRORS;

// ── Event Topics ────────────────────────────────────────────────────────────

export const EVENT_TOPICS = {
  pool_created: ["pool", "created"],
  pool_joined: ["pool", "joined"],
  pool_deposit: ["pool", "deposit"],
  pool_withdrawn: ["pool", "withdrawn"],
  pool_claimed: ["pool", "claimed"],
  pool_payout: ["pool", "payout"],
} as const;

export type EventTopicKey = keyof typeof EVENT_TOPICS;

// ── Event Data Shapes ───────────────────────────────────────────────────────

export interface PoolCreatedEvent {
  topics: ["pool", "created"];
  data: { address: string };
}

export interface PoolJoinedEvent {
  topics: ["pool", "joined"];
  data: { address: string };
}

export interface PoolDepositEvent {
  topics: ["pool", "deposit"];
  data: {
    who: string;
    amount: string; // i128 as string to avoid precision loss
    total_deposited: string;
  };
}

export interface PoolWithdrawnEvent {
  topics: ["pool", "withdrawn"];
  data: {
    who: string;
    amount: string;
  };
}

export interface PoolClaimedEvent {
  topics: ["pool", "claimed"];
  data: {
    who: string;
    amount: string;
  };
}

export interface PoolPayoutEvent {
  topics: ["pool", "payout"];
  data: {
    winner: string;
    prize: string;
  };
}

export type ContractEvent =
  | PoolCreatedEvent
  | PoolJoinedEvent
  | PoolDepositEvent
  | PoolWithdrawnEvent
  | PoolClaimedEvent
  | PoolPayoutEvent;

// ── Struct Shapes (on-chain representation) ─────────────────────────────────

export interface OnChainPool {
  admin: string;
  total_drips: number; // u64
  total_deposited: string; // i128
  created_at: number; // u64
  locked: boolean;
  proposal_nonce: number; // u32
  distributable_yield: string; // i128
}

export interface OnChainParticipant {
  joined_at: number; // u64
  deposited: string; // i128
  claimable: string; // i128
  locked_until: number; // u32
  lockup_multiplier: number; // u32
  yield_accrued: string; // i128
}

// ── Contract Method Signatures ──────────────────────────────────────────────

export type ContractMethod =
  | "create"
  | "seed_admin"
  | "propose"
  | "approve"
  | "cancel_proposal"
  | "join"
  | "deposit"
  | "drip"
  | "deposit_with_duration"
  | "claim"
  | "claim_reward"
  | "withdraw"
  | "withdraw_locked"
  | "add_yield"
  | "credit_yield"
  | "draw_winner"
  | "pool"
  | "savings"
  | "admins"
  | "threshold";

// ── Cross-Stack Type Mapping ────────────────────────────────────────────────

/** Maps contract action names to backend ActionType values. */
export const CONTRACT_TO_BACKEND: Record<string, string> = {
  deposit: "deposit",
  withdraw: "withdraw",
  create: "create_vault",
  claim: "claim",
  draw_winner: "select_winner",
};

/** Maps contract action names to wallet PoolActionType values. */
export const CONTRACT_TO_WALLET: Record<string, string> = {
  create: "create",
  join: "join",
  deposit: "drip",
  drip: "drip",
  claim: "claim",
  claim_reward: "claim",
  withdraw: "withdraw",
};

/** Maps backend ActionType values to wallet PoolActionType values. */
export const BACKEND_TO_WALLET: Record<string, string> = {
  deposit: "drip",
  withdraw: "withdraw",
  create_vault: "create",
  claim: "claim",
  select_winner: "draw_winner",
};

// ── Error Code Mapping ──────────────────────────────────────────────────────

/** Maps contract error codes to backend error codes. */
export const CONTRACT_TO_BACKEND_ERRORS: Record<ContractErrorCode, string> = {
  AlreadyInitialized: "INVALID_PAYLOAD",
  NotInitialized: "INVALID_PAYLOAD",
  AlreadyJoined: "INVALID_PAYLOAD",
  NotJoined: "NOT_FOUND",
  InvalidAmount: "INVALID_PAYLOAD",
  Locked: "REVERTED_ON_CHAIN",
  LockupActive: "REVERTED_ON_CHAIN",
  Unauthorized: "UNAUTHORIZED",
  ThresholdNotMet: "FORBIDDEN",
  AlreadySigned: "INVALID_PAYLOAD",
  ProposalNotFound: "NOT_FOUND",
  ProposalExpired: "INVALID_PAYLOAD",
  InvalidAction: "INVALID_PAYLOAD",
};

/** Maps contract error codes to wallet ContractErrorKind values. */
export const CONTRACT_TO_WALLET_ERRORS: Record<ContractErrorCode, string> = {
  AlreadyInitialized: "contract_error",
  NotInitialized: "contract_error",
  AlreadyJoined: "contract_error",
  NotJoined: "contract_error",
  InvalidAmount: "contract_error",
  Locked: "contract_error",
  LockupActive: "contract_error",
  Unauthorized: "signature_rejected",
  ThresholdNotMet: "contract_error",
  AlreadySigned: "contract_error",
  ProposalNotFound: "contract_error",
  ProposalExpired: "contract_error",
  InvalidAction: "contract_error",
};

// ── Validation Helpers ──────────────────────────────────────────────────────

/**
 * Validate that a contract event matches the canonical shape.
 * Returns null if valid, or an error message.
 */
export function validateContractEvent(
  topics: string[],
  data: Record<string, unknown>
): string | null {
  if (topics.length < 2) {
    return "Event must have at least 2 topics";
  }

  const [category, action] = topics;
  if (category !== "pool") {
    return `Expected first topic "pool", got "${category}"`;
  }

  const validActions = ["created", "joined", "deposit", "withdrawn", "claimed", "payout"];
  if (!validActions.includes(action)) {
    return `Unknown event action "${action}"`;
  }

  return null;
}

/**
 * Validate that a contract method exists in the canonical spec.
 * Returns null if valid, or an error message.
 */
export function validateContractMethod(method: string): string | null {
  const validMethods: string[] = [
    "create", "seed_admin", "propose", "approve", "cancel_proposal",
    "join", "deposit", "drip", "deposit_with_duration", "claim",
    "claim_reward", "withdraw", "withdraw_locked", "add_yield",
    "credit_yield", "draw_winner", "pool", "savings", "admins", "threshold",
  ];

  if (!validMethods.includes(method)) {
    return `Unknown contract method "${method}"`;
  }

  return null;
}

/**
 * Validate that a contract error code is within the valid range.
 * Returns null if valid, or an error message.
 */
export function validateContractErrorCode(code: number): string | null {
  if (code < 1 || code > 13) {
    return `Invalid contract error code ${code}; expected 1-13`;
  }
  return null;
}
