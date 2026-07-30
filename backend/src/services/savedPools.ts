import type { PrismaClient } from "@prisma/client";

/**
 * Persists user-saved vault/pool references for quick access and watchlists.
 *
 * ## Wallet-scoping invariant
 *
 * Every record in the `SavedPool` table is keyed on `(walletAddress, poolId)`.
 * This composite unique key (enforced by the DB schema) guarantees:
 *
 * 1. **List isolation** — `listSavedPools(wallet)` only returns rows matching
 *    that exact wallet address. No cross-wallet leakage is possible at the
 *    query level.
 *
 * 2. **Delete isolation** — `unsavePool(wallet, poolId)` filters on both
 *    columns. A caller cannot remove another wallet's record by supplying a
 *    poolId that happens to match; the wallet address must also match.
 *
 * 3. **Shared pools** — Two wallets may independently save the same `poolId`.
 *    These are separate rows with independent lifecycles. Deleting one wallet's
 *    copy has no effect on the other wallet's copy.
 *
 * 4. **Cache / invalidation scope** — Any future in-memory or Redis cache
 *    MUST include the wallet address in the cache key
 *    (e.g. `saved-pools:<walletAddress>`). Flushing or evicting one wallet's
 *    cache entry MUST NOT flush entries for other wallets.
 *
 * These invariants are regression-tested in `tests/saved-pools-auth.spec.ts`.
 */

export interface SavedPoolInput {
  walletAddress: string;
  pool: {
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
  };
}

export interface SavedPoolRecord {
  id: string;
  walletAddress: string;
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
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Manages saved pool records linked to user wallets.
 */
export class SavedPoolsService {
  /**
   * @param prisma - Prisma client for database access
   */
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Saves a pool reference for a wallet if not already saved.
   * If the pool already exists, it updates the pool details.
   *
   * @param input - Wallet and pool identifiers with full pool details
   * @returns The saved record and whether it was newly created
   */
  async savePool(input: SavedPoolInput): Promise<{ record: SavedPoolRecord; created: boolean }> {
    const existing = await this.prisma.savedPool.findUnique({
      where: {
        walletAddress_poolId: {
          walletAddress: input.walletAddress,
          poolId: input.pool.poolId,
        },
      },
    });

    if (existing) {
      // Update existing pool with latest details
      const updated = await this.prisma.savedPool.update({
        where: {
          walletAddress_poolId: {
            walletAddress: input.walletAddress,
            poolId: input.pool.poolId,
          },
        },
        data: {
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
      return { record: updated as unknown as SavedPoolRecord, created: false };
    }

    const created = await this.prisma.savedPool.create({
      data: {
        walletAddress: input.walletAddress,
        poolId: input.pool.poolId,
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

    return { record: created as unknown as SavedPoolRecord, created: true };
  }

  /**
   * Removes a saved pool reference for a wallet.
   *
   * @param walletAddress - Wallet identifier
   * @param poolId - Pool identifier
   * @returns Number of records removed
   */
  async unsavePool(walletAddress: string, poolId: string): Promise<number> {
    const result = await this.prisma.savedPool.deleteMany({
      where: { walletAddress, poolId },
    });
    return result.count;
  }

  /**
   * Lists all saved pools for a wallet.
   *
   * @param walletAddress - Wallet identifier
   * @returns Saved pool records
   */
  async listSavedPools(walletAddress: string): Promise<SavedPoolRecord[]> {
    const rows = await this.prisma.savedPool.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
    });

    return rows as unknown as SavedPoolRecord[];
  }
}