/**
 * Shared data-access hooks for VaultQuest frontend surfaces.
 *
 * This file is the UI-facing boundary for backend REST reads, contract read
 * fallbacks, transaction-status polling, cache invalidation, and normalized view
 * models. Components should consume these hooks/adapters instead of calling
 * `fetch` or raw Soroban bindings directly.
 */

import { useCallback, useMemo, useState } from "react";
import type {
  PoolActionInput,
  PoolActionType,
  PoolSummary,
  RewardHistoryEntry,
  SavedPoolEntry,
  UserPosition,
  VaultContractClient,
} from "./contract/types";
import { VaultApiClient, isTerminalTransaction, type TransactionStatusView } from "./data/apiClient";
import { defaultVaultDataConfig } from "./data/config";
import { useVaultQuery, vaultQueryClient, type QueryState } from "./data/queryClient";
import { vaultQueryKeys } from "./data/queryKeys";
import { useTxFlow, type TxFlowOptions, type TxFlowResult } from "./lib/txStateMachine";

export interface AsyncResource<T> {
  data: T | null;
  loading: boolean;
  /** True while cached data is expired, invalidated, or being background-refetched. */
  stale: boolean;
  /** Fatal error when no usable cached data is available. */
  error: Error | null;
  /** Non-fatal background refresh error while prior data remains available. */
  partialError?: Error | null;
  refetch: () => void;
}

function resourceFromQuery<T>(query: QueryState<T>): AsyncResource<T> {
  return {
    data: query.data,
    loading: query.loading,
    stale: query.stale,
    error: query.error,
    partialError: query.partialError,
    refetch: query.refetch,
  };
}

function createApiClient(baseUrl?: string): VaultApiClient {
  return new VaultApiClient(baseUrl ?? defaultVaultDataConfig.apiBaseUrl);
}

export interface PoolDetailResource {
  pool: PoolSummary | null;
  position: UserPosition | null;
  loading: boolean;
  stale: boolean;
  error: Error | null;
  partialError?: Error | null;
  refetch: () => void;
}

export function usePoolDetail(
  client: VaultContractClient,
  poolId: string,
  walletAddress?: string | null,
): PoolDetailResource {
  const query = useVaultQuery({
    key: vaultQueryKeys.poolDetail(poolId, walletAddress),
    staleTimeMs: 20_000,
    fetcher: async () => {
      const [pool, position] = await Promise.all([
        client.getPool(poolId),
        walletAddress ? client.getUserPosition(poolId, walletAddress) : Promise.resolve(null),
      ]);
      return { pool, position };
    },
  });

  return {
    pool: query.data?.pool ?? null,
    position: query.data?.position ?? null,
    loading: query.loading,
    stale: query.stale,
    error: query.error,
    partialError: query.partialError,
    refetch: query.refetch,
  };
}

export function useRewardHistory(
  client: VaultContractClient,
  walletAddress: string | null,
): AsyncResource<RewardHistoryEntry[]> {
  const query = useVaultQuery({
    key: vaultQueryKeys.rewards(walletAddress),
    enabled: Boolean(walletAddress),
    staleTimeMs: 60_000,
    fetcher: async () => (walletAddress ? client.listRewardHistory(walletAddress) : []),
  });

  if (!walletAddress) {
    return { data: [], loading: false, stale: false, error: null, partialError: null, refetch: query.refetch };
  }

  return resourceFromQuery(query);
}

export interface PoolDiscoveryOptions {
  apiBaseUrl?: string;
  /** Disable backend reads for tests or intentional direct-contract surfaces. */
  backendReads?: boolean;
  /** Allow contract reads if the backend endpoint is unavailable or disabled. */
  contractFallbackReads?: boolean;
}

