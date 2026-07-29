import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheService } from './cacheService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeMockPrisma() {
  return {
    indexerCheckpoint: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    pendingEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  } as any;
}

// A minimal in-memory Redis stand-in that tracks key→value pairs and TTLs.
function makeMockRedis(online: boolean = true) {
  const store = new Map<string, string>();
  return {
    _store: store,
    _online: online,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ex?: string, _ttl?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),
    quit: vi.fn(async () => 'OK'),
    on: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Patch CacheService so we can inject a fake Redis without a real URL.
// We reach into the private fields directly for test isolation.
// ---------------------------------------------------------------------------

function buildService(
  redis: ReturnType<typeof makeMockRedis> | null,
  isOnline = true
): CacheService {
  const svc = new CacheService(makeMockPrisma(), makeMockLogger(), 'redis://fake:0');
  // Override the private fields that the constructor tries to create.
  (svc as any).redis = redis;
  (svc as any).isOnline = isOnline;
  return svc;
}

// ---------------------------------------------------------------------------
// Tests: getOrSet
// ---------------------------------------------------------------------------

describe('CacheService.getOrSet', () => {
  it('returns the cached value on the second call without invoking fetch again', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    const fetch = vi.fn().mockResolvedValue({ balance: 42 });

    // First call — cache miss, fetch is called.
    const first = await svc.getOrSet('wallet:abc:balance', 60, fetch);
    expect(first).toEqual({ balance: 42 });
    expect(fetch).toHaveBeenCalledTimes(1);

    // Second call — cache hit, fetch must NOT be called again.
    const second = await svc.getOrSet('wallet:abc:balance', 60, fetch);
    expect(second).toEqual({ balance: 42 });
    expect(fetch).toHaveBeenCalledTimes(1); // still 1

    // Redis.get should have been called twice; Redis.set only once.
    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledTimes(1);
  });

  it('calls fetch on cache miss and stores the result', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    const fetch = vi.fn().mockResolvedValue([1, 2, 3]);
    const result = await svc.getOrSet('some:key', 120, fetch);

    expect(result).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledWith(
      'some:key',
      JSON.stringify([1, 2, 3]),
      'EX',
      120
    );
  });

  it('still returns the fetch result when Redis is offline (graceful degradation)', async () => {
    const svc = buildService(null, false); // no Redis
    const fetch = vi.fn().mockResolvedValue('fallback-value');

    const result = await svc.getOrSet('any:key', 30, fetch);
    expect(result).toBe('fallback-value');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('falls through to fetch when Redis.get throws, and logs a warning', async () => {
    const redis = makeMockRedis();
    redis.get.mockRejectedValueOnce(new Error('ECONNRESET'));

    const svc = buildService(redis);
    const logger = (svc as any).logger;
    const fetch = vi.fn().mockResolvedValue('fresh-data');

    const result = await svc.getOrSet('err:key', 60, fetch);
    expect(result).toBe('fresh-data');
    expect(fetch).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'err:key' }),
      expect.stringContaining('Redis get failed')
    );
  });

  it('serves the value when Redis.set throws, and logs a warning', async () => {
    const redis = makeMockRedis();
    redis.set.mockRejectedValueOnce(new Error('OOM'));

    const svc = buildService(redis);
    const logger = (svc as any).logger;
    const fetch = vi.fn().mockResolvedValue({ data: 'ok' });

    const result = await svc.getOrSet('set:fail:key', 60, fetch);
    expect(result).toEqual({ data: 'ok' }); // value still returned
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'set:fail:key' }),
      expect.stringContaining('Redis set failed')
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: invalidate
// ---------------------------------------------------------------------------

describe('CacheService.invalidate', () => {
  it('removes the key from Redis', async () => {
    const redis = makeMockRedis();
    const svc = buildService(redis);

    // Seed a value so we can verify removal.
    await svc.getOrSet('to:remove', 60, async () => 'cached');
    expect(redis._store.has('to:remove')).toBe(true);

    await svc.invalidate('to:remove');
    expect(redis.del).toHaveBeenCalledWith('to:remove');
    expect(redis._store.has('to:remove')).toBe(false);
  });

  it('is a no-op when Redis is offline (does not throw)', async () => {
    const svc = buildService(null, false);
    await expect(svc.invalidate('some:key')).resolves.toBeUndefined();
  });

  it('logs a warning and does not throw when Redis.del fails', async () => {
    const redis = makeMockRedis();
    redis.del.mockRejectedValueOnce(new Error('write error'));

    const svc = buildService(redis);
    const logger = (svc as any).logger;

    await expect(svc.invalidate('bad:key')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'bad:key' }),
      expect.stringContaining('Redis invalidate failed')
    );
  });
});
