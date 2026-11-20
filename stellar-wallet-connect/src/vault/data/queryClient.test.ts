import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVaultQuery, VaultQueryClient } from "./queryClient";
import { vaultQueryKeys } from "./queryKeys";

interface BalanceDatum {
  total_deposits: number;
  account_balance: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function balance(amount: number): BalanceDatum {
  return { total_deposits: amount, account_balance: amount };
}

describe("VaultQueryClient ordering guarantees (#748)", () => {
  let client: VaultQueryClient;
  let key: readonly unknown[];

  beforeEach(() => {
    client = new VaultQueryClient();
    key = vaultQueryKeys.portfolio("0xabc");
  });

  it("drops an older-started in-flight fetch that resolves after a newer commit", async () => {
    const slow = deferred<BalanceDatum>();
    const inflight = client.fetchQuery(key, () => slow.promise);

    const fresh = balance(5000);
    client.setQueryData(key, fresh);

    slow.resolve(balance(1000));
    await inflight;

    expect(client.getQueryData(key)).toEqual(fresh);
  });

  it("does not surface a stale background failure after a newer commit", async () => {
    const slow = deferred<BalanceDatum>();
    const inflight = client.fetchQuery(key, () => slow.promise);

    const fresh = balance(2000);
    client.setQueryData(key, fresh);

    slow.reject(new Error("RPC out-of-order failure"));
    await expect(inflight).rejects.toThrow("RPC out-of-order failure");

    expect(client.getQueryData(key)).toEqual(fresh);
    expect(client.getEntry(key).error).toBeNull();
    expect(client.getEntry(key).partialError).toBeNull();
  });

  it("surfaces a failure when nothing newer committed for the key", async () => {
    const failing = deferred<BalanceDatum>();
    const inflight = client.fetchQuery(key, () => failing.promise);

    failing.reject(new Error("RPC down"));
    await expect(inflight).rejects.toThrow("RPC down");

    const entry = client.getEntry(key);
    expect(entry.error).toEqual(new Error("RPC down"));
    expect(entry.data).toBeNull();
  });

  it("keeps prior data usable (partial error) for a failed refetch", async () => {
    const first = deferred<BalanceDatum>();
    client.fetchQuery(key, () => first.promise);
    first.resolve(balance(1000));
    await Promise.resolve();

    const entry = client.getEntry(key);
    expect(entry.data).toEqual(balance(1000));

    const refetch = deferred<BalanceDatum>();
    client.invalidateQueries(["vaultquest", "portfolio"]);
    const inflight = client.fetchQuery(key, () => refetch.promise);
    refetch.reject(new Error("RPC timeout"));
    await expect(inflight).rejects.toThrow("RPC timeout");

    expect(entry.data).toEqual(balance(1000));
    expect(entry.partialError).toEqual(new Error("RPC timeout"));
    expect(entry.error).toBeNull();
  });

  it("lets a newer-started fetch commit and override an older optimistic write", async () => {
    const earlier = deferred<BalanceDatum>();
    client.fetchQuery(key, () => earlier.promise);
    earlier.resolve(balance(3000));
    await Promise.resolve();

    client.setQueryData(key, balance(4000));

    const newer = deferred<BalanceDatum>();
    const inflight = client.fetchQuery(key, () => newer.promise);

    newer.resolve(balance(5000));
    await inflight;
    await Promise.resolve();

    expect(client.getQueryData(key)).toEqual(balance(5000));
  });
});

describe("VaultQueryClient monotonic external updates (#749)", () => {
  let client: VaultQueryClient;

  beforeEach(() => {
    client = new VaultQueryClient();
    vi.useFakeTimers?.();
  });

  it("rejects an out-of-order external update older than the committed value", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    const accepted = client.setQueryDataAt(key, balance(5000), 200);

    expect(accepted).toBe(true);
    expect(client.setQueryDataAt(key, balance(1000), 100)).toBe(false);
    expect(client.getQueryData(key)).toEqual(balance(5000));
    expect(client.getEntry(key).updatedAt).toBe(200);
  });

  it("applies a newer external update and bumps the commit order", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    client.setQueryDataAt(key, balance(1000), 100);

    const accepted = client.setQueryDataAt(key, balance(2000), 200);
    expect(accepted).toBe(true);
    expect(client.getQueryData(key)).toEqual(balance(2000));
  });