export function usePoolDiscovery(
  client: VaultContractClient,
  options: PoolDiscoveryOptions = {},
): AsyncResource<PoolSummary[]> {
  const api = useMemo(() => createApiClient(options.apiBaseUrl), [options.apiBaseUrl]);
  const backendReads = options.backendReads ?? defaultVaultDataConfig.featureFlags.backendReads;
  const contractFallbackReads = options.contractFallbackReads ?? defaultVaultDataConfig.featureFlags.contractFallbackReads;

  const query = useVaultQuery({
    key: vaultQueryKeys.pools(backendReads ? "backend-first" : "contract-only"),
    staleTimeMs: 30_000,
    fetcher: async (opts) => {
      if (backendReads) {
        try {
          return await api.listPools({ signal: opts.signal });
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          if (!contractFallbackReads || !client.listPools) throw err;
        }
      }
      if (!client.listPools) {
        throw new Error("Pool discovery is unavailable: no backend response and no contract fallback adapter.");
      }
      return client.listPools();
    },
  });

  return resourceFromQuery(query);
}

export interface PrizeViewsOptions extends PoolDiscoveryOptions {
  walletAddress?: string | null;
}

export function usePrizeViews(
  client: VaultContractClient,
  options: PrizeViewsOptions = {},
): AsyncResource<RewardHistoryEntry[]> {
  const api = useMemo(() => createApiClient(options.apiBaseUrl), [options.apiBaseUrl]);
  const backendReads = options.backendReads ?? defaultVaultDataConfig.featureFlags.backendReads;
  const contractFallbackReads = options.contractFallbackReads ?? defaultVaultDataConfig.featureFlags.contractFallbackReads;

  const query = useVaultQuery({
    key: vaultQueryKeys.prizes(options.walletAddress),
    staleTimeMs: 60_000,
    fetcher: async (opts) => {
      if (backendReads) {
        try {
          return await api.listPrizeViews(options.walletAddress, { signal: opts.signal });
        } catch (err) {
          if (opts.signal?.aborted) throw err;
          if (!contractFallbackReads) throw err;
        }
      }
      return options.walletAddress ? client.listRewardHistory(options.walletAddress) : [];
    },
  });

  return resourceFromQuery(query);
}

export interface AccountView {
  walletAddress: string;
  savedPools: SavedPoolEntry[];
  rewards: RewardHistoryEntry[];
  positions: UserPosition[];
}

export interface AccountViewOptions {
  apiBaseUrl?: string;
  poolIds?: string[];
}

export function useAccountView(
  client: VaultContractClient,
  walletAddress: string | null,
  options: AccountViewOptions = {},
): AsyncResource<AccountView> {
  const api = useMemo(() => createApiClient(options.apiBaseUrl), [options.apiBaseUrl]);
  const poolIds = useMemo(() => options.poolIds ?? [], [options.poolIds]);

  const query = useVaultQuery({
    key: vaultQueryKeys.account(walletAddress),
    enabled: Boolean(walletAddress),
    staleTimeMs: 30_000,
    fetcher: async (opts) => {
      if (!walletAddress) throw new Error("Connect a wallet to load account data.");
      const [savedPools, rewards, positions] = await Promise.all([
        api.listSavedPools(walletAddress, { signal: opts.signal }),
        client.listRewardHistory(walletAddress),
        Promise.all(poolIds.map((poolId) => client.getUserPosition(poolId, walletAddress))),
      ]);

      return {
        walletAddress,
        savedPools,
        rewards,
        positions: positions.filter((position): position is UserPosition => Boolean(position)),
      };
    },
  });

  if (!walletAddress) {
    return { data: null, loading: false, stale: false, error: null, partialError: null, refetch: query.refetch };
  }

  return resourceFromQuery(query);
}

export interface SavedPoolsResource extends AsyncResource<SavedPoolEntry[]> {
  savePool: (pool: PoolSummary) => Promise<SavedPoolEntry>;
  unsavePool: (poolId: string) => Promise<number>;
}

