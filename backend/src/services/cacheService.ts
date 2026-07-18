import Redis from "ioredis";

/**
 * In-memory and Redis-backed caching for frequently requested on-chain data.
 *
 * The service prefers Redis when it is available, but always falls back to the
 * database so the backend stays functional during cache outages.
 */

export interface IndexerCheckpoint {
  id?: string;
  latestLedger: number;
  lastProcessedEventId?: string | null;
  lastSyncTime: Date;
  lastSuccessSyncTime?: Date;
  lastError?: string | null;
}

export interface PendingEvent {
  txHash: string;
  sorobanEventId: string;
  eventPayload: unknown;
  statusHint: "confirmed" | "reverted";
  receivedAt: Date;
  consumedAt?: Date | null;
}

export interface AssetMetadata {
  asset: string;
  decimals: number;
  lastUpdated: Date;
}

export interface ProtocolConfigRecord {
  key: string;
  value: unknown;
  updatedAt: Date;
}

type PrismaLike = {
  indexerCheckpoint: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
  };
  pendingEvent: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
    update?: (args: any) => Promise<any>;
  };
};

type LoggerLike = {
  info?: (...args: any[]) => void;
  warn?: (...args: any[]) => void;
  error?: (...args: any[]) => void;
  debug?: (...args: any[]) => void;
};

type CheckpointInput = {
  latestLedger: number;
  lastProcessedEventId?: string | null;
  lastSyncTime: Date;
  lastSuccessSyncTime?: Date | null;
  lastError?: string | null;
};

type CacheEntry<T> = {
  value: T;
  accessedAt: Date;
};

const CHECKPOINT_KEY = "indexer:checkpoint";
const CHECKPOINT_DIRTY_KEY = "indexer:checkpoint:dirty";
const pendingEventKey = (txHash: string) => `pending-event:${txHash}`;

export class CacheService {
  private readonly prisma: PrismaLike;
  private readonly logger: LoggerLike;
  private redis: any = null;
  private isOnline = false;

  private readonly pendingMap = new Map<string, CacheEntry<PendingEvent>>();
  private readonly assetMap = new Map<string, CacheEntry<AssetMetadata>>();
  private readonly configMap = new Map<string, CacheEntry<ProtocolConfigRecord>>();
  private checkpoint: CacheEntry<IndexerCheckpoint | null> = {
    value: null,
    accessedAt: new Date()
  };

  constructor(prisma: PrismaLike, logger: LoggerLike, redisUrl?: string) {
    this.prisma = prisma;
    this.logger = logger;

    if (redisUrl) {
      const RedisCtor = Redis as unknown as new (url: string) => any;
      this.redis = new RedisCtor(redisUrl);
      this.redis.on("connect", () => {
        this.isOnline = true;
      });
      this.redis.on("ready", () => {
        this.isOnline = true;
      });
      this.redis.on("close", () => {
        this.isOnline = false;
      });
      this.redis.on("end", () => {
        this.isOnline = false;
      });
      this.redis.on("error", () => {
        this.isOnline = false;
      });
    }
  }

  private touch<K, V>(map: Map<K, CacheEntry<V>>, key: K, value: V): void {
    const now = new Date();
    map.set(key, { value, accessedAt: now });
    this.evictIfNeeded(map);
  }

