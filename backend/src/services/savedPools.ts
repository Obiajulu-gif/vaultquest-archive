import type { PrismaClient } from "@prisma/client";

/** Persists user-saved vault/pool references for quick access and watchlists. */
export interface SavedPoolInput {
  walletAddress: string;
  poolId: string;
}

export interface SavedPoolRecord {
  walletAddress: string;
  poolId: string;
  createdAt: Date;
}

export interface SavedPoolsCache {
  get(key: string): Promise<SavedPoolRecord[] | undefined>;
  set(key: string, value: SavedPoolRecord[]): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Cache keys must always include the normalized wallet identity. */
export function savedPoolsCacheKey(walletAddress: string): string {
  return `saved-pools:${walletAddress.trim().toLowerCase()}`;
}

/** Manages saved pool records linked to user wallets. */
export class SavedPoolsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache?: SavedPoolsCache,
  ) {}

  async savePool(input: SavedPoolInput): Promise<{ record: SavedPoolRecord; created: boolean }> {
    const existing = await this.prisma.savedPool.findUnique({
      where: {
        walletAddress_poolId: {
          walletAddress: input.walletAddress,
          poolId: input.poolId,
        },
      },
    });

    if (existing) {
      return { record: existing as unknown as SavedPoolRecord, created: false };
    }

    const created = await this.prisma.savedPool.create({
      data: {
        walletAddress: input.walletAddress,
        poolId: input.poolId,
      },
    });

    await this.cache?.delete(savedPoolsCacheKey(input.walletAddress));
    return { record: created as unknown as SavedPoolRecord, created: true };
  }

  async unsavePool(walletAddress: string, poolId: string): Promise<number> {
    const result = await this.prisma.savedPool.deleteMany({
      where: { walletAddress, poolId },
    });
    if (result.count > 0) {
      await this.cache?.delete(savedPoolsCacheKey(walletAddress));
    }
    return result.count;
  }

  async listSavedPools(walletAddress: string): Promise<SavedPoolRecord[]> {
    const key = savedPoolsCacheKey(walletAddress);
    const cached = await this.cache?.get(key);
    if (cached) return cached;

    const rows = (await this.prisma.savedPool.findMany({
      where: { walletAddress },
      orderBy: { createdAt: "desc" },
    })) as unknown as SavedPoolRecord[];

    await this.cache?.set(key, rows);
    return rows;
  }
}
