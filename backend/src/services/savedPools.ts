import type { PrismaClient, SavedPool } from "@prisma/client";
import { SavedPoolsCache } from "./savedPoolsCache.js";

/** Metadata persisted for a wallet's saved/watchlisted pool. */
export interface SavedPoolMetadataInput {
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

export interface SavedPoolInput {
  walletAddress: string;
  pool: SavedPoolMetadataInput;
}

export type SavedPoolRecord = SavedPool;

function normalizeWallet(walletAddress: string): string {
  return walletAddress.trim();
}

/**
 * Persists and caches user-saved vault/pool references.
 *
 * Authorization/scoping invariant: every database selector and every cache key
 * includes the normalized wallet address. A pool id is never sufficient to
 * list, update, delete, cache, or invalidate a saved-pool record.
 */
export class SavedPoolsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache: SavedPoolsCache = new SavedPoolsCache(),
  ) {}

  /**
   * Saves or refreshes a pool reference for one wallet.
   *
   * The composite `(walletAddress, poolId)` key prevents an overlapping pool id
   * from replacing another wallet's saved record. Only this wallet's list cache
   * is invalidated after the mutation.
   */
  async savePool(input: SavedPoolInput): Promise<{ record: SavedPoolRecord; created: boolean }> {
    const walletAddress = normalizeWallet(input.walletAddress);
    const { pool } = input;
    const where = {
      walletAddress_poolId: {
        walletAddress,
        poolId: pool.poolId,
      },
    };

    const existing = await this.prisma.savedPool.findUnique({ where });
    const metadata = {
      poolName: pool.poolName,
      status: pool.status,
      tvl: pool.tvl,
      asset: pool.asset,
      participantCount: pool.participantCount,
      expectedYield: pool.expectedYield,
      prize: pool.prize,
      opensAt: pool.opensAt,
      locksAt: pool.locksAt,
      drawsAt: pool.drawsAt,
    };

    const record = await this.prisma.savedPool.upsert({
      where,
      create: {
        walletAddress,
        poolId: pool.poolId,
        ...metadata,
      },
      update: metadata,
    });

    this.cache.invalidateWallet(walletAddress);
    return { record, created: existing === null };
  }

  /**
   * Removes a saved pool only when both wallet and pool id match.
   *
   * A wallet attempting to delete another wallet's record receives a count of
   * zero and cannot evict the other wallet's cached list.
   */
  async unsavePool(walletAddressInput: string, poolId: string): Promise<number> {
    const walletAddress = normalizeWallet(walletAddressInput);
    const result = await this.prisma.savedPool.deleteMany({
      where: { walletAddress, poolId },
    });

    if (result.count > 0) {
      this.cache.invalidateWallet(walletAddress);
    }
    return result.count;
  }

  /**
   * Lists saved pools for exactly one wallet, using a wallet-qualified cache key.
   */
  async listSavedPools(walletAddressInput: string): Promise<SavedPoolRecord[]> {
    const walletAddress = normalizeWallet(walletAddressInput);
    const cached = this.cache.get(walletAddress);
    if (cached) return cached;

    const rows = await this.prisma.savedPool.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
    });

    this.cache.set(walletAddress, rows);
    return rows.map((row) => ({ ...row }));
  }
}