  it("rehydrates an empty cache from an external update", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    const accepted = client.setQueryDataAt(key, balance(2500), 777);

    expect(accepted).toBe(true);
    expect(client.getQueryData(key)).toEqual(balance(2500));
    expect(client.getEntry(key).updatedAt).toBe(777);
  });

  it("emits commit events only when emit is enabled", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    const onCommitted = vi.fn();
    client.onDataCommitted((k, data, updatedAt) => onCommitted(k, data, updatedAt));

    client.setQueryDataAt(key, balance(100), 100, { emit: false });
    expect(onCommitted).not.toHaveBeenCalled();

    client.setQueryDataAt(key, balance(200), 200, { emit: true });
    expect(onCommitted).toHaveBeenCalledTimes(1);
    const [k, data, updatedAt] = onCommitted.mock.calls[0];
    expect(k).toEqual(key);
    expect(data).toEqual(balance(200));
    expect(updatedAt).toBe(200);
  });

  it("dropped commits never fire listener events", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    client.setQueryDataAt(key, balance(5000), 200);

    const onCommitted = vi.fn();
    client.onDataCommitted((k, data, updatedAt) => onCommitted(k, data, updatedAt));

    const accepted = client.setQueryDataAt(key, balance(1000), 100);
    expect(accepted).toBe(false);
    expect(onCommitted).not.toHaveBeenCalled();
  });
});

