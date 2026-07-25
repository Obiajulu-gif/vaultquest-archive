import type { SavedPool } from "@prisma/client";

export interface SavedPoolsCacheOptions {
  /** Maximum number of wallet entries retained. */
  maxEntries?: number;
  /** Time-to-live for each wallet entry. */
  ttlMs?: number;
  /** Injectable clock used by deterministic tests. */
  now?: () => number;
}

type SavedPoolsCacheEntry = {
  records: readonly SavedPool[];
  expiresAt: number;
};

/**
 * Build the only supported cache key for saved-pool lists.
 *
 * Wallet scope is part of the key by construction. A pool id must never be used
 * as a list-cache key because the same pool can be saved by many wallets.
 */
export function savedPoolsCacheKey(walletAddress: string): string {
  return `saved-pools:${walletAddress.trim()}`;
}

/**
 * Small in-memory LRU cache for saved-pool lists.
 *
 * Each entry represents exactly one wallet. Reads move that wallet to the most
 * recently used position, writes replace only that wallet, and invalidation is
 * wallet-local. Returned arrays are shallow copies so callers cannot mutate the
 * cached list accidentally.
 */
export class SavedPoolsCache {
  private readonly entries = new Map<string, SavedPoolsCacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SavedPoolsCacheOptions = {}) {
    this.maxEntries = Math.max(0, options.maxEntries ?? 500);
    this.ttlMs = Math.max(0, options.ttlMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  get(walletAddress: string): SavedPool[] | null {
    const key = savedPoolsCacheKey(walletAddress);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    // Map insertion order is the LRU order. Reinsert on read to mark as MRU.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.records.map((record) => ({ ...record }));
  }

  set(walletAddress: string, records: readonly SavedPool[]): void {
    if (this.maxEntries === 0) return;

    const key = savedPoolsCacheKey(walletAddress);
    this.entries.delete(key);
    this.entries.set(key, {
      records: records.map((record) => ({ ...record })),
      expiresAt: this.now() + this.ttlMs,
    });

    while (this.entries.size > this.maxEntries) {
      const leastRecentlyUsed = this.entries.keys().next().value as string | undefined;
      if (leastRecentlyUsed === undefined) break;
      this.entries.delete(leastRecentlyUsed);
    }
  }

  invalidateWallet(walletAddress: string): void {
    this.entries.delete(savedPoolsCacheKey(walletAddress));
  }

  clear(): void {
    this.entries.clear();
  }

  /** Test/diagnostic helper without exposing mutable entry data. */
  hasWallet(walletAddress: string): boolean {
    return this.entries.has(savedPoolsCacheKey(walletAddress));
  }

  /** Test/diagnostic helper for deterministic eviction assertions. */
  keys(): string[] {
    return [...this.entries.keys()];
  }

  get size(): number {
    return this.entries.size;
  }
}
