/**
 * Contract interface consumed by VaultQuest frontend pool flows (#67).
 *
 * This is the seam between the UI and the Soroban contract layer. Components
 * and hooks depend only on {@link VaultContractClient}; production code wires a
 * real Stellar-backed implementation, while tests use the in-memory mock in
 * `./mockClient`. Keeping a single typed interface lets wallet flows
 * (create / join / drip / claim / withdraw) be tested without a live network.
 */

export type PoolStatus = "open" | "locked" | "drawing" | "settled";

export interface PoolSummary {
  id: string;
  name: string;
  status: PoolStatus;
  /** Total value locked, in display units (string to avoid bigint/JSON loss). */
  tvl: string;
  /** Deposit asset code, e.g. "USDC". */
  asset: string;
  participantCount: number;
  /** Expected yield blurb, e.g. "5.2% APY". */
  expectedYield: string;
  /** Prize pool for the current cycle, when applicable. */
  prize?: string;
  opensAt: string | null;
  locksAt: string | null;
  drawsAt: string | null;
  /** Canonical discoverable vault metadata from the factory/indexer. */
  riskTier?: string;
  strategy?: string;
  lockupDays?: number;
  feeBps?: number;
  acceptedAsset?: string;
  operationalStatus?: string;
  metadataVersion?: number;
  /**
   * Deposit concentration limits (#643), in the same display units as `tvl`.
   * "0" (or omitted) means uncapped, mirroring the contract's own
   * `max_wallet_deposit`/`max_pool_deposit` convention so the UI never needs
   * a separate "is this pool capped at all" flag.
   */
  maxWalletDeposit?: string;
  maxPoolDeposit?: string;
  /** Remaining protocol-wide headroom under `maxPoolDeposit`, precomputed by
   * the backend/indexer so the UI doesn't need to recompute `maxPoolDeposit -
   * tvl` itself (and risk drifting from whatever precision/rounding the
   * source of truth used). Omitted when `maxPoolDeposit` is unset. */
  remainingPoolCapacity?: string;
  /**
   * Mirrors the contract's `is_emergency` circuit breaker (#645). When true,
   * `join`/`drip` (deposit), `draw_winner`, and yield-crediting are blocked
   * on-chain — but `withdraw`, `withdraw_locked`, and `claim`/`claim_reward`
   * are deliberately left open so participants can always exit. Optional
   * because not every pool source (e.g. the factory/indexer summary) reads
   * this flag yet.
   */
  isEmergency?: boolean;
}

export interface SavedPoolEntry extends PoolSummary {
  walletAddress: string;
  /** Timestamp when the user saved the pool. */
  savedAt: string;
  /** Timestamp of the most recent save metadata update. */
  updatedAt: string;
}

export interface UserPosition {
  walletAddress: string;
  deposited: string;
  shares: string;
  joined: boolean;
}

export type RewardOutcome = "won" | "no_win" | "pending";

/**
 * Proof reconciliation status attached to a reward entry (#634).
 *
 * - `verified`   — draw proof exists and all integrity checks pass.
 * - `tampered`   — proof exists but one or more hash checks failed.
 * - `missing`    — no proof record found for this round/draw.
 * - `pending`    — proof not yet available (draw not finalised).
 * - `unverified` — proof present but optional fields (e.g. HMAC secret) were
 *                  not supplied, so full verification could not complete.
 */
export type ProofStatus = "verified" | "tampered" | "missing" | "pending" | "unverified";

export interface RewardHistoryEntry {
  id: string;
  poolId: string;
  poolName: string;
  /** ISO timestamp the pool cycle ended. */
  cycleEndedAt: string;
  rewardAmount: string;
  asset: string;
  status: RewardOutcome;
  /** Winning wallet, when the cycle has been drawn. */
  winnerAddress: string | null;
  /** On-chain reference for explorer links, when available. */
  txHash: string | null;
  /**
   * Round ID on-chain (links to draw proof). Added in #634.
   * Absent on legacy entries that pre-date proof recording.
   */
  roundId?: number;
  /**
   * Draw proof integrity status resolved at display time (#634).
   * Absent when the proof system is not enabled for this environment.
   */
  proofStatus?: ProofStatus;
  /**
   * Human-readable detail about the proof check (first failing field or
   * "verified" for a clean proof). Used for tooltip/ARIA descriptions.
   */
  proofDetail?: string;
  /**
   * Wallet claim status cross-checked against wallet/indexer data (#634).
   * - `claimed`   — txHash confirmed on-chain as successful
   * - `pending`   — txHash present but not yet confirmed
   * - `unclaimed` — won but no claim tx recorded
   * - `failed`    — claim tx found but reverted/failed
   */
  claimStatus?: "claimed" | "pending" | "unclaimed" | "failed";
}

export type PoolActionType = "create" | "join" | "drip" | "claim" | "withdraw";

export interface PoolActionInput {
  poolId: string;
  walletAddress: string;
  /** Amount in display units; required for create / join / drip / withdraw. */
  amount?: string;
}

export interface PoolActionResult {
  txHash: string;
  status: "submitted";
}

/** Failure modes the UI must recover from (mirrors real wallet/RPC errors). */
export type ContractErrorKind =
  | "wallet_disconnected"
  | "signature_rejected"
  | "rpc_failure"
  | "contract_error"
  | "stale_data"
  /**
   * Withdrawal attempted before the pool's lockup period has elapsed
   * (mirrors `Error::LockupActive` in contracts/drip-pool/src/lib.rs).
   * Distinct from a generic `contract_error` so the UI can tell the user
   * *why* the withdrawal was rejected and when they can retry, instead of
   * showing an undifferentiated "transaction reverted" message (#620).
   */
  | "lockup_active"
  /**
   * Withdrawal exceeds the pool's currently available (idle) liquidity —
   * the request must be queued rather than settled immediately (mirrors
   * `WithdrawalAlreadyQueued` / the withdrawal-queue flow in
   * contracts/drip-pool/src/lib.rs). Distinct from a generic
   * `contract_error` so the UI can explain the funds are queued rather
   * than rejected (#620).
   */
  | "insufficient_liquidity";

export class ContractInterfaceError extends Error {
  readonly kind: ContractErrorKind;

  constructor(kind: ContractErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "ContractInterfaceError";
    this.kind = kind;
  }
}

export interface VaultContractClient {
  /** Whether a wallet is currently connected. */
  isWalletConnected(): boolean;
  /** Connected wallet address, or null when disconnected. */
  getConnectedAddress(): string | null;

  // Reads
  getPool(poolId: string): Promise<PoolSummary>;
  /** Optional discovery read used when backend pool reads are disabled/unavailable. */
  listPools?(): Promise<PoolSummary[]>;
  getUserPosition(poolId: string, walletAddress?: string): Promise<UserPosition | null>;
  listRewardHistory(walletAddress: string): Promise<RewardHistoryEntry[]>;

  // Writes (wallet-signed)
  submitAction(type: PoolActionType, input: PoolActionInput): Promise<PoolActionResult>;
}
