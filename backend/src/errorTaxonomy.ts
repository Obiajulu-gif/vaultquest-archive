import { ERROR_CODES, type ErrorCode } from "./constants.js";

/**
 * #768 — structured error taxonomy.
 *
 * Every stable `ErrorCode` maps to one catalog entry describing how it is
 * categorised, whether a client may retry, and what we are willing to tell a
 * user. Internal `message`/`detail` strings from thrown errors are never shown
 * for `internal`, `dependency` and `settlement` failures; the catalog's
 * `userMessage` is used instead so stack traces, SQL, and RPC payloads cannot
 * leak through the API.
 */
export const ERROR_CATEGORIES = [
  "validation",
  "authorization",
  "not_found",
  "conflict",
  "rate_limit",
  "wallet",
  "settlement",
  "dependency",
  "internal"
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export interface ErrorDescriptor {
  category: ErrorCategory;
  /** Whether repeating the same request may succeed without changes. */
  retryable: boolean;
  /** Safe to show to end users verbatim. */
  userMessage: string;
  /** Actionable next step for the user, when one exists. */
  recovery?: string;
  /**
   * When true the caller-supplied message is safe to expose (it is authored
   * by us for that failure, e.g. validation). Otherwise `userMessage` wins.
   */
  exposeMessage: boolean;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorDescriptor> = {
  [ERROR_CODES.WALLET_REJECTED]: {
    category: "wallet",
    retryable: true,
    userMessage: "The wallet rejected the request.",
    recovery: "Approve the request in your wallet, or start again if you meant to cancel.",
    exposeMessage: false
  },
  [ERROR_CODES.WALLET_TIMEOUT]: {
    category: "wallet",
    retryable: true,
    userMessage: "The wallet did not respond in time.",
    recovery: "Open your wallet, check for a pending prompt, then try again.",
    exposeMessage: false
  },
  [ERROR_CODES.INVALID_PAYLOAD]: {
    category: "validation",
    retryable: false,
    userMessage: "The request was not valid.",
    recovery: "Correct the highlighted fields and submit again.",
    exposeMessage: true
  },
  [ERROR_CODES.NETWORK_ERROR]: {
    category: "dependency",
    retryable: true,
    userMessage: "We could not reach the Stellar network.",
    recovery: "Check your connection and retry in a few moments.",
    exposeMessage: false
  },
  [ERROR_CODES.REVERTED_ON_CHAIN]: {
    category: "settlement",
    retryable: false,
    userMessage: "The transaction was reverted on-chain.",
    recovery: "Review the transaction details and create a new action if you still want to proceed.",
    exposeMessage: false
  },
  [ERROR_CODES.ORPHAN_TTL_EXPIRED]: {
    category: "settlement",
    retryable: false,
    userMessage: "The transaction was not confirmed before it expired.",
    recovery: "Check your wallet for the transaction, then start a new action if it did not go through.",
    exposeMessage: false
  },
  [ERROR_CODES.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD]: {
    category: "conflict",
    retryable: false,
    userMessage: "This request key was already used with different details.",
    recovery: "Generate a new Idempotency-Key for a different request.",
    exposeMessage: true
  },
  [ERROR_CODES.TX_HASH_ALREADY_ATTACHED]: {
    category: "conflict",
    retryable: false,
    userMessage: "A transaction is already attached to this action.",
    recovery: "Refresh the action to see its current status.",
    exposeMessage: true
  },
  [ERROR_CODES.ILLEGAL_TRANSITION]: {
    category: "conflict",
    retryable: false,
    userMessage: "This action cannot move to the requested state.",
    recovery: "Refresh the action to see its current status.",
    exposeMessage: true
  },
  [ERROR_CODES.NOT_FOUND]: {
    category: "not_found",
    retryable: false,
    userMessage: "We could not find what you were looking for.",
    recovery: "Check the identifier and try again.",
    exposeMessage: true
  },
  [ERROR_CODES.UNAUTHORIZED]: {
    category: "authorization",
    retryable: false,
    userMessage: "You need to sign in to do that.",
    recovery: "Connect your wallet and sign in again.",
    exposeMessage: true
  },
  [ERROR_CODES.FORBIDDEN]: {
    category: "authorization",
    retryable: false,
    userMessage: "You do not have permission to do that.",
    recovery: "Use an account with access, or contact support with your error ID.",
    exposeMessage: true
  },
  [ERROR_CODES.RATE_LIMIT_EXCEEDED]: {
    category: "rate_limit",
    retryable: true,
    userMessage: "Too many requests.",
    recovery: "Wait a moment (see the Retry-After header) and try again.",
    exposeMessage: true
  },
  // #815 — the message names the operation, limit and remediation, and
  // `details` carries retry_after_seconds / reset_at; nothing internal.
  [ERROR_CODES.OPERATION_LIMIT_EXCEEDED]: {
    category: "rate_limit",
    retryable: true,
    userMessage: "You have reached the limit for this operation.",
    recovery: "Wait until the limit resets (see the Retry-After header), or follow the remediation in the error details.",
    exposeMessage: true
  },
  [ERROR_CODES.INVALID_CURSOR]: {
    category: "validation",
    retryable: false,
    userMessage: "The pagination cursor is not valid.",
    recovery: "Restart from the first page.",
    exposeMessage: true
  },
  [ERROR_CODES.EXPIRED_CURSOR]: {
    category: "validation",
    retryable: false,
    userMessage: "The pagination cursor has expired.",
    recovery: "Restart from the first page.",
    exposeMessage: true
  },
  [ERROR_CODES.SETTLEMENT_SUBMIT_FAILED]: {
    category: "settlement",
    retryable: true,
    userMessage: "We could not submit the payout to the network.",
    recovery: "No action is needed; the payout will be retried automatically.",
    exposeMessage: false
  },
  [ERROR_CODES.SETTLEMENT_RETRIES_EXHAUSTED]: {
    category: "settlement",
    retryable: false,
    userMessage: "The payout could not be completed after several attempts.",
    recovery: "Contact support and quote your error ID so the payout can be reviewed.",
    exposeMessage: false
  },
  [ERROR_CODES.SETTLEMENT_ALREADY_RESOLVED]: {
    category: "settlement",
    retryable: false,
    userMessage: "This vault has already been settled.",
    recovery: "Refresh to see the final result.",
    exposeMessage: false
  },
  [ERROR_CODES.SETTLEMENT_IN_PROGRESS]: {
    category: "settlement",
    retryable: true,
    userMessage: "This vault is currently being settled.",
    recovery: "Wait a moment and refresh.",
    exposeMessage: false
  },
  [ERROR_CODES.SETTLEMENT_PAYOUT_UNVERIFIED]: {
    category: "settlement",
    retryable: false,
    userMessage: "The payout was sent but is still being verified.",
    recovery: "No action is needed. If it is still pending after an hour, contact support with your error ID.",
    exposeMessage: false
  },
  [ERROR_CODES.INTERNAL]: {
    category: "internal",
    retryable: true,
    userMessage: "Something went wrong on our side.",
    recovery: "Try again shortly. If it keeps happening, contact support with your error ID.",
    exposeMessage: false
  },
  [ERROR_CODES.DATABASE_ERROR]: {
    category: "dependency",
    retryable: true,
    userMessage: "We are having trouble saving your data.",
    recovery: "Try again shortly. If it keeps happening, contact support with your error ID.",
    exposeMessage: false
  },
  [ERROR_CODES.CONFLICT]: {
    category: "conflict",
    retryable: false,
    userMessage: "That conflicts with existing data.",
    recovery: "Refresh and review the existing record before retrying.",
    exposeMessage: true
  },
  [ERROR_CODES.HTTP_ERROR]: {
    category: "validation",
    retryable: false,
    userMessage: "The request could not be processed.",
    recovery: "Check the request syntax and parameters before retrying.",
    exposeMessage: true
  },
  // VaultQuest-specific rejection reasons
  [ERROR_CODES.VAULT_INVALID_AMOUNT]: {
    category: "validation",
    retryable: false,
    userMessage: "The amount provided is not valid.",
    recovery: "Enter a positive amount greater than zero and try again.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INVALID_POOL_ID]: {
    category: "validation",
    retryable: false,
    userMessage: "The pool identifier is not valid.",
    recovery: "Verify the pool ID and try again. If the issue persists, contact support.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INVALID_WALLET_ADDRESS]: {
    category: "validation",
    retryable: false,
    userMessage: "The wallet address is not valid.",
    recovery: "Ensure your wallet is connected and has a valid Stellar address.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INVALID_ASSET]: {
    category: "validation",
    retryable: false,
    userMessage: "The asset type is not supported by this pool.",
    recovery: "Check the pool's accepted assets and use a supported asset.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INVALID_TIMESTAMP]: {
    category: "validation",
    retryable: false,
    userMessage: "The timestamp provided is not valid.",
    recovery: "Ensure your device's clock is correct and try again.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_UNAUTHORIZED_OPERATION]: {
    category: "authorization",
    retryable: false,
    userMessage: "You are not authorized to perform this operation.",
    recovery: "Connect your wallet and sign in with the correct account.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_FORBIDDEN_OPERATION]: {
    category: "authorization",
    retryable: false,
    userMessage: "You do not have permission to perform this operation.",
    recovery: "Use an account with the required permissions, or contact support if you believe this is an error.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_WALLET_NOT_CONNECTED]: {
    category: "authorization",
    retryable: false,
    userMessage: "Your wallet is not connected.",
    recovery: "Connect your wallet to proceed with this operation.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_SIGNATURE_REQUIRED]: {
    category: "authorization",
    retryable: true,
    userMessage: "A signature is required to complete this operation.",
    recovery: "Approve the transaction in your wallet when prompted.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_POOL_CLOSED]: {
    category: "validation",
    retryable: false,
    userMessage: "This pool is closed and no longer accepts deposits.",
    recovery: "Choose a different pool that is currently open for deposits.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_POOL_LOCKED]: {
    category: "validation",
    retryable: false,
    userMessage: "This pool is locked for the current prize draw cycle.",
    recovery: "Deposits will be accepted again after the prize draw completes. Check the pool's lock time.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_POOL_CANCELLED]: {
    category: "validation",
    retryable: false,
    userMessage: "This pool has been cancelled.",
    recovery: "Withdraw your funds from this pool. Choose a different pool for future deposits.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_POOL_EMERGENCY]: {
    category: "validation",
    retryable: false,
    userMessage: "This pool is in emergency mode.",
    recovery: "Withdrawals and claims are still available, but deposits are paused. Contact support for details.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_DEPOSIT_CAP_EXCEEDED]: {
    category: "validation",
    retryable: false,
    userMessage: "This deposit would exceed your personal cap for this pool.",
    recovery: "Deposit a smaller amount, or choose a different pool with a higher cap.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_POOL_CAP_EXCEEDED]: {
    category: "validation",
    retryable: false,
    userMessage: "This pool has reached its total deposit capacity.",
    recovery: "Choose a different pool with available capacity, or wait for this pool to have space.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_LOCKUP_ACTIVE]: {
    category: "validation",
    retryable: false,
    userMessage: "Your funds are still in the lockup period.",
    recovery: "Wait until the lockup period ends before withdrawing. Check your position for the exact unlock time.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_CLAIM_DEADLINE_PASSED]: {
    category: "validation",
    retryable: false,
    userMessage: "The claim deadline for this prize has passed.",
    recovery: "This prize can no longer be claimed. Contact support if you believe this is an error.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INSUFFICIENT_LIQUIDITY]: {
    category: "validation",
    retryable: false,
    userMessage: "The pool does not have enough available liquidity for this withdrawal.",
    recovery: "Your withdrawal request has been queued and will be processed when liquidity becomes available.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INSUFFICIENT_BALANCE]: {
    category: "validation",
    retryable: false,
    userMessage: "You do not have enough balance to perform this operation.",
    recovery: "Check your balance and ensure you have sufficient funds before trying again.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_ALREADY_CLAIMED]: {
    category: "validation",
    retryable: false,
    userMessage: "This prize has already been claimed.",
    recovery: "Check your reward history to see your claimed prizes.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_NOT_PARTICIPANT]: {
    category: "validation",
    retryable: false,
    userMessage: "You are not a participant in this pool.",
    recovery: "Join the pool by making a deposit before attempting this operation.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INSUFFICIENT_YIELD_RESERVE]: {
    category: "validation",
    retryable: false,
    userMessage: "The pool does not have enough yield reserve for this operation.",
    recovery: "This operation cannot be completed at this time. Contact support for details.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_INVALID_ACTION_STATE]: {
    category: "validation",
    retryable: false,
    userMessage: "This action is not allowed in the current pool state.",
    recovery: "Refresh the pool status and try again. If the issue persists, contact support.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_STALE_POOL_DATA]: {
    category: "dependency",
    retryable: true,
    userMessage: "The pool data is out of date.",
    recovery: "Refresh the page and try again.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_STALE_POSITION_DATA]: {
    category: "dependency",
    retryable: true,
    userMessage: "Your position data is out of date.",
    recovery: "Refresh the page and try again.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_CONCURRENT_MODIFICATION]: {
    category: "dependency",
    retryable: true,
    userMessage: "This item was modified by another operation.",
    recovery: "Refresh the page and try again.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_VERSION_MISMATCH]: {
    category: "dependency",
    retryable: true,
    userMessage: "There is a version mismatch between your client and the pool.",
    recovery: "Refresh the page to get the latest version.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_WALLET_REJECTED]: {
    category: "wallet",
    retryable: true,
    userMessage: "The wallet rejected the transaction.",
    recovery: "Approve the transaction in your wallet, or start again if you meant to cancel.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_WALLET_TIMEOUT]: {
    category: "wallet",
    retryable: true,
    userMessage: "The wallet did not respond in time.",
    recovery: "Open your wallet, check for a pending prompt, then try again.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_NETWORK_ERROR]: {
    category: "dependency",
    retryable: true,
    userMessage: "We could not reach the Stellar network.",
    recovery: "Check your internet connection and retry in a few moments.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_RPC_FAILURE]: {
    category: "dependency",
    retryable: true,
    userMessage: "The Stellar RPC service returned an error.",
    recovery: "Retry the operation. If it keeps failing, contact support with your error ID.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_CONTRACT_REVERTED]: {
    category: "settlement",
    retryable: false,
    userMessage: "The transaction was reverted on-chain.",
    recovery: "Review the transaction details and create a new action if you still want to proceed.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_TRANSACTION_TIMEOUT]: {
    category: "settlement",
    retryable: true,
    userMessage: "The transaction timed out waiting for confirmation.",
    recovery: "Check your wallet for the transaction, then start a new action if it did not go through.",
    exposeMessage: false
  },
  [ERROR_CODES.VAULT_INDEXER_UNAVAILABLE]: {
    category: "dependency",
    retryable: true,
    userMessage: "The pool indexer service is temporarily unavailable.",
    recovery: "Retry the operation in a few moments. If it keeps failing, contact support.",
    exposeMessage: false
  },
  // #799 — Webhook verification and replay window descriptors
  [ERROR_CODES.WEBHOOK_SIGNATURE_INVALID]: {
    category: "authorization",
    retryable: false,
    userMessage: "The webhook signature is invalid or could not be verified.",
    recovery: "Verify the webhook signing secret and signature generation algorithm.",
    exposeMessage: true
  },
  [ERROR_CODES.WEBHOOK_SIGNATURE_MISSING]: {
    category: "authorization",
    retryable: false,
    userMessage: "The webhook signature header is missing.",
    recovery: "Include the required signature header in your webhook request.",
    exposeMessage: true
  },
  [ERROR_CODES.WEBHOOK_TIMESTAMP_STALE]: {
    category: "validation",
    retryable: false,
    userMessage: "The webhook event timestamp is outside the allowed replay window.",
    recovery: "Ensure webhook events are sent within the allowed time window and system clocks are synchronized.",
    exposeMessage: true
  },
  [ERROR_CODES.WEBHOOK_TIMESTAMP_MISSING]: {
    category: "validation",
    retryable: false,
    userMessage: "The webhook timestamp header or field is missing.",
    recovery: "Include a valid timestamp header or payload timestamp.",
    exposeMessage: true
  },
  [ERROR_CODES.WEBHOOK_DUPLICATE_EVENT]: {
    category: "conflict",
    retryable: false,
    userMessage: "This webhook event has already been processed.",
    recovery: "Duplicate delivery acknowledged; no repeated side effects will be performed.",
    exposeMessage: true
  },
  [ERROR_CODES.WEBHOOK_EVENT_MALFORMED]: {
    category: "validation",
    retryable: false,
    userMessage: "The webhook payload is malformed or does not match the expected schema.",
    recovery: "Verify the webhook payload matches the required event schema.",
    exposeMessage: true
  },
  [ERROR_CODES.WEBHOOK_PROVIDER_UNSUPPORTED]: {
    category: "validation",
    retryable: false,
    userMessage: "The requested webhook provider is not supported.",
    recovery: "Use a supported webhook provider (e.g. stripe, internal, stellar, custom).",
    exposeMessage: true
  },
  [ERROR_CODES.QUEUE_BACKPRESSURE]: {
    category: "rate_limit",
    retryable: true,
    userMessage: "The background job queue is currently under heavy load.",
    recovery: "Wait a moment (see the Retry-After header) before submitting further background jobs.",
    exposeMessage: true
  },
  [ERROR_CODES.INVARIANT_VIOLATION]: {
    category: "conflict",
    retryable: false,
    userMessage: "A state transition invariant was violated.",
    recovery: "Refresh the current state and verify account and pool status before retrying.",
    exposeMessage: true
  },
  [ERROR_CODES.BALANCE_INVARIANT_VIOLATION]: {
    category: "conflict",
    retryable: false,
    userMessage: "A balance conservation or non-negative invariant was violated.",
    recovery: "Ensure sufficient funds and that the operation preserves balance conservation.",
    exposeMessage: true
  },
  [ERROR_CODES.OWNERSHIP_INVARIANT_VIOLATION]: {
    category: "authorization",
    retryable: false,
    userMessage: "An ownership transition invariant was violated.",
    recovery: "Verify that only the current authorized owner can transfer ownership.",
    exposeMessage: true
  },
  [ERROR_CODES.ENTITLEMENT_INVARIANT_VIOLATION]: {
    category: "conflict",
    retryable: false,
    userMessage: "An entitlement or claim invariant was violated.",
    recovery: "Verify eligibility and ensure the reward or prize has not already been claimed.",
    exposeMessage: true
  },
  [ERROR_CODES.SERVICE_DEGRADED]: {
    category: "dependency",
    retryable: true,
    userMessage: "The service is temporarily operating in degraded mode due to unavailable dependencies.",
    recovery: "Read operations are serving cached data. Mutations will resume once upstream dependencies recover.",
    exposeMessage: true
  },
  [ERROR_CODES.DEPENDENCY_UNAVAILABLE]: {
    category: "dependency",
    retryable: true,
    userMessage: "An upstream dependency is temporarily unavailable.",
    recovery: "Try again in a few moments or wait for the system to recover.",
    exposeMessage: true
  },
  // Problem Details Taxonomy descriptors (#946)
  // Vault deposits
  [ERROR_CODES.VAULT_DEPOSIT_BELOW_MIN]: {
    category: "validation",
    retryable: false,
    userMessage: "The deposit amount is below the vault's minimum deposit requirement.",
    recovery: "Increase the deposit amount to at least the vault's minimum threshold and submit again.",
    exposeMessage: true
  },
  [ERROR_CODES.VAULT_DEPOSIT_REVERTED]: {
    category: "settlement",
    retryable: false,
    userMessage: "The deposit transaction reverted on the Stellar network.",
    recovery: "Check your account balance and trustlines, then initiate a new deposit.",
    exposeMessage: true
  },
  // Prize rounds
  [ERROR_CODES.ROUND_NOT_OPEN]: {
    category: "conflict",
    retryable: false,
    userMessage: "The prize round is not currently open for deposits.",
    recovery: "Wait until the next prize round opens before depositing.",
    exposeMessage: true
  },
  [ERROR_CODES.ROUND_LOCKED]: {
    category: "conflict",
    retryable: false,
    userMessage: "The prize round is locked and preparing for the draw.",
    recovery: "Deposits are frozen for this round. Your deposit will be credited to the upcoming round.",
    exposeMessage: true
  },
  [ERROR_CODES.ROUND_RANDOMNESS_PENDING]: {
    category: "settlement",
    retryable: true,
    userMessage: "The prize draw is awaiting verifiable randomness entropy.",
    recovery: "Randomness is being generated or revealed. Check back shortly.",
    exposeMessage: true
  },
  [ERROR_CODES.ROUND_ALREADY_DRAWN]: {
    category: "conflict",
    retryable: false,
    userMessage: "The winner for this prize round has already been drawn.",
    recovery: "Inspect the round results or participate in the next round.",
    exposeMessage: true
  },
  [ERROR_CODES.ROUND_REVEAL_TIMEOUT]: {
    category: "settlement",
    retryable: true,
    userMessage: "The randomness reveal window timed out for this round.",
    recovery: "The permissionless fallback entropy path can now be triggered to finalize the round.",
    exposeMessage: true
  },
  [ERROR_CODES.DRAW_PROOF_INVALID]: {
    category: "settlement",
    retryable: false,
    userMessage: "The cryptographic draw proof failed verification against on-chain evidence.",
    recovery: "Verify your contract ID and round snapshot or re-run the standalone draw verifier.",
    exposeMessage: false
  },
  // Quests
  [ERROR_CODES.QUEST_NOT_FOUND]: {
    category: "not_found",
    retryable: false,
    userMessage: "The specified quest or community challenge could not be found.",
    recovery: "Check the quest ID or browse active challenges on the quests page.",
    exposeMessage: true
  },
  [ERROR_CODES.QUEST_NOT_JOINABLE]: {
    category: "conflict",
    retryable: false,
    userMessage: "This quest is not currently joinable.",
    recovery: "Verify that the challenge is active, funded, and open to participants.",
    exposeMessage: true
  },
  [ERROR_CODES.QUEST_UNFUNDED]: {
    category: "conflict",
    retryable: false,
    userMessage: "The quest reward escrow has not been funded.",
    recovery: "The quest creator must fund the reward escrow before participants can join.",
    exposeMessage: true
  },
  [ERROR_CODES.QUEST_ALREADY_COMPLETED]: {
    category: "conflict",
    retryable: false,
    userMessage: "You have already completed this quest and earned its reward.",
    recovery: "Explore other available quests in the catalog.",
    exposeMessage: true
  },
  [ERROR_CODES.QUEST_PROGRESS_INVALID]: {
    category: "validation",
    retryable: false,
    userMessage: "The quest progress update is invalid or non-monotonic.",
    recovery: "Ensure quest progress moves monotonically forward.",
    exposeMessage: true
  },
  // Wallet flows
  [ERROR_CODES.WALLET_UNSUPPORTED_NETWORK]: {
    category: "wallet",
    retryable: true,
    userMessage: "Your connected wallet is on an unsupported Stellar network.",
    recovery: "Switch your wallet network to match the application (Stellar Testnet or Mainnet).",
    exposeMessage: true
  },
  [ERROR_CODES.WALLET_INSUFFICIENT_FUNDS]: {
    category: "wallet",
    retryable: false,
    userMessage: "Your wallet does not have enough funds to complete this transaction.",
    recovery: "Fund your Stellar account with sufficient XLM to cover the minimum reserve and fee.",
    exposeMessage: true
  },
  [ERROR_CODES.WALLET_SESSION_EXPIRED]: {
    category: "authorization",
    retryable: true,
    userMessage: "Your authenticated wallet session has expired.",
    recovery: "Re-authenticate by signing a fresh challenge in your wallet.",
    exposeMessage: true
  },
  [ERROR_CODES.WALLET_SIGNATURE_INVALID]: {
    category: "authorization",
    retryable: false,
    userMessage: "The cryptographic signature could not be verified.",
    recovery: "Sign the transaction or challenge payload with your active Stellar keypair.",
    exposeMessage: true
  },
  // Indexer reconciliation
  [ERROR_CODES.INDEXER_CURSOR_STALE]: {
    category: "dependency",
    retryable: true,
    userMessage: "The event indexer cursor has fallen behind the canonical ledger.",
    recovery: "The indexer is catching up with recent blocks. Retry in a few moments.",
    exposeMessage: true
  },
  [ERROR_CODES.INDEXER_REORG_DETECTED]: {
    category: "settlement",
    retryable: true,
    userMessage: "A ledger reorganization or chain fork was detected during event ingestion.",
    recovery: "Transactions in the affected ledgers are undergoing automated replay reconciliation.",
    exposeMessage: true
  },
  [ERROR_CODES.RECONCILIATION_MISMATCH]: {
    category: "conflict",
    retryable: false,
    userMessage: "A discrepancy was detected between internal intent records and on-chain state.",
    recovery: "A repair proposal has been quarantined for operator dual-control review.",
    exposeMessage: true
  },
  [ERROR_CODES.EVENT_QUARANTINED]: {
    category: "settlement",
    retryable: false,
    userMessage: "The on-chain event was quarantined due to state contradiction or data integrity risk.",
    recovery: "The event is held in quarantine awaiting maintainer inspection.",
    exposeMessage: false
  },
  [ERROR_CODES.POISON_EVENT_DETECTED]: {
    category: "dependency",
    retryable: false,
    userMessage: "A malformed or corrupt contract event was quarantined to prevent indexer stalling.",
    recovery: "Review the poison event record in the maintainer dashboard.",
    exposeMessage: false
  },
  // Capability tokens (#984)
  [ERROR_CODES.CAPABILITY_TOKEN_REQUIRED]: {
    category: "authorization",
    retryable: false,
    userMessage: "A valid expiring capability token is required for this sensitive action.",
    recovery: "Request a short-lived capability token before executing this sensitive operation.",
    exposeMessage: true
  },
  [ERROR_CODES.CAPABILITY_TOKEN_EXPIRED]: {
    category: "authorization",
    retryable: true,
    userMessage: "The capability token for this action has expired.",
    recovery: "Request a fresh capability token and retry the operation immediately.",
    exposeMessage: true
  },
  [ERROR_CODES.CAPABILITY_TOKEN_INVALID]: {
    category: "authorization",
    retryable: false,
    userMessage: "The capability token signature or payload is invalid.",
    recovery: "Ensure the token was not altered or tampered with and re-issue if necessary.",
    exposeMessage: true
  },
  [ERROR_CODES.CAPABILITY_TOKEN_CONSUMED]: {
    category: "conflict",
    retryable: false,
    userMessage: "The capability token has already been consumed (single-use).",
    recovery: "Capability tokens can only be used once. Request a new token for another action.",
    exposeMessage: true
  },
  [ERROR_CODES.CAPABILITY_TOKEN_SCOPE_MISMATCH]: {
    category: "authorization",
    retryable: false,
    userMessage: "The capability token does not grant permission for the requested action or target.",
    recovery: "Request a capability token scoped specifically for this action and target resource.",
    exposeMessage: true
  },
  [ERROR_CODES.CAPABILITY_TOKEN_ACTOR_MISMATCH]: {
    category: "authorization",
    retryable: false,
    userMessage: "The capability token was issued to a different actor.",
    recovery: "Use the capability token issued to your authenticated identity.",
    exposeMessage: true
  },
  [ERROR_CODES.CAPABILITY_TOKEN_REVOKED]: {
    category: "authorization",
    retryable: false,
    userMessage: "The capability token has been explicitly revoked.",
    recovery: "Request a new capability token from an authorized maintainer or administrator.",
    exposeMessage: true
  },
  [ERROR_CODES.URL_NOT_ALLOWED]: {
    category: "validation",
    retryable: false,
    userMessage: "The provided URL is not in the allowed destinations list or is unsafe.",
    recovery: "Provide an approved HTTPS URL from an allowlisted domain.",
    exposeMessage: true
  },
  [ERROR_CODES.FILE_TYPE_NOT_ALLOWED]: {
    category: "validation",
    retryable: false,
    userMessage: "The file type or extension is not allowed.",
    recovery: "Upload an allowlisted file type (e.g. .csv or .json) without dangerous extensions.",
    exposeMessage: true
  },
  [ERROR_CODES.DESTINATION_NOT_ALLOWED]: {
    category: "validation",
    retryable: false,
    userMessage: "The destination address or target is not allowed.",
    recovery: "Specify a valid destination address or allowlisted webhook target.",
    exposeMessage: true
  },
  [ERROR_CODES.OPERATION_CANCELLED]: {
    category: "conflict",
    retryable: false,
    userMessage: "The operation was cancelled by client request.",
    recovery: "Start a new operation if you wish to re-run the process.",
    exposeMessage: true
  },
  [ERROR_CODES.CANCELLATION_NOT_ALLOWED]: {
    category: "conflict",
    retryable: false,
    userMessage: "The operation cannot be cancelled in its current state.",
    recovery: "Wait for the operation to complete or inspect its final state.",
    exposeMessage: true
  },
  [ERROR_CODES.INVALID_SORT_KEY]: {
    category: "validation",
    retryable: false,
    userMessage: "The requested sort key or ordering specification is invalid.",
    recovery: "Use a supported sort key and direction.",
    exposeMessage: true
  },
  [ERROR_CODES.CURSOR_ORDER_MISMATCH]: {
    category: "validation",
    retryable: false,
    userMessage: "The pagination cursor does not match the requested sort order or key.",
    recovery: "Start pagination from the first page when changing sort order or filters.",
    exposeMessage: true
  },
  [ERROR_CODES.PROJECTION_REBUILD_BUSY]: {
    category: "conflict",
    retryable: true,
    userMessage: "The indexer is busy, so the projection rebuild could not start yet.",
    recovery: "Retry in a few seconds; the indexer lease frees up when the current tick or rebuild finishes.",
    exposeMessage: true
  }
};

const FALLBACK: ErrorDescriptor = ERROR_CATALOG[ERROR_CODES.INTERNAL];

export function isKnownErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code);
}