  private evictIfNeeded<K, V>(map: Map<K, CacheEntry<V>>, maxEntries = 500): void {
    if (map.size <= maxEntries) return;

    let oldestKey: K | undefined;
    let oldestTime = Number.POSITIVE_INFINITY;

    for (const [key, entry] of map.entries()) {
      const accessedAt = entry.accessedAt.getTime();
      if (accessedAt < oldestTime) {
        oldestTime = accessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }

  private canUseRedis(): boolean {
    return Boolean(this.redis && this.isOnline);
  }

  private async readRedisJSON<T>(key: string): Promise<T | null> {
    if (!this.canUseRedis() || !this.redis) return null;

    const raw = await this.redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  private async writeRedisJSON(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.canUseRedis() || !this.redis) return;

    const payload = JSON.stringify(value);
    if (ttlSeconds !== undefined) {
      await this.redis.set(key, payload, "EX", ttlSeconds);
      return;
    }
    await this.redis.set(key, payload);
  }

  async getCheckpoint(): Promise<Partial<IndexerCheckpoint> | null> {
    if (this.canUseRedis()) {
      try {
        const cached = await this.readRedisJSON<CheckpointInput>(CHECKPOINT_KEY);
        if (cached) {
          return {
            id: "singleton",
            latestLedger: cached.latestLedger,
            lastProcessedEventId: cached.lastProcessedEventId ?? null,
            lastSyncTime: new Date(cached.lastSyncTime),
            ...(cached.lastSuccessSyncTime
              ? { lastSuccessSyncTime: new Date(cached.lastSuccessSyncTime) }
              : {}),
            lastError: cached.lastError ?? null
          };
        }
      } catch (err) {
        this.logger.warn?.({ err }, "Redis getCheckpoint failed, falling back to database");
      }
    }

    return this.prisma.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
  }

  async setCheckpoint(checkpoint: CheckpointInput): Promise<void> {
    const payload = {
      latestLedger: checkpoint.latestLedger,
      lastProcessedEventId: checkpoint.lastProcessedEventId ?? null,
      lastSyncTime: checkpoint.lastSyncTime.toISOString(),
      lastSuccessSyncTime: checkpoint.lastSuccessSyncTime
        ? checkpoint.lastSuccessSyncTime.toISOString()
        : null,
      lastError: checkpoint.lastError ?? null
    };

    if (this.canUseRedis()) {
      try {
        await this.writeRedisJSON(CHECKPOINT_KEY, payload);
        await this.redis?.set(CHECKPOINT_DIRTY_KEY, "true");
        return;
      } catch (err) {
        this.logger.warn?.({ err }, "Redis setCheckpoint failed, writing directly to database");
      }
    }

    await this.prisma.indexerCheckpoint.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        latestLedger: checkpoint.latestLedger,
        lastProcessedEventId: checkpoint.lastProcessedEventId ?? null,
        lastSyncTime: checkpoint.lastSyncTime,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime ?? checkpoint.lastSyncTime,
        lastError: checkpoint.lastError ?? null
      },
      update: {
        latestLedger: checkpoint.latestLedger,
        lastProcessedEventId: checkpoint.lastProcessedEventId ?? null,
        lastSyncTime: checkpoint.lastSyncTime,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime ?? checkpoint.lastSyncTime,
        lastError: checkpoint.lastError ?? null
      }
    });
  }

  async syncCheckpointToDb(): Promise<void> {
    if (!this.canUseRedis()) return;

    try {
      const isDirty = await this.redis?.get(CHECKPOINT_DIRTY_KEY);
      if (isDirty !== "true") return;

      const cached = await this.readRedisJSON<CheckpointInput>(CHECKPOINT_KEY);
      if (!cached) return;

      await this.prisma.indexerCheckpoint.upsert({
        where: { id: "singleton" },
        create: {
          id: "singleton",
          latestLedger: cached.latestLedger,
          lastProcessedEventId: cached.lastProcessedEventId ?? null,
          lastSyncTime: new Date(cached.lastSyncTime),
          ...(cached.lastSuccessSyncTime
            ? { lastSuccessSyncTime: new Date(cached.lastSuccessSyncTime) }
            : {}),
          lastError: cached.lastError ?? null
        },
        update: {
          latestLedger: cached.latestLedger,
          lastProcessedEventId: cached.lastProcessedEventId ?? null,
          lastSyncTime: new Date(cached.lastSyncTime),
          ...(cached.lastSuccessSyncTime
            ? { lastSuccessSyncTime: new Date(cached.lastSuccessSyncTime) }
            : {}),
          lastError: cached.lastError ?? null
        }
      });

      await this.redis?.del(CHECKPOINT_DIRTY_KEY);
      this.logger.info?.("Synced indexer checkpoint from Redis to PostgreSQL");
    } catch (err) {
      this.logger.error?.({ err }, "Failed to sync checkpoint from Redis to PostgreSQL");
    }
  }

  async getPendingEvent(txHash: string): Promise<PendingEvent | null> {
    const entry = this.pendingMap.get(txHash);
    if (entry) {
      entry.accessedAt = new Date();
      return entry.value;
    }

    if (this.canUseRedis()) {
      try {
        const cached = await this.readRedisJSON<PendingEvent>(pendingEventKey(txHash));
        if (cached) {
          this.touch(this.pendingMap, txHash, {
            ...cached,
          receivedAt: new Date(cached.receivedAt),
          consumedAt: cached.consumedAt ? new Date(cached.consumedAt) : null
          });
          return cached;
        }
      } catch (err) {
        this.logger.warn?.({ err, txHash }, "Redis getPendingEvent failed");
      }
    }

    const row = await this.prisma.pendingEvent.findUnique({ where: { txHash } });
    return row ?? null;
  }

  async setPendingEvent(event: PendingEvent): Promise<void> {
    const normalized: PendingEvent = {
      ...event,
      consumedAt: event.consumedAt ?? null
    };

    await this.prisma.pendingEvent.upsert({
      where: { txHash: event.txHash },
      create: normalized,
      update: normalized
    });

    this.touch(this.pendingMap, event.txHash, normalized);

    if (this.canUseRedis()) {
      try {
        if (normalized.consumedAt) {
          await this.redis?.del(pendingEventKey(event.txHash));
          return;
        }

        await this.writeRedisJSON(pendingEventKey(event.txHash), {
          ...normalized,
          receivedAt: normalized.receivedAt.toISOString(),
          consumedAt: (() => {
            const consumedAt = normalized.consumedAt as Date | null | undefined;
            return consumedAt ? consumedAt.toISOString() : null;
          })()
        });
      } catch (err) {
        this.logger.warn?.({ err, txHash: event.txHash }, "Redis setPendingEvent failed");
      }
    }
  }

  async deletePendingEvent(txHash: string): Promise<void> {
    this.pendingMap.delete(txHash);

    if (this.canUseRedis()) {
      try {
        await this.redis?.del(pendingEventKey(txHash));
      } catch (err) {
        this.logger.warn?.({ err, txHash }, "Redis deletePendingEvent failed");
      }
    }
  }

  async getAssetMetadata(asset: string): Promise<AssetMetadata | null> {
    const entry = this.assetMap.get(asset);
    if (!entry) return null;
    entry.accessedAt = new Date();
    return entry.value;
  }

  async setAssetMetadata(metadata: AssetMetadata): Promise<void> {
    this.touch(this.assetMap, metadata.asset, metadata);
  }

  async getOrSet<T>(key: string, ttlSeconds: number, fetch: () => Promise<T>): Promise<T> {
    if (this.canUseRedis()) {
      try {
        const cached = await this.redis?.get(key);
        if (cached !== null && cached !== undefined) {
          return JSON.parse(cached) as T;
        }
      } catch (err) {
        this.logger.warn?.({ err, key }, "Redis get failed - falling through to source");
      }
    }

    const value = await fetch();

    if (this.canUseRedis()) {
      try {
        await this.writeRedisJSON(key, value, ttlSeconds);
      } catch (err) {
        this.logger.warn?.({ err, key }, "Redis set failed - response served uncached");
      }
    }

    return value;
  }

  async invalidate(key: string): Promise<void> {
    if (!this.canUseRedis()) return;

    try {
      await this.redis?.del(key);
    } catch (err) {
      this.logger.warn?.({ err, key }, "Redis invalidate failed");
    }
  }

  async getProtocolConfig(key: string): Promise<ProtocolConfigRecord | null> {
    const entry = this.configMap.get(key);
    if (!entry) return null;
    entry.accessedAt = new Date();
    return entry.value;
  }

  async setProtocolConfig(record: ProtocolConfigRecord): Promise<void> {
    this.touch(this.configMap, record.key, record);
  }

  async invalidateProtocolConfig(key: string): Promise<void> {
    this.configMap.delete(key);
  }

  async reset(): Promise<void> {
    this.pendingMap.clear();
    this.assetMap.clear();
    this.configMap.clear();
    this.checkpoint = { value: null, accessedAt: new Date() };
  }

  async disconnect(): Promise<void> {
    await this.reset();
    if (this.redis) {
      await this.redis.quit();
    }
  }
}
