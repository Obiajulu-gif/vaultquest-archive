import type { PoolActionType } from "../contract/types";

export type VaultQueryKey = readonly [
  scope: "vaultquest",
  resource: string,
  ...parts: readonly (string | number | boolean | null | undefined)[],
];

const normalize = (value: string | null | undefined): string => value?.trim() || "anonymous";

export const vaultQueryKeys = {
  all: ["vaultquest"] as const,
  config: () => ["vaultquest", "config"] as const,
  poolLists: () => ["vaultquest", "pools"] as const,
  pools: (filter = "all") => ["vaultquest", "pools", filter] as const,
  pool: (poolId: string) => ["vaultquest", "pool", poolId] as const,
  poolDetail: (poolId: string, walletAddress?: string | null) =>
    ["vaultquest", "pool-detail", poolId, normalize(walletAddress)] as const,
  account: (walletAddress?: string | null) => ["vaultquest", "account", normalize(walletAddress)] as const,
  userPosition: (poolId: string, walletAddress?: string | null) =>
    ["vaultquest", "position", poolId, normalize(walletAddress)] as const,
  rewards: (walletAddress?: string | null) => ["vaultquest", "rewards", normalize(walletAddress)] as const,
  prizes: (walletAddress?: string | null) => ["vaultquest", "prizes", normalize(walletAddress)] as const,
  savedPools: (walletAddress?: string | null) => ["vaultquest", "saved-pools", normalize(walletAddress)] as const,
  transaction: (actionIdOrTxHash: string) => ["vaultquest", "transaction", actionIdOrTxHash] as const,
  actionFlow: (type: PoolActionType, poolId: string, walletAddress?: string | null) =>
    ["vaultquest", "action-flow", type, poolId, normalize(walletAddress)] as const,
};

export function serializeQueryKey(key: readonly unknown[]): string {
  return JSON.stringify(key);
}

export function queryKeyStartsWith(key: readonly unknown[], prefix: readonly unknown[]): boolean {
  if (prefix.length > key.length) return false;
  return prefix.every((part, index) => Object.is(part, key[index]));
}