/** Descriptor for a code; unknown codes are treated as opaque internal errors. */
export function describeError(code: string): ErrorDescriptor {
  return isKnownErrorCode(code) ? ERROR_CATALOG[code] : FALLBACK;
}

export interface UserSafeError {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  message: string;
  recovery?: string;
}

/**
 * Builds the user-facing view of an error. `message` is only passed through
 * when the catalog marks that code as safe to expose and the status is not a
 * server error; otherwise the catalog message is used.
 */
export function toUserSafeError(code: string, statusCode: number, message?: string): UserSafeError {
  if (!isKnownErrorCode(code)) {
    // Framework-level 4xx errors (bad JSON, unsupported media type, ...) carry
    // an authored message; anything else is an opaque internal failure.
    if (statusCode < 500) {
      return {
        code,
        category: "validation",
        retryable: false,
        message: message || ERROR_CATALOG[ERROR_CODES.HTTP_ERROR].userMessage
      };
    }
    return toUserSafeError(ERROR_CODES.INTERNAL, statusCode);
  }
  const d = ERROR_CATALOG[code];
  const useCaller = d.exposeMessage && statusCode < 500 && !!message;
  return {
    code,
    category: d.category,
    retryable: d.retryable,
    message: useCaller ? (message as string) : d.userMessage,
    ...(d.recovery ? { recovery: d.recovery } : {})
  };
}
