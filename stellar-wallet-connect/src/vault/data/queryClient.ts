import { useCallback, useEffect, useMemo, useState } from "react";
import { queryKeyStartsWith, serializeQueryKey } from "./queryKeys";

export type QueryStatus = "idle" | "loading" | "success" | "error";

export interface QueryState<T> {
  data: T | null;
  error: Error | null;
  /** Background refetch failed while previous data is still usable. */
  partialError: Error | null;
  status: QueryStatus;
  loading: boolean;
  fetching: boolean;
  stale: boolean;
  updatedAt: number | null;
  refetch: () => void;
}

export interface VaultQueryOptions<T> {
  key: readonly unknown[];
  enabled?: boolean;
  staleTimeMs?: number;
  refetchIntervalMs?: number;
  fetcher: (opts: { signal: AbortSignal }) => Promise<T>;
}

type Listener = () => void;

interface CacheEntry<T> {
  key: readonly unknown[];
  data: T | null;
  error: Error | null;
  partialError: Error | null;
  updatedAt: number | null;
  promise: Promise<T> | null;
  invalidated: boolean;
  listeners: Set<Listener>;
  abortController?: AbortController;
  /**
   * The global operation sequence that last committed data for this key
   * (#748). Commits only ever move forward: a fetch or external update that
   * was *started* before a newer commit resolves is dropped instead of
   * rolling the dashboard back to stale/out-of-order balances.
   */
  committedSeq: number;
  /** Sequence of the latest `invalidateQueries` hit; fetches started before it are stale. */
  invalidatedSeq: number;
  /** Sequence at which the in-flight `promise` started. */
  promiseSeq: number;
}

/** Default cap on cached keys; entries with subscribers or an in-flight fetch are never evicted. */
export const DEFAULT_MAX_QUERY_ENTRIES = 200;

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Global monotonic sequence shared across every key so all commits have a total order. */
let globalOpSeq = 0;

export type DataCommittedListener = (key: readonly unknown[], data: unknown, updatedAt: number) => void;

export class VaultQueryClient {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly commitListeners = new Set<DataCommittedListener>();

  constructor(private readonly maxEntries = DEFAULT_MAX_QUERY_ENTRIES) {}

  getEntry<T>(key: readonly unknown[]): CacheEntry<T> {
    const id = serializeQueryKey(key);
    const existing = this.entries.get(id) as CacheEntry<T> | undefined;
    if (existing) return existing;

    const created: CacheEntry<T> = {
      key,
      data: null,
      error: null,
      partialError: null,
      updatedAt: null,
      promise: null,
      invalidated: false,
      listeners: new Set(),
      abortController: undefined,
      committedSeq: 0,
      invalidatedSeq: 0,
      promiseSeq: 0,
    };
    this.evictInactive();
    this.entries.set(id, created as CacheEntry<unknown>);
    return created;
  }

