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
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class VaultQueryClient {
  private readonly entries = new Map<string, CacheEntry<unknown>>();

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
    };
    this.entries.set(id, created as CacheEntry<unknown>);
    return created;
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
    if (entry.promise) return entry.promise;

    const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    entry.abortController = controller;

    entry.error = null;
    entry.partialError = null;
    this.notify(key);

    entry.promise = fetcher({ signal: controller?.signal as AbortSignal })
      .then((data) => {
        entry.data = data;
        entry.error = null;
        entry.partialError = null;
        entry.updatedAt = Date.now();
        entry.invalidated = false;
        return data;
      })
      .catch((err: unknown) => {
        const error = toError(err);
        if (entry.data === null) {
          entry.error = error;
        } else {
          entry.partialError = error;
        }
        throw error;
      })
      .finally(() => {
        entry.promise = null;
        this.notify(key);
      });

    this.notify(key);
    return entry.promise;
  }

  invalidateQueries(prefix: readonly unknown[]): void {
    this.entries.forEach((entry) => {
      if (queryKeyStartsWith(entry.key, prefix)) {
        entry.invalidated = true;
        entry.listeners.forEach((listener) => listener());
      }
    });
  }

  setQueryData<T>(key: readonly unknown[], data: T): void {
    const entry = this.getEntry<T>(key);
    entry.data = data;
    entry.error = null;
    entry.partialError = null;
    entry.updatedAt = Date.now();
    entry.invalidated = false;
    this.notify(key);
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
    client.invalidateQueries(memoKey);
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
  const stale = enabled ? client.isStale(memoKey, staleTimeMs) : false;
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
    stale: stale || (fetching && entry.data !== null),
    updatedAt: entry.updatedAt,
    refetch,
  };
}
