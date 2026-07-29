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
  | "stale_data";

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