  /**
   * Keeps the cache bounded before a new key is added: drops the oldest
   * entries nothing is rendering (no subscribers) and nothing is loading (no
   * in-flight fetch). A dropped key refetches the next time a view asks for
   * it. If every entry is in use the cache may exceed the cap until they free up.
   */
  private evictInactive(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size < this.maxEntries) return;
      if (entry.listeners.size === 0 && entry.promise === null) {
        this.entries.delete(id);
      }
    }
  }

  /** True when no commit or invalidation happened after the operation started at `seq`. */
  private isCurrent(entry: CacheEntry<unknown>, seq: number): boolean {
    return seq > entry.committedSeq && seq > entry.invalidatedSeq;
  }

  /**
   * Registers a listener invoked whenever a key commits new data (a resolved
   * fetch, an optimistic write, or an external cross-tab/device sync). Used
   * by the dashboard consistency layer (#749) to fan out cache updates.
   */
  onDataCommitted(listener: DataCommittedListener): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  private emitDataCommitted(key: readonly unknown[], data: unknown, updatedAt: number): void {
    this.commitListeners.forEach((listener) => listener(key, data, updatedAt));
  }

  getQueryData<T>(key: readonly unknown[]): T | null {
    return this.getEntry<T>(key).data;
  }

  subscribe(key: readonly unknown[], listener: Listener): () => void {
    const entry = this.getEntry(key);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }

  notify(key: readonly unknown[]): void {
    const id = serializeQueryKey(key);
    const entry = this.entries.get(id);
    if (entry) {
      entry.listeners.forEach((listener) => listener());
    }
  }

  isStale(key: readonly unknown[], staleTimeMs: number): boolean {
    const entry = this.getEntry(key);
    if (entry.invalidated || entry.updatedAt === null) return true;
    return Date.now() - entry.updatedAt > staleTimeMs;
  }

  fetchQuery<T>(key: readonly unknown[], fetcher: (opts: { signal: AbortSignal }) => Promise<T>): Promise<T> {
    const entry = this.getEntry<T>(key);
    // #1129 — only join an in-flight fetch that started after the latest
    // commit and invalidation; an older one would hand back pre-invalidation data.
    if (entry.promise && this.isCurrent(entry, entry.promiseSeq)) return entry.promise;

    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    entry.abortController = controller;

    // #748 — snapshot the operation order now so that, if this fetch resolves
    // after a *newer* commit (another fetch that started later, or an external
    // cross-tab/device sync), it is dropped rather than regressing the cache.
    // #1129 — the same applies when the key was invalidated after this fetch started.
    const startedSeq = ++globalOpSeq;
    entry.promiseSeq = startedSeq;

    entry.error = null;
    entry.partialError = null;
    this.notify(key);

    const promise: Promise<T> = fetcher({ signal: controller?.signal as AbortSignal })
      .then((data) => {
        if (this.isCurrent(entry, startedSeq)) {
          this.commitData(key, data, Date.now());
        }
        return data;
      })
      .catch((err: unknown) => {
        const error = toError(err);
        // Only surface errors from the freshest eligible operation — an older
        // in-flight failure must not clobber a newer successful commit.
        if (this.isCurrent(entry, startedSeq)) {
          if (entry.data === null) {
            entry.error = error;
          } else {
            entry.partialError = error;
          }
        }
        throw error;
      })
      .finally(() => {
        // A newer fetch may have replaced this one; leave its promise alone.
        if (entry.promise === promise) entry.promise = null;
        this.notify(key);
      });

    entry.promise = promise;
    this.notify(key);
    return promise;
  }

  invalidateQueries(prefix: readonly unknown[]): void {
    this.entries.forEach((entry) => {
      if (queryKeyStartsWith(entry.key, prefix)) {
        entry.invalidated = true;
        entry.invalidatedSeq = ++globalOpSeq;
        entry.listeners.forEach((listener) => listener());
      }
    });
  }

  setQueryData<T>(key: readonly unknown[], data: T): void {
    this.commitData(key, data, Date.now());
  }

  /**
   * Monotonic commit used by the dashboard consistency layer (#749): applies
   * `data` only when its intrinsic observation time (`updatedAt`) is newer
   * than the currently committed value for `key`, guaranteeing stale or
   * out-of-order updates from other tabs/devices can never roll the dashboard
   * backward. `emit` suppresses fan-out when the update is itself the result
   * of a sync (preventing echo/cross-talk loops).
   */
  setQueryDataAt<T>(key: readonly unknown[], data: T, updatedAt: number, options: { emit?: boolean } = {}): boolean {
    const entry = this.getEntry<T>(key);
    if (entry.data !== null && updatedAt < (entry.updatedAt ?? 0)) {
      return false;
    }
    this.commitData(key, data, updatedAt, options.emit ?? true);
    return true;
  }

  private commitData<T>(key: readonly unknown[], data: T, updatedAt: number, emit = true): void {
    const entry = this.getEntry<T>(key);
    entry.data = data;
    entry.error = null;
    entry.partialError = null;
    entry.updatedAt = updatedAt;
    entry.invalidated = false;
    // A commit is the freshest point in the total order — any in-flight fetch
    // that started earlier is now out-of-date and must be dropped (#748).
    entry.committedSeq = ++globalOpSeq;
    this.notify(key);
    if (emit) {
      this.emitDataCommitted(key, data, updatedAt);
    }
  }

  clear(): void {
    this.entries.forEach((entry) => entry.abortController?.abort());
    this.entries.clear();
  }
}

export const vaultQueryClient = new VaultQueryClient();

export function useVaultQuery<T>({
  key,
  enabled = true,
  staleTimeMs = 30_000,
  refetchIntervalMs,
  fetcher,
}: VaultQueryOptions<T>): QueryState<T> {
  const client = vaultQueryClient;
  const [, forceRender] = useState(0);
  const keyId = serializeQueryKey(key);
  const memoKey = useMemo(() => key, [keyId]);

  const refetch = useCallback(() => {
    if (!enabled) return;
    // Join a request that is already running instead of invalidating it: a poll
    // shorter than the response time would otherwise drop every answer (#1129).
    if (!client.getEntry(memoKey).promise) client.invalidateQueries(memoKey);
    void client.fetchQuery(memoKey, fetcher).catch(() => undefined);
  }, [client, enabled, fetcher, memoKey]);

  useEffect(() => client.subscribe(memoKey, () => forceRender((tick) => tick + 1)), [client, memoKey]);

  useEffect(() => {
    if (!enabled) return;
    if (client.isStale(memoKey, staleTimeMs)) {
      void client.fetchQuery(memoKey, fetcher).catch(() => undefined);
    }
  }, [client, enabled, fetcher, memoKey, staleTimeMs]);

  useEffect(() => {
    if (!enabled || !refetchIntervalMs) return undefined;
    const id = window.setInterval(() => {
      refetch();
    }, refetchIntervalMs);
    return () => window.clearInterval(id);
  }, [enabled, refetch, refetchIntervalMs]);

  const entry = client.getEntry<T>(memoKey);
  // #748 — staleness describes the committed data, not the act of refreshing:
  // a background refetch that lands within the stale window no longer flashes
  // a "stale" badge (and possibly a flickering widget) while data is still
  // current. `fetching` stays separately observable for spinners.
  const stale = enabled && client.isStale(memoKey, staleTimeMs);
  const loading = enabled && entry.data === null && entry.error === null;
  const fetching = Boolean(entry.promise);
  const status: QueryStatus = !enabled
    ? "idle"
    : entry.error
      ? "error"
      : entry.data === null
        ? "loading"
        : "success";

  return {
    data: entry.data,
    error: entry.error,
    partialError: entry.partialError,
    status,
    loading,
    fetching,
    stale,
    updatedAt: entry.updatedAt,
    refetch,
  };
}