describe("VaultQueryClient invalidation, stale detection and bounds (#1129)", () => {
  const STALE_MS = 60_000;
  let client: VaultQueryClient;
  let key: readonly unknown[];

  beforeEach(() => {
    client = new VaultQueryClient();
    key = vaultQueryKeys.account("GWALLETA");
  });

  it("still shares one fetch between concurrent readers when nothing changed", async () => {
    const pending = deferred<BalanceDatum>();
    const fetcher = vi.fn(() => pending.promise);

    const first = client.fetchQuery(key, fetcher);
    const second = client.fetchQuery(key, fetcher);

    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending.resolve(balance(100));
    await first;
    expect(client.isStale(key, STALE_MS)).toBe(false);
  });

  it("starts a fresh fetch after invalidation instead of joining the pre-invalidation one", async () => {
    const before = deferred<BalanceDatum>();
    const beforeFetch = client.fetchQuery(key, () => before.promise);

    client.invalidateQueries(vaultQueryKeys.account("GWALLETA"));
    const after = deferred<BalanceDatum>();
    const afterFetch = client.fetchQuery(key, () => after.promise);
    expect(afterFetch).not.toBe(beforeFetch);

    // The pre-invalidation response lands first: it must not commit or clear staleness.
    before.resolve(balance(1000));
    await beforeFetch;
    expect(client.getQueryData(key)).toBeNull();
    expect(client.isStale(key, STALE_MS)).toBe(true);
    expect(client.getEntry(key).promise).not.toBeNull();

    after.resolve(balance(2000));
    await afterFetch;
    expect(client.getQueryData(key)).toEqual(balance(2000));
    expect(client.isStale(key, STALE_MS)).toBe(false);
    expect(client.getEntry(key).promise).toBeNull();
  });

  it("drops a pre-invalidation response that arrives after the fresh one", async () => {
    const before = deferred<BalanceDatum>();
    const beforeFetch = client.fetchQuery(key, () => before.promise);
    client.invalidateQueries(key);
    const after = deferred<BalanceDatum>();
    const afterFetch = client.fetchQuery(key, () => after.promise);

    after.resolve(balance(2000));
    await afterFetch;
    before.resolve(balance(1000));
    await beforeFetch;

    expect(client.getQueryData(key)).toEqual(balance(2000));
    expect(client.isStale(key, STALE_MS)).toBe(false);
  });

  it("does not surface a pre-invalidation failure, then recovers on retry", async () => {
    client.setQueryData(key, balance(500));
    const before = deferred<BalanceDatum>();
    const beforeFetch = client.fetchQuery(key, () => before.promise);
    client.invalidateQueries(key);

    before.reject(new Error("RPC timeout from before the deposit"));
    await expect(beforeFetch).rejects.toThrow("RPC timeout");
    expect(client.getEntry(key).partialError).toBeNull();
    expect(client.isStale(key, STALE_MS)).toBe(true);

    const failing = deferred<BalanceDatum>();
    const failed = client.fetchQuery(key, () => failing.promise);
    failing.reject(new Error("RPC down"));
    await expect(failed).rejects.toThrow("RPC down");
    expect(client.getEntry(key).partialError).toEqual(new Error("RPC down"));
    expect(client.getQueryData(key)).toEqual(balance(500));
    expect(client.isStale(key, STALE_MS)).toBe(true);

    await client.fetchQuery(key, async () => balance(900));
    expect(client.getEntry(key).partialError).toBeNull();
    expect(client.getQueryData(key)).toEqual(balance(900));
    expect(client.isStale(key, STALE_MS)).toBe(false);
  });

  it("scopes invalidation to the wallet's own keys", () => {
    const other = vaultQueryKeys.account("GWALLETB");
    client.setQueryData(key, balance(1));
    client.setQueryData(other, balance(2));

    client.invalidateQueries(vaultQueryKeys.account("GWALLETA"));

    expect(client.isStale(key, STALE_MS)).toBe(true);
    expect(client.isStale(other, STALE_MS)).toBe(false);
  });

  it("evicts the oldest unused entry once the cap is reached", () => {
    const bounded = new VaultQueryClient(2);
    const a = vaultQueryKeys.pool("a");
    const b = vaultQueryKeys.pool("b");
    bounded.setQueryData(a, balance(1));
    bounded.setQueryData(b, balance(2));

    bounded.setQueryData(vaultQueryKeys.pool("c"), balance(3));

    expect(bounded.getQueryData(b)).toEqual(balance(2));
    // `a` was evicted, so reading it back starts from an empty, stale entry.
    expect(bounded.getQueryData(a)).toBeNull();
    expect(bounded.isStale(a, STALE_MS)).toBe(true);
  });

  it("never evicts an entry that is subscribed or still loading", async () => {
    const bounded = new VaultQueryClient(2);
    const watched = vaultQueryKeys.pool("watched");
    const loading = vaultQueryKeys.pool("loading");
    bounded.setQueryData(watched, balance(1));
    const unsubscribe = bounded.subscribe(watched, () => undefined);
    const pending = deferred<BalanceDatum>();
    const inflight = bounded.fetchQuery(loading, () => pending.promise);

    bounded.setQueryData(vaultQueryKeys.pool("extra"), balance(3));
    pending.resolve(balance(2));
    await inflight;

    expect(bounded.getQueryData(watched)).toEqual(balance(1));
    expect(bounded.getQueryData(loading)).toEqual(balance(2));
    unsubscribe();
  });
});

describe("useVaultQuery polling (#1129)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps saving poll results when the backend answers slower than the poll interval", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn(
      () =>
        new Promise<BalanceDatum>((resolve) => {
          calls += 1;
          const answer = balance(calls);
          setTimeout(() => resolve(answer), 250);
        }),
    );

    const { result, unmount } = renderHook(() =>
      useVaultQuery({
        key: vaultQueryKeys.transaction("slow-poll"),
        staleTimeMs: 0,
        refetchIntervalMs: 100,
        fetcher,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(result.current.data).not.toBeNull();
    // Polls that land while a request runs join it rather than stacking new ones.
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
    unmount();
  });
});