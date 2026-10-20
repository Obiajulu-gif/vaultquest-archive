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
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

export interface StaleCacheEntry {
  key: string;
  kind: "pending_event" | "asset_metadata" | "protocol_config" | "generic" | "checkpoint";
  reason: "missing" | "stale" | "drift";
  cachedAt?: Date;
  sourceUpdatedAt?: Date;
  sourceVersion?: number;
  cachedVersion?: number;
  recommendation: "invalidate_and_refetch" | "review_before_repair";
  detail?: string;
}

export interface RepairResult {
  dryRun: boolean;
  scanned: number;
  complete: boolean;
  stale: StaleCacheEntry[];
  repaired: string[];
  failed: Array<{ key: string; error: string }>;
}

export interface StaleCacheInspection {
  entries: StaleCacheEntry[];
  scanned: number;
  complete: boolean;
}

export interface IndexerCheckpoint {
  id?: string;
  latestLedger: number;
  lastProcessedEventId?: string | null;
  indexerVersion?: string | null;
  lastSyncTime: Date;
  lastSuccessSyncTime?: Date;
  lastError?: string | null;
  version?: number;
}

export interface PendingEvent {
  txHash: string;
  sorobanEventId: string;
  eventPayload: unknown;
  statusHint: "confirmed" | "reverted";
  /** Emitting ledger's close time (#751); a string when read back from Redis JSON. */
  ledgerClosedAt?: Date | string | null;
  receivedAt: Date;
  consumedAt?: Date | null;
  version?: number;
}

export interface AssetMetadata {
  asset: string;
  decimals: number;
  lastUpdated: Date;
  version?: number;
}

export interface ProtocolConfigRecord {
  key: string;
  value: unknown;
  updatedAt: Date;
  version?: number;
}

type CacheEntry<T> = { value: T; accessedAt: Date };

