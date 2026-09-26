/**
 * In-memory mock of {@link VaultContractClient} for frontend tests (#67).
 *
 * Lets wallet-driven flows (create / join / drip / claim / withdraw) and their
 * read paths run with no live Stellar network. Behaviour is fully configurable,
 * including injected failures for the error states the UI must handle:
 * disconnected wallet, rejected signature, RPC failure, contract error, and
 * stale data.
 *
 * See `../README.md` for how to add new mock cases.
 */

import {
  ContractInterfaceError,
  type ContractErrorKind,
  type PoolActionInput,
  type PoolActionResult,
  type PoolActionType,
  type PoolSummary,
  type RewardHistoryEntry,
  type UserPosition,
  type VaultContractClient,
} from "./types";
import {
  validateDepositAmount,
  validateWithdrawLockup,
  type ContractBehaviorError,
} from "../../../../lib/conformance-spec";

export interface MockVaultConfig {
  /** Whether a wallet is connected. Defaults to true. */
  connected?: boolean;
  /** Connected address. Defaults to a sample testnet address. */
  address?: string;
  /** Pools keyed by id. */
  pools?: Record<string, PoolSummary>;
  /** User positions keyed by pool id. */
  positions?: Record<string, UserPosition | null>;
  /** Reward history rows returned by `listRewardHistory`. */
  rewardHistory?: RewardHistoryEntry[];
  /** Force every read to throw with this error kind. */
  failReads?: Exclude<ContractErrorKind, "wallet_disconnected" | "signature_rejected">;
  /** Force specific actions to throw with the given error kind. */
  failActions?: Partial<Record<PoolActionType, ContractErrorKind>>;
  /** Lockup windows keyed by pool id (ledger seq the principal unlocks). */
  lockupWindows?: Record<string, number>;
  /** Current ledger sequence used for lockup checks. Defaults to a large value. */
  currentLedger?: number;
  /** Deterministic tx hash generator (defaults to a counter). */
  txHashFactory?: (type: PoolActionType, input: PoolActionInput) => string;
}

export const SAMPLE_ADDRESS = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export function createMockVaultClient(config: MockVaultConfig = {}): VaultContractClient {
  const connected = config.connected ?? true;
  const address = config.address ?? SAMPLE_ADDRESS;
  const pools = config.pools ?? {};
  const positions = config.positions ?? {};
  const rewardHistory = config.rewardHistory ?? [];
  const lockupWindows = config.lockupWindows ?? {};
  const currentLedger = config.currentLedger ?? Number.MAX_SAFE_INTEGER;
  let counter = 0;

  const nextTxHash = (type: PoolActionType, input: PoolActionInput): string =>
    config.txHashFactory?.(type, input) ?? `mocktx_${type}_${(counter += 1)}`;

  const requireConnected = (): void => {
    if (!connected) {
      throw new ContractInterfaceError(
        "wallet_disconnected",
        "Connect a wallet to continue.",
      );
    }
  };

  const maybeFailRead = (): void => {
    if (config.failReads) {
      throw new ContractInterfaceError(config.failReads, `read failed: ${config.failReads}`);
    }
  };

  /**
   * Maps a canonical contract behavior error to the wallet error seam. The
   * real contract surfaces these as `pool` host errors (revert codes), which
   * the wallet layer reports as `contract_error`; the name is preserved so
   * callers can recover exactly like they would on-chain.
   */
  const contractReject = (error: ContractBehaviorError): never => {
    throw new ContractInterfaceError("contract_error", error);
  };

  const parseAmount = (input: PoolActionInput): number => {
    const parsed = Number(input.amount);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const validatePrincipalAction = (type: PoolActionType, input: PoolActionInput): void => {
    const err = validateDepositAmount(parseAmount(input));
    if (err) contractReject(err);
    if (type === "withdraw") {
      const lockedUntil = lockupWindows[input.poolId];
      if (lockedUntil != null) {
        const lockupErr = validateWithdrawLockup(lockedUntil, currentLedger);
        if (lockupErr) contractReject(lockupErr);
      }
    }
  };

  return {
    isWalletConnected: () => connected,
    getConnectedAddress: () => (connected ? address : null),

    async getPool(poolId) {
      maybeFailRead();
      const pool = pools[poolId];
      if (!pool) {
        throw new ContractInterfaceError("contract_error", `pool ${poolId} not found`);
      }
      return pool;
    },

    async listPools() {
      maybeFailRead();
      return Object.values(pools);
    },

    async getUserPosition(poolId) {
      maybeFailRead();
      return positions[poolId] ?? null;
    },

    async listRewardHistory() {
      maybeFailRead();
      return rewardHistory;
    },

    async submitAction(type: PoolActionType, input: PoolActionInput): Promise<PoolActionResult> {
      requireConnected();
      const failure = config.failActions?.[type];
      if (failure) {
        throw new ContractInterfaceError(failure, `${type} failed: ${failure}`);
      }

      // Contract-edge-case conformance (#651). Deposit/withdraw require a
      // positive amount; a claim with nothing to pull returns a successful
      // no-op exactly as the contract's `claim_reward` does with `Ok(0)`.
      if (type === "drip" || type === "withdraw") {
        validatePrincipalAction(type, input);
      } else if (type === "create" || type === "join") {
        if (input.amount != null && input.amount !== "") {
          validatePrincipalAction(type, input);
        }
      }

      return { txHash: nextTxHash(type, input), status: "submitted" };
    },
  };
}