export function useSavedPools(
  walletAddress: string | null,
  baseUrl = defaultVaultDataConfig.apiBaseUrl,
): SavedPoolsResource {
  const api = useMemo(() => createApiClient(baseUrl), [baseUrl]);
  const query = useVaultQuery({
    key: vaultQueryKeys.savedPools(walletAddress),
    enabled: Boolean(walletAddress),
    staleTimeMs: 30_000,
    fetcher: async (opts) => (walletAddress ? api.listSavedPools(walletAddress, { signal: opts.signal }) : []),
  });

  const invalidateSavedPools = useCallback(() => {
    vaultQueryClient.invalidateQueries(vaultQueryKeys.savedPools(walletAddress));
    vaultQueryClient.invalidateQueries(vaultQueryKeys.account(walletAddress));
  }, [walletAddress]);

  const savePool = useCallback(
    async (pool: PoolSummary) => {
      if (!walletAddress) throw new Error("Connect a wallet to save pools.");
      const saved = await api.savePool(walletAddress, pool);
      invalidateSavedPools();
      query.refetch();
      return saved;
    },
    [api, invalidateSavedPools, query, walletAddress],
  );

  const unsavePool = useCallback(
    async (poolId: string) => {
      if (!walletAddress) throw new Error("Connect a wallet to remove saved pools.");
      const deleted = await api.unsavePool(walletAddress, poolId);
      invalidateSavedPools();
      query.refetch();
      return deleted;
    },
    [api, invalidateSavedPools, query, walletAddress],
  );

  if (!walletAddress) {
    return {
      data: [],
      loading: false,
      stale: false,
      error: null,
      partialError: null,
      refetch: query.refetch,
      savePool,
      unsavePool,
    };
  }

  return { ...resourceFromQuery(query), savePool, unsavePool };
}

export interface TransactionStatusResource extends AsyncResource<TransactionStatusView> {
  polling: boolean;
}

export function useTransactionStatus(
  actionId: string | null,
  options: { apiBaseUrl?: string; pollMs?: number } = {},
): TransactionStatusResource {
  const api = useMemo(() => createApiClient(options.apiBaseUrl), [options.apiBaseUrl]);
  const cached = actionId ? vaultQueryClient.getQueryData<TransactionStatusView>(vaultQueryKeys.transaction(actionId)) : null;
  const polling = Boolean(
    actionId &&
      defaultVaultDataConfig.featureFlags.transactionPolling &&
      cached &&
      !isTerminalTransaction(cached.status),
  );

  const query = useVaultQuery({
    key: vaultQueryKeys.transaction(actionId ?? "none"),
    enabled: Boolean(actionId),
    staleTimeMs: polling ? 0 : 15_000,
    refetchIntervalMs: polling ? (options.pollMs ?? 5_000) : undefined,
    fetcher: async (opts) => {
      if (!actionId) throw new Error("Transaction id is required.");
      const status = await api.getTransactionStatus(actionId, { signal: opts.signal });
      if (isTerminalTransaction(status.status)) {
        if (status.poolId) {
          vaultQueryClient.invalidateQueries(vaultQueryKeys.pool(status.poolId));
          vaultQueryClient.invalidateQueries(vaultQueryKeys.poolDetail(status.poolId, status.walletAddress));
        }
        vaultQueryClient.invalidateQueries(vaultQueryKeys.account(status.walletAddress));
        vaultQueryClient.invalidateQueries(vaultQueryKeys.rewards(status.walletAddress));
        vaultQueryClient.invalidateQueries(vaultQueryKeys.savedPools(status.walletAddress));
        vaultQueryClient.invalidateQueries(vaultQueryKeys.poolLists());
      }
      return status;
    },
  });

  if (!actionId) {
    return { data: null, loading: false, stale: false, error: null, partialError: null, refetch: query.refetch, polling: false };
  }

  return { ...resourceFromQuery(query), polling };
}

export interface PoolActionFlow extends TxFlowResult {
  /** Convenience wrapper — no need to pass `client` on each call. */
  submit: (type: PoolActionType, input: PoolActionInput, options?: TxFlowOptions) => Promise<void>;
}