const CHECKPOINT_KEY = "indexer:checkpoint";
const CHECKPOINT_DIRTY_KEY = "indexer:checkpoint:dirty";
const PENDING_EVENT_TTL_SECONDS = 3600;
const STALE_AGE_MS = 5 * 60 * 1000;
const STALE_INDEX_KEY = "vaultquest:cache:index";
const DEFAULT_STALE_SCAN_LIMIT = 100;
const MAX_STALE_SCAN_LIMIT = 500;
const WRITE_CHECKPOINT_SCRIPT = `
redis.call("SET", KEYS[1], "true")
redis.call("SET", KEYS[2], ARGV[1])
return 1
`;
const REPAIR_CHECKPOINT_SCRIPT = `
if redis.call("GET", KEYS[1]) == "true" then
  return 0
end
redis.call("DEL", KEYS[2])
redis.call("SREM", KEYS[3], ARGV[1])
return 1
`;

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
  private redisScanCursor = "0";
  private readonly versionMap = new Map<string, number>();

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

  get redisClient(): RedisClient | null {
    return this.redis;
  }

  get redisOnline(): boolean {
    return this.redis !== null && this.isOnline;
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
        await this.redis.sadd(STALE_INDEX_KEY, key);
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
        await this.redis.srem(STALE_INDEX_KEY, key);
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
            lastError: parsed.lastError,
            version: parsed.version
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
    indexerVersion?: string | null;
    lastSyncTime: Date;
    lastSuccessSyncTime: Date;
    lastError: string | null;
    version?: number;
  }): Promise<void> {
    if (this.redis && this.isOnline) {
      try {
        await this.redis.eval(
          WRITE_CHECKPOINT_SCRIPT,
          2,
          CHECKPOINT_DIRTY_KEY,
          CHECKPOINT_KEY,
          JSON.stringify({
            latestLedger: checkpoint.latestLedger,
            lastProcessedEventId: checkpoint.lastProcessedEventId,
            indexerVersion: checkpoint.indexerVersion ?? null,
            lastSyncTime: checkpoint.lastSyncTime.toISOString(),
            lastSuccessSyncTime: checkpoint.lastSuccessSyncTime.toISOString(),
            lastError: checkpoint.lastError,
            version: checkpoint.version ?? Date.now()
          }),
        );
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
        indexerVersion: checkpoint.indexerVersion ?? null,
        lastSyncTime: checkpoint.lastSyncTime,
        lastError: checkpoint.lastError,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime,
        version: checkpoint.version ?? Date.now()
      },
      update: {
        latestLedger: checkpoint.latestLedger,
        lastProcessedEventId: checkpoint.lastProcessedEventId,
        indexerVersion: checkpoint.indexerVersion ?? null,
        lastSyncTime: checkpoint.lastSyncTime,
        lastError: checkpoint.lastError,
        lastSuccessSyncTime: checkpoint.lastSuccessSyncTime,
        version: checkpoint.version ?? Date.now()
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
          lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime),
          version: parsed.version ?? Date.now()
        },
        update: {
          latestLedger: parsed.latestLedger,
          lastProcessedEventId: parsed.lastProcessedEventId ?? null,
          lastSyncTime: new Date(parsed.lastSyncTime),
          lastError: parsed.lastError,
          lastSuccessSyncTime: new Date(parsed.lastSuccessSyncTime),
          version: parsed.version ?? Date.now()
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
      ledgerClosedAt: row.ledgerClosedAt,
      receivedAt: row.receivedAt,
      consumedAt: row.consumedAt,
      version: (row as any).version
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
        ledgerClosedAt: event.ledgerClosedAt ? new Date(event.ledgerClosedAt) : null,
        receivedAt: event.receivedAt,
        consumedAt: event.consumedAt ?? null,
        version: event.version ?? Date.now()
      },
      update: {
        sorobanEventId: event.sorobanEventId,
        eventPayload: event.eventPayload as any,
        statusHint: event.statusHint,
        consumedAt: event.consumedAt ?? null,
        version: event.version ?? Date.now()
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
        await this.redis.sadd(STALE_INDEX_KEY, pendingEventKey(event.txHash));
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
        await this.redis.srem(STALE_INDEX_KEY, pendingEventKey(txHash));
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
    this.versionMap.delete(`config:${key}`);
  }

  /**
   * Resets all in-memory caches (context: config refresh/restart).
   */
  async reset(): Promise<void> {
    this.pendingMap.clear();
    this.assetMap.clear();
    this.configMap.clear();
    this.versionMap.clear();
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
    let oldestTime = Infinity;
    for (const [k, entry] of map.entries()) {
      const accessedTime = entry.accessedAt.getTime();
      if (accessedTime < oldestTime) {
        oldestTime = accessedTime;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) map.delete(oldestKey);
  }

  // --- stale detection & repair -------------------------------------------

  /**
   * Records the source-of-truth version/timestamp for a cache key so that
   * later scans can detect drift between the cached value and its source.
   *
   * @param key - Cache key
   * @param version - Monotonic version or epoch ms of the source record
   */
  async markSourceVersion(key: string, version: number): Promise<void> {
    this.versionMap.set(key, version);
    if (this.redis && this.isOnline) {
      try {
        await this.redis.hset("vaultquest:cache:versions", key, String(version));
      } catch (err) {
        this.logger.warn({ err, key }, "Failed to persist source version");
      }
    }
  }

  /**
   * Detects stale cache entries by comparing cached versions/timestamps
   * against the recorded source version. An entry is stale when:
   *  - its source version is newer than the cached version, or
   *  - it has exceeded `STALE_AGE_MS` without a version bump.
   *
   * @param now - Reference time (injectable for tests)
   * @returns List of stale entries (empty when everything is fresh)
   */
  async detectStale(options: {
    now?: Date;
    kind?: StaleCacheEntry["kind"];
    keys?: string[];
    limit?: number;
  } = {}): Promise<StaleCacheEntry[]> {
    return (await this.inspectStale(options)).entries;
  }

  async inspectStale(options: {
    now?: Date;
    kind?: StaleCacheEntry["kind"];
    keys?: string[];
    limit?: number;
  } = {}): Promise<StaleCacheInspection> {
    const stale: StaleCacheEntry[] = [];
    let scanned = 0;
    let totalFindings = 0;
    let complete = true;
    const now = options.now ?? new Date();
    const limit = Math.min(MAX_STALE_SCAN_LIMIT, Math.max(1, options.limit ?? DEFAULT_STALE_SCAN_LIMIT));
    const includes = (key: string, kind: StaleCacheEntry["kind"]) =>
      (options.kind === undefined || options.kind === kind) &&
      (options.keys === undefined || options.keys.includes(key));
    const push = (entry: StaleCacheEntry) => {
      if (!includes(entry.key, entry.kind)) return;
      totalFindings += 1;
      if (stale.length < limit) stale.push(entry);
    };

    // In-memory maps: use source mutation time, not access time, for freshness.
    for (const [key, entry] of this.pendingMap.entries()) {
      scanned += 1;
      const sourceVersion = this.versionMap.get(pendingEventKey(key));
      const cachedVersion = (entry.value as PendingEvent).version;
      const cacheKey = pendingEventKey(key);
      if (sourceVersion !== undefined && (cachedVersion === undefined || sourceVersion > cachedVersion)) {
        push({
          key: cacheKey,
          kind: "pending_event",
          reason: "drift",
          cachedAt: entry.value.receivedAt,
          sourceVersion,
          cachedVersion,
          recommendation: "invalidate_and_refetch",
        });
      } else if (now.getTime() - entry.value.receivedAt.getTime() > STALE_AGE_MS) {
        push({
          key: cacheKey,
          kind: "pending_event",
          reason: "stale",
          cachedAt: entry.value.receivedAt,
          sourceVersion,
          cachedVersion,
          recommendation: "invalidate_and_refetch",
        });
      }
    }

    for (const [asset, entry] of this.assetMap.entries()) {
      scanned += 1;
      const sourceVersion = this.versionMap.get(`asset:${asset}`);
      const cachedVersion = entry.value.version;
      if (sourceVersion !== undefined && cachedVersion !== undefined && sourceVersion > cachedVersion) {
        push({
          key: `asset:${asset}`,
          kind: "asset_metadata",
          reason: "drift",
          cachedAt: entry.value.lastUpdated,
          sourceUpdatedAt: entry.value.lastUpdated,
          sourceVersion,
          cachedVersion,
          recommendation: "invalidate_and_refetch",
        });
      } else if (now.getTime() - entry.value.lastUpdated.getTime() > STALE_AGE_MS) {
        push({
          key: `asset:${asset}`,
          kind: "asset_metadata",
          reason: "stale",
          cachedAt: entry.value.lastUpdated,
          sourceUpdatedAt: entry.value.lastUpdated,
          sourceVersion,
          cachedVersion,
          recommendation: "invalidate_and_refetch",
        });
      }
    }

    for (const [key, entry] of this.configMap.entries()) {
      scanned += 1;
      const sourceVersion = this.versionMap.get(`config:${key}`);
      const cachedVersion = entry.value.version;
      if (sourceVersion !== undefined && cachedVersion !== undefined && sourceVersion > cachedVersion) {
        push({
          key: `config:${key}`,
          kind: "protocol_config",
          reason: "drift",
          cachedAt: entry.value.updatedAt,
          sourceUpdatedAt: entry.value.updatedAt,
          sourceVersion,
          cachedVersion,
          recommendation: "invalidate_and_refetch",
        });
      } else if (now.getTime() - entry.value.updatedAt.getTime() > STALE_AGE_MS) {
        push({
          key: `config:${key}`,
          kind: "protocol_config",
          reason: "stale",
          cachedAt: entry.value.updatedAt,
          sourceUpdatedAt: entry.value.updatedAt,
          sourceVersion,
          cachedVersion,
          recommendation: "invalidate_and_refetch",
        });
      }
    }

    if (
      this.redis &&
      this.isOnline &&
      (options.kind === undefined || options.kind === "checkpoint")
    ) {
      scanned += 1;
      const checkpoint = await this.inspectCheckpointCache();
      if (checkpoint) push(checkpoint);
    }

    // Redis: scan one bounded page per call so large tracked sets are never read in full.
    if (
      this.redis &&
      this.isOnline &&
      (options.kind === undefined || options.kind === "generic")
    ) {
      try {
        let trackedKeys: string[];
        if (options.keys !== undefined) {
          trackedKeys = options.keys.filter((key) => includes(key, "generic"));
        } else {
          const startingCursor = this.redisScanCursor;
          const [nextCursor, keys] = await this.redis.sscan(
            STALE_INDEX_KEY,
            this.redisScanCursor,
            "COUNT",
            Math.min(100, limit),
          );
          this.redisScanCursor = nextCursor;
          if (startingCursor !== "0" || nextCursor !== "0") complete = false;
          trackedKeys = keys;
        }
        for (const key of trackedKeys) {
          scanned += 1;
          if (stale.some((entry) => entry.key === key)) continue;
          const entry = await this.inspectGenericCacheEntry(key);
          if (entry) push(entry);
        }
      } catch (err) {
        this.logger.error({ err }, "Redis stale scan failed");
        throw err;
      }
    }

    if (totalFindings > limit) complete = false;
    return { entries: stale, scanned, complete };
  }

  private async inspectGenericCacheEntry(key: string): Promise<StaleCacheEntry | null> {
    if (!this.redis) return null;
    const raw = await this.redis.get(key);
    if (raw === null) {
      return {
        key,
        kind: "generic",
        reason: "missing",
        recommendation: "invalidate_and_refetch",
      };
    }

    const storedSourceVersion = await this.redis.hget("vaultquest:cache:versions", key);
    const parsedSourceVersion =
      storedSourceVersion !== null && /^\d+$/.test(storedSourceVersion)
        ? Number(storedSourceVersion)
        : undefined;
    const sourceVersion = this.versionMap.get(key) ?? parsedSourceVersion;
    if (sourceVersion === undefined || !Number.isSafeInteger(sourceVersion)) return null;

    let parsed: { version?: unknown; cachedAt?: unknown };
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return {
          key,
          kind: "generic",
          reason: "drift",
          recommendation: "review_before_repair",
          detail: "cache payload is not a JSON object",
        };
      }
      parsed = value as { version?: unknown; cachedAt?: unknown };
    } catch {
      return {
        key,
        kind: "generic",
        reason: "drift",
        recommendation: "review_before_repair",
        detail: "cache payload is not valid JSON",
      };
    }

    const cachedVersion = typeof parsed.version === "number" ? parsed.version : undefined;
    if (cachedVersion !== undefined && sourceVersion <= cachedVersion) return null;
    return {
      key,
      kind: "generic",
      reason: "drift",
      cachedAt: typeof parsed.cachedAt === "string" ? new Date(parsed.cachedAt) : undefined,
      sourceVersion,
      cachedVersion,
      recommendation: "invalidate_and_refetch",
    };
  }

  private async inspectCheckpointCache(): Promise<StaleCacheEntry | null> {
    if (!this.redis) return null;
    const dirty = await this.redis.get(CHECKPOINT_DIRTY_KEY);
    if (dirty === "true") return null;

    const raw = await this.redis.get(CHECKPOINT_KEY);
    if (raw === null) return null;
    const source = await this.prisma.indexerCheckpoint.findUnique({
      where: { id: "singleton" },
    });

    let cached: {
      latestLedger?: unknown;
      lastProcessedEventId?: unknown;
      lastSyncTime?: unknown;
      indexerVersion?: unknown;
    };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("checkpoint payload is not an object");
      }
      cached = parsed as typeof cached;
    } catch {
      return {
        key: CHECKPOINT_KEY,
        kind: "checkpoint",
        reason: "drift",
        sourceUpdatedAt: source?.lastSyncTime,
        sourceVersion: source?.latestLedger,
        recommendation: source ? "invalidate_and_refetch" : "review_before_repair",
        detail: "checkpoint cache payload is invalid",
      };
    }

    if (!source) {
      return {
        key: CHECKPOINT_KEY,
        kind: "checkpoint",
        reason: "drift",
        cachedAt: typeof cached.lastSyncTime === "string"
          ? new Date(cached.lastSyncTime)
          : undefined,
        cachedVersion: typeof cached.latestLedger === "number"
          ? cached.latestLedger
          : undefined,
        recommendation: "review_before_repair",
        detail: "cached checkpoint has no PostgreSQL source record",
      };
    }

    const cachedLedger = typeof cached.latestLedger === "number"
      ? cached.latestLedger
      : undefined;
    const cacheMatchesSource =
      cachedLedger === source.latestLedger &&
      (cached.lastProcessedEventId ?? null) === (source.lastProcessedEventId ?? null) &&
      (cached.indexerVersion ?? null) === (source.indexerVersion ?? null);
    if (cacheMatchesSource) return null;

    return {
      key: CHECKPOINT_KEY,
      kind: "checkpoint",
      reason: "drift",
      cachedAt: typeof cached.lastSyncTime === "string"
        ? new Date(cached.lastSyncTime)
        : undefined,
      sourceUpdatedAt: source.lastSyncTime,
      sourceVersion: source.latestLedger,
      cachedVersion: cachedLedger,
      recommendation: "invalidate_and_refetch",
      detail: "cached checkpoint does not match the PostgreSQL checkpoint",
    };
  }

  /**
   * Idempotent repair job. Detects stale entries and (unless `dryRun`) evicts
   * them so the next read repopulates from the source of truth. Running the
   * job repeatedly with no source changes is a no-op.
   *
   * @param options.dryRun - When true, only report what would be repaired
   * @param options.now - Reference time (injectable for tests)
   * @returns Repair summary
   */
  async repairStaleCache(options: {
    dryRun?: boolean;
    now?: Date;
    kind?: StaleCacheEntry["kind"];
    keys?: string[];
    limit?: number;
    auditNoop?: boolean;
  } = {}): Promise<RepairResult> {
    const dryRun = options.dryRun ?? true;
    const startedAt = new Date();
    const inspection = await this.inspectStale(options);
    const stale = inspection.entries;
    const result: RepairResult = {
      dryRun,
      scanned: inspection.scanned,
      complete: inspection.complete,
      stale,
      repaired: [],
      failed: [],
    };
    if (stale.length === 0 && options.auditNoop === false) return result;
    const run = await this.prisma.cacheRepairRun.create({
      data: {
        jobName: "redis-cache-repair",
        dryRun,
        detectedCount: stale.length,
        planJson: stale.map((entry) => ({
          key: entry.key,
          kind: entry.kind,
          reason: entry.reason,
          recommendation: entry.recommendation,
          detail: entry.detail ?? null,
          cachedAt: entry.cachedAt?.toISOString() ?? null,
          sourceUpdatedAt: entry.sourceUpdatedAt?.toISOString() ?? null,
          sourceVersion: entry.sourceVersion ?? null,
          cachedVersion: entry.cachedVersion ?? null,
        })) as Prisma.InputJsonValue,
        startedAt,
      },
      select: { id: true },
    });

    if (dryRun) {
      await this.prisma.cacheRepairRun.update({
        where: { id: run.id },
        data: { completedAt: new Date(), appliedJson: { repaired: [], failed: [] } },
      });
      this.logger.info({ stale: stale.length }, "Stale cache repair dry-run");
      return result;
    }

    for (const entry of stale) {
      try {
        await this.repairEntry(entry);
        result.repaired.push(entry.key);
      } catch (err) {
        result.failed.push({ key: entry.key, error: err instanceof Error ? err.message : String(err) });
        this.logger.warn({ err, key: entry.key }, "Failed to repair stale cache entry");
      }
    }

    await this.prisma.cacheRepairRun.update({
      where: { id: run.id },
      data: {
        repairedCount: result.repaired.length,
        failedCount: result.failed.length,
        appliedJson: {
          repaired: result.repaired,
          failed: result.failed,
        },
        errorDetail: result.failed.length > 0
          ? `${result.failed.length} cache entries could not be repaired`
          : null,
        completedAt: new Date(),
      },
    });
    this.logger.info({ repaired: result.repaired.length, failed: result.failed.length }, "Stale cache repair complete");
    return result;
  }

  private async repairEntry(entry: StaleCacheEntry): Promise<void> {
    if (entry.recommendation === "review_before_repair") {
      throw new Error(entry.detail ?? "Entry requires manual review before repair");
    }
    if (entry.kind === "generic" && !this.redisOnline) {
      throw new Error("Redis is unavailable; shared cache entry was not changed");
    }
    switch (entry.kind) {
      case "pending_event": {
        const txHash = entry.key.replace(/^pending_event:/, "");
        this.pendingMap.delete(txHash);
        if (this.redis && this.isOnline) {
          await this.redis.del(pendingEventKey(txHash));
          await this.redis.srem(STALE_INDEX_KEY, pendingEventKey(txHash));
        }
        return;
      }
      case "asset_metadata": {
        const asset = entry.key.replace(/^asset:/, "");
        this.assetMap.delete(asset);
        return;
      }
      case "protocol_config": {
        const key = entry.key.replace(/^config:/, "");
        this.configMap.delete(key);
        return;
      }
      case "generic": {
        if (!this.redis || !this.isOnline) {
          throw new Error("Redis is unavailable; shared cache entry was not changed");
        }
        await this.redis.del(entry.key);
        await this.redis.srem(STALE_INDEX_KEY, entry.key);
        return;
      }
      case "checkpoint": {
        if (!this.redis || !this.isOnline) {
          throw new Error("Redis is unavailable; shared cache entry was not changed");
        }
        const repaired = await this.redis.eval(
          REPAIR_CHECKPOINT_SCRIPT,
          3,
          CHECKPOINT_DIRTY_KEY,
          CHECKPOINT_KEY,
          STALE_INDEX_KEY,
          CHECKPOINT_KEY,
        );
        if (repaired !== 1) {
          throw new Error("Indexer checkpoint has an unsynced Redis write; repair was deferred");
        }
        return;
      }
    }
  }
}
