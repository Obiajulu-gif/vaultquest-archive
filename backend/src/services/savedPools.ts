import type { PrismaClient, SavedPool } from "@prisma/client";

/**
 * Saved-pool cache keys must always include the wallet scope. Keeping this
 * helper exported makes the authorization assumption explicit and testable.
 */
export function savedPoolsCacheKey(walletAddress: string): string {
  return `saved-pools:${walletAddress.trim()}`;
}

export interface SavedPoolPayload {
  poolId: string;
  poolName: string;
  status: string;
  tvl: string;
  asset: string;
  participantCount: number;
  expectedYield: string;
  prize: string | null;
  opensAt: Date | null;
  locksAt: Date | null;
  drawsAt: Date | null;
}

export interface SavePoolInput {
  walletAddress: string;
  pool: SavedPoolPayload;
}

type CacheEntry = {
  rows: SavedPool[];
};

/**
 * Persists wallet-scoped saved pools and keeps a small LRU read cache.
 * Mutations invalidate only the affected wallet entry so one user's refresh
 * can never evict or overwrite another user's saved-pool view.
 */
export class SavedPoolsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly maxCacheEntries = 100,
  ) {}

  async savePool(input: SavePoolInput): Promise<{ record: SavedPool; created: boolean }> {
    const walletAddress = input.walletAddress.trim();
    const existing = await this.prisma.savedPool.findUnique({
      where: {
        walletAddress_poolId: {
          walletAddress,
          poolId: input.pool.poolId,
        },
      },
    });

    const record = await this.prisma.savedPool.upsert({
      where: {
        walletAddress_poolId: {
          walletAddress,
          poolId: input.pool.poolId,
        },
      },
      create: {
        walletAddress,
        ...input.pool,
      },
      update: {
        poolName: input.pool.poolName,
        status: input.pool.status,
        tvl: input.pool.tvl,
        asset: input.pool.asset,
        participantCount: input.pool.participantCount,
        expectedYield: input.pool.expectedYield,
        prize: input.pool.prize,
        opensAt: input.pool.opensAt,
        locksAt: input.pool.locksAt,
        drawsAt: input.pool.drawsAt,
      },
    });

    this.invalidateWallet(walletAddress);
    return { record, created: existing === null };
  }

  async unsavePool(walletAddress: string, poolId: string): Promise<number> {
    const normalizedWallet = walletAddress.trim();
    const result = await this.prisma.savedPool.deleteMany({
      where: { walletAddress: normalizedWallet, poolId },
    });
    this.invalidateWallet(normalizedWallet);
    return result.count;
  }

  async listSavedPools(walletAddress: string): Promise<SavedPool[]> {
    const normalizedWallet = walletAddress.trim();
    const key = savedPoolsCacheKey(normalizedWallet);
    const cached = this.cache.get(key);

    if (cached) {
      // Refresh LRU order without sharing a mutable array with callers.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return [...cached.rows];
    }

    const rows = await this.prisma.savedPool.findMany({
      where: { walletAddress: normalizedWallet },
      orderBy: { createdAt: "desc" },
    });
    this.cacheRows(key, rows);
    return [...rows];
  }

  private invalidateWallet(walletAddress: string): void {
    this.cache.delete(savedPoolsCacheKey(walletAddress));
  }

  private cacheRows(key: string, rows: SavedPool[]): void {
    this.cache.delete(key);
    this.cache.set(key, { rows: [...rows] });

    while (this.cache.size > Math.max(0, this.maxCacheEntries)) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }
}
