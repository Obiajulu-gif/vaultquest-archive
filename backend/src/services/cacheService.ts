/**
 * Redis-backed caching layer for frequently requested on-chain and indexer data.
 *
 * Wraps an optional `ioredis` client. When `REDIS_URL` is not configured, or the
 * Redis connection is offline, every method gracefully degrades: reads fall
 * through to the caller-supplied fetcher / PostgreSQL, and writes are skipped.
 * An in-memory LRU is kept for the legacy pending-event / asset-metadata /
 * protocol-config helpers that predate the generic `getOrSet` cache.
 */

import { Redis as RedisClient } from "ioredis";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

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

type CacheEntry<T> = { value: T; accessedAt: Date };

const CHECKPOINT_KEY = "indexer:checkpoint";
const CHECKPOINT_DIRTY_KEY = "indexer:checkpoint:dirty";
const PENDING_EVENT_TTL_SECONDS = 3600;

function pendingEventKey(txHash: string): string {
  return `pending_event:${txHash}`;
}

/**
 * Redis-first cache service with an in-memory LRU fallback for legacy callers
 * and a PostgreSQL fallback for the indexer checkpoint.
 */
export class CacheService {
  private readonly redis: RedisClient | null;
  private isOnline = false;

  private readonly pendingMap = new Map<string, CacheEntry<PendingEvent>>();
  private readonly assetMap = new Map<string, CacheEntry<AssetMetadata>>();
  private readonly configMap = new Map<string, CacheEntry<ProtocolConfigRecord>>();
  private readonly maxEntries: number;

  /**
   * @param prisma - Prisma client used as the source of truth / fallback store
   * @param logger - Structured logger
   * @param redisUrl - `redis://` connection string. When omitted, the service
   *   operates purely off the in-memory maps / PostgreSQL fallback.
   * @param maxEntries - Maximum number of entries per in-memory cache map
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
    redisUrl?: string,
    maxEntries = 500
  ) {
    this.maxEntries = maxEntries;

    if (!redisUrl) {
      this.redis = null;
      this.logger.warn("REDIS_URL not configured — caching falls back to database reads");
      return;
    }

    this.redis = new RedisClient(redisUrl, {
      maxRetriesPerRequest: 2,
      retryStrategy: (times: number) => Math.min(times * 200, 2000)
    });

    this.redis.on("connect", () => {
      this.isOnline = true;
      this.logger.info("Redis connected");
    });

    this.redis.on("error", (err: Error) => {
      this.isOnline = false;
      this.logger.warn({ err }, "Redis connection error — falling back to database");
    });
  }

  // --- generic read-through cache -----------------------------------------

  /**
   * Reads `key` from Redis; on miss (or when Redis is unavailable) invokes
   * `fetch`, caches the result with the given TTL, and returns it.
   *
   * @param key - Cache key
   * @param ttlSeconds - Time-to-live for the cached entry
   * @param fetch - Source-of-truth loader invoked on a cache miss
   */
  async getOrSet<T>(key: string, ttlSeconds: number, fetch: () => Promise<T>): Promise<T> {
    if (this.redis && this.isOnline) {
      try {
        const cached = await this.redis.get(key);
        if (cached !== null) {
          return JSON.parse(cached) as T;
        }
      } catch (err: any) {
        this.logger.warn({ err, key }, "Redis get failed — falling through to source");
      }
    }
    const value = await fetch();
    if (this.redis && this.isOnline) {
      try {
        await this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
      } catch (err: any) {
        this.logger.warn({ err, key }, "Redis set failed — response served uncached");
      }
    }
    return value;
  }

  /**
   * Evicts `key` from Redis (e.g. after the underlying data changes).
   *
   * @param key - Cache key to invalidate
   */
  async invalidate(key: string): Promise<void> {
    if (this.redis && this.isOnline) {
      try {
        await this.redis.del(key);
      } catch (err: any) {
        this.logger.warn({ err, key }, "Redis invalidate failed");
      }
    }
  }

  // --- indexer checkpoint (Redis write-behind, PostgreSQL source of truth) --

