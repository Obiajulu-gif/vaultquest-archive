import { beforeEach, describe, expect, it, vi } from "vitest";
import { VaultQueryClient } from "./queryClient";
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