export function invalidatePoolActionQueries(type: PoolActionType, input: PoolActionInput): void {
  vaultQueryClient.invalidateQueries(vaultQueryKeys.actionFlow(type, input.poolId, input.walletAddress));
  vaultQueryClient.invalidateQueries(vaultQueryKeys.pool(input.poolId));
  vaultQueryClient.invalidateQueries(vaultQueryKeys.poolDetail(input.poolId, input.walletAddress));
  vaultQueryClient.invalidateQueries(vaultQueryKeys.account(input.walletAddress));
  vaultQueryClient.invalidateQueries(vaultQueryKeys.rewards(input.walletAddress));
  if (["create", "join", "withdraw"].includes(type)) {
    vaultQueryClient.invalidateQueries(vaultQueryKeys.poolLists());
  }
}

export function usePoolAction(client: VaultContractClient): PoolActionFlow {
  const flow = useTxFlow();
  const submit = useCallback(
    async (type: PoolActionType, input: PoolActionInput, options?: TxFlowOptions) => {
      invalidatePoolActionQueries(type, input);
      await flow.run(client, type, input, options);
      invalidatePoolActionQueries(type, input);
    },
    [client, flow],
  );
  return { ...flow, submit };
}

export type ExportFormat = "json" | "csv";

export interface ActivityExportOptions {
  wallet: string;
  format: ExportFormat;
  from?: string;
  to?: string;
  /** Base URL of the backend API. Defaults to the centralized data config. */
  baseUrl?: string;
}

export type ExportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; filename: string }
  | { status: "error"; message: string };

export interface ActivityExportResult {
  state: ExportState;
  trigger: (options: ActivityExportOptions) => Promise<void>;
  reset: () => void;
}

export function useActivityExport(): ActivityExportResult {
  const [state, setState] = useState<ExportState>({ status: "idle" });

  const reset = useCallback(() => setState({ status: "idle" }), []);

  const trigger = useCallback(async (options: ActivityExportOptions) => {
    const { wallet, format, from, to, baseUrl } = options;
    setState({ status: "loading" });

    try {
      const api = createApiClient(baseUrl);
      const blob = await api.exportActivity({ wallet, format, from, to });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const filename = `vaultquest-activity-${wallet.slice(0, 8)}.${format}`;
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setState({ status: "success", filename });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return { state, trigger, reset };
}

// --- Issue #390: Persistent transaction state across reloads ---

export interface PersistedTxState {
  network: string;
  walletAddress: string;
  contract: string;
  action: string;
  idempotencyKey: string;
  stage: TimelineStage;
  txHash?: string;
  failedAtStage?: "preparing" | "awaiting-signature" | "submitting" | "confirming" | "indexing";
  errorMessage?: string;
}

const TX_STATE_STORAGE_KEY = "vaultquest_pending_tx_state";

export function usePersistedTxState(): {
  state: PersistedTxState | null;
  save: (state: PersistedTxState) => void;
  clear: () => void;
  canResume: (network: string, walletAddress: string, contract: string) => boolean;
} {
  const [state, setState] = useState<PersistedTxState | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = localStorage.getItem(TX_STATE_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as PersistedTxState;
    } catch {
      return null;
    }
  });

  const save = useCallback((next: PersistedTxState) => {
    try {
      localStorage.setItem(TX_STATE_STORAGE_KEY, JSON.stringify(next));
      setState(next);
    } catch {
      // Storage full or disabled; continue without persistence.
    }
  }, []);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(TX_STATE_STORAGE_KEY);
    } catch {}
    setState(null);
  }, []);

  const canResume = useCallback(
    (network: string, walletAddress: string, contract: string) => {
      if (!state) return false;
      return state.network === network && state.walletAddress === walletAddress && state.contract === contract;
    },
    [state],
  );

  return { state, save, clear, canResume };
}