  async getCheckpoint(): Promise<Partial<IndexerCheckpoint> | null> {
    if (this.redis && this.isOnline) {
      try {
        const data = await this.redis.get(CHECKPOINT_KEY);
        if (data) {
          const parsed = JSON.parse(data);
          return {
            id: "singleton",
            latestLedger: parsed.latestLedger,
            lastProcessedEventId: parsed.lastProcessedEventId ?? null,
            lastSyncTime: new Date(parsed.lastSyncTime),
            lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime),
            lastError: parsed.lastError
          };
        }
      } catch (err) {
        this.logger.warn({ err }, "Redis getCheckpoint failed, falling back to database");
      }
    }
    // Fallback to PostgreSQL
    return this.prisma.indexerCheckpoint.findUnique({ where: { id: "singleton" } });
  }

  async setCheckpoint(checkpoint: {
    latestLedger: number;
    lastProcessedEventId: string | null;
    lastSyncTime: Date;
    lastSuccessSyncTime: Date;
    lastError: string | null;
  }): Promise<void> {
    if (this.redis && this.isOnline) {
      try {
        await this.redis.set(
          CHECKPOINT_KEY,
          JSON.stringify({
            latestLedger: checkpoint.latestLedger,
            lastProcessedEventId: checkpoint.lastProcessedEventId,
            lastSyncTime: checkpoint.lastSyncTime.toISOString(),
            lastSuccessSyncTime: checkpoint.lastSuccessSyncTime.toISOString(),
            lastError: checkpoint.lastError
          })
        );
        await this.redis.set(CHECKPOINT_DIRTY_KEY, "true");
        return;
      } catch (err) {
        this.logger.warn({ err }, "Redis setCheckpoint failed, writing directly to database");
      }
    }

    // Fallback direct DB write
    await this.prisma.indexerCheckpoint.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        latestLedger: checkpoint.latestLedger,
        lastProcessedEventId: checkpoint.lastProcessedEventId,
        lastSyncTime: checkpoint.lastSyncTime,
        lastError: checkpoint.lastError,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime
      },
      update: {
        latestLedger: checkpoint.latestLedger,
        lastProcessedEventId: checkpoint.lastProcessedEventId,
        lastSyncTime: checkpoint.lastSyncTime,
        lastError: checkpoint.lastError,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime
      }
    });
  }

  /**
   * Write-behind sync: if the Redis checkpoint is marked dirty, persists it
   * to PostgreSQL and clears the dirty flag. Intended to be called on a timer.
   */
  async syncCheckpointToDb(): Promise<void> {
    if (!this.redis || !this.isOnline) return;
    try {
      const isDirty = await this.redis.get(CHECKPOINT_DIRTY_KEY);
      if (isDirty !== "true") return;

      const data = await this.redis.get(CHECKPOINT_KEY);
      if (!data) return;

      const parsed = JSON.parse(data);
      await this.prisma.indexerCheckpoint.upsert({
        where: { id: "singleton" },
        create: {
          id: "singleton",
          latestLedger: parsed.latestLedger,
          lastProcessedEventId: parsed.lastProcessedEventId ?? null,
          lastSyncTime: new Date(parsed.lastSyncTime),
          lastError: parsed.lastError,
          lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime)
        },
        update: {
          latestLedger: parsed.latestLedger,
          lastProcessedEventId: parsed.lastProcessedEventId ?? null,
          lastSyncTime: new Date(parsed.lastSyncTime),
          lastError: parsed.lastError,
          lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime)
        }
      });
      await this.redis.del(CHECKPOINT_DIRTY_KEY);
      this.logger.info("Synced indexer checkpoint from Redis to PostgreSQL");
    } catch (err) {
      this.logger.error({ err }, "Failed to sync checkpoint from Redis to PostgreSQL");
    }
  }

  // --- pending events (Redis cache, PostgreSQL source of truth) -----------

  /**
   * Retrieves a pending event by transaction hash. Checks Redis, then the
   * in-memory LRU, then falls back to PostgreSQL.
   *
   * @param txHash - On-chain transaction hash
   * @returns Pending event or null if absent
   */
  async getPendingEvent(txHash: string): Promise<PendingEvent | null> {
    if (this.redis && this.isOnline) {
      try {
        const data = await this.redis.get(pendingEventKey(txHash));
        if (data) return JSON.parse(data) as PendingEvent;
      } catch (err) {
        this.logger.warn({ err, txHash }, "Redis getPendingEvent failed, falling back");
      }
    }

    const entry = this.pendingMap.get(txHash);
    if (entry) {
      entry.accessedAt = new Date();
      return entry.value;
    }

    const row = await this.prisma.pendingEvent.findUnique({ where: { txHash } });
    if (!row) return null;
    return {
      txHash: row.txHash,
      sorobanEventId: row.sorobanEventId,
      eventPayload: row.eventPayload,
      statusHint: row.statusHint as PendingEvent["statusHint"],
      receivedAt: row.receivedAt,
      consumedAt: row.consumedAt
    };
  }

  /**
   * Write-through: persists the pending event to PostgreSQL, then caches it
   * in Redis (and the in-memory LRU). Once an event is consumed
   * (`consumedAt` set) it is evicted from the cache — only active pending
   * events are worth serving from cache.
   *
   * @param event - Pending event payload
   */
  async setPendingEvent(event: PendingEvent): Promise<void> {
    await this.prisma.pendingEvent.upsert({
      where: { txHash: event.txHash },
      create: {
        txHash: event.txHash,
        sorobanEventId: event.sorobanEventId,
        eventPayload: event.eventPayload as any,
        statusHint: event.statusHint,
        receivedAt: event.receivedAt,
        consumedAt: event.consumedAt ?? null
      },
      update: {
        sorobanEventId: event.sorobanEventId,
        eventPayload: event.eventPayload as any,
        statusHint: event.statusHint,
        consumedAt: event.consumedAt ?? null
      }
    });

    if (event.consumedAt) {
      this.pendingMap.delete(event.txHash);
      if (this.redis && this.isOnline) {
        try {
          await this.redis.del(pendingEventKey(event.txHash));
        } catch (err) {
          this.logger.warn({ err, txHash: event.txHash }, "Redis delete of consumed pending event failed");
        }
      }
      return;
    }

    this.touch(this.pendingMap, event.txHash, event);
    if (this.redis && this.isOnline) {
      try {
        await this.redis.set(
          pendingEventKey(event.txHash),
          JSON.stringify(event),
          "EX",
          PENDING_EVENT_TTL_SECONDS
        );
      } catch (err) {
        this.logger.warn({ err, txHash: event.txHash }, "Redis cache of pending event failed");
      }
    }
  }

  /**
   * Removes a pending event from the cache (Redis + in-memory) after
   * reconciliation. Does not touch the PostgreSQL row.
   *
   * @param txHash - Transaction hash to remove
   */
  async deletePendingEvent(txHash: string): Promise<void> {
    this.pendingMap.delete(txHash);
    if (this.redis && this.isOnline) {
      try {
        await this.redis.del(pendingEventKey(txHash));
      } catch (err) {
        this.logger.warn({ err, txHash }, "Redis deletePendingEvent failed");
      }
    }
  }

  // --- asset metadata (in-memory LRU) --------------------------------------

  /**
   * Retrieves cached asset metadata by asset code.
   *
   * @param asset - Asset code or `native` for XLM
   * @returns Cached metadata or null
   */
  async getAssetMetadata(asset: string): Promise<AssetMetadata | null> {
    const entry = this.assetMap.get(asset);
    if (!entry) return null;
    entry.accessedAt = new Date();
    return entry.value;
  }

  /**
   * Caches asset metadata.
   *
   * @param metadata - Asset metadata record
   */
  async setAssetMetadata(metadata: AssetMetadata): Promise<void> {
    this.touch(this.assetMap, metadata.asset, metadata);
  }

  // --- protocol config (in-memory LRU) -------------------------------------

  /**
   * Reads a cached protocol config value by key.
   *
   * @param key - Config key
   * @returns Cached config record or null
   */
  async getProtocolConfig(key: string): Promise<ProtocolConfigRecord | null> {
    const entry = this.configMap.get(key);
    if (!entry) return null;
    entry.accessedAt = new Date();
    return entry.value;
  }

  /**
   * Writes a protocol config record to cache.
   *
   * @param record - Config record
   */
  async setProtocolConfig(record: ProtocolConfigRecord): Promise<void> {
    this.touch(this.configMap, record.key, record);
  }

  /**
   * Invalidates protocol config by key when underlying config changes.
   *
   * @param key - Config key to evict
   */
  async invalidateProtocolConfig(key: string): Promise<void> {
    this.configMap.delete(key);
  }

  /**
   * Resets all in-memory caches (context: config refresh/restart).
   */
  async reset(): Promise<void> {
    this.pendingMap.clear();
    this.assetMap.clear();
    this.configMap.clear();
  }

  /**
   * Closes the Redis connection (if any) and clears in-memory caches.
   */
  async disconnect(): Promise<void> {
    await this.reset();
    if (this.redis) {
      await this.redis.quit().catch(() => undefined);
    }
  }

  // --- helpers ---

  private touch<K, V>(map: Map<K, CacheEntry<V>>, key: K, value: V): void {
    const now = new Date();
    map.set(key, { value, accessedAt: now });
    this.evictIfNeeded(map);
  }

  private evictIfNeeded<K, V>(map: Map<K, CacheEntry<V>>): void {
    if (map.size <= this.maxEntries) return;
    let oldestKey: K | undefined;
    let oldest = new Date(map.size ? Infinity : 0);
    for (const [k, entry] of map.entries()) {
      if (entry.accessedAt < oldest) {
        oldest = entry.accessedAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}
