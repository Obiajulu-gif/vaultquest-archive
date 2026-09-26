import { beforeEach, describe, expect, it } from "vitest";
import { VaultQueryClient } from "./queryClient";
import { vaultQueryKeys } from "./queryKeys";
import {
  CACHE_SNAPSHOT_STORAGE_KEY,
  CACHE_SNAPSHOT_VERSION,
  createVaultCacheSync,
  getCacheScope,
  type BroadcastChannelLike,
  type StorageLike,
} from "./consistency";

interface BalanceDatum {
  total_deposits: number;
  account_balance: number;
}

function balance(amount: number): BalanceDatum {
  return { total_deposits: amount, account_balance: amount };
}

class FakeStorage implements StorageLike {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  contents(): Record<string, string> {
    return Object.fromEntries(this.store);
  }
}

class FakeChannel implements BroadcastChannelLike {
  private readonly handlers = new Set<(event: { data: unknown }) => void>();
  readonly messages: unknown[] = [];

  postMessage(message: unknown): void {
    this.messages.push(message);
    this.handlers.forEach((handler) => handler({ data: message }));
  }

  addEventListener(_type: string, handler: (event: { data: unknown }) => void): void {
    this.handlers.add(handler);
  }

  removeEventListener(_type: string, handler: (event: { data: unknown }) => void): void {
    this.handlers.delete(handler);
  }

  close(): void {
    this.handlers.clear();
  }
}

describe("cross-tab / cross-device dashboard consistency (#749)", () => {
  let clientA: VaultQueryClient;
  let clientB: VaultQueryClient;
  let storage: FakeStorage;
  let channel: FakeChannel;

  beforeEach(() => {
    clientA = new VaultQueryClient();
    clientB = new VaultQueryClient();
    storage = new FakeStorage();
    channel = new FakeChannel();
  });

  const mountA = () => createVaultCacheSync(clientA, { channel, storage, tabId: "tab-a" });
  const mountB = () => createVaultCacheSync(clientB, { channel, storage, tabId: "tab-b" });

  it("rehydrates a fresh tab from the persisted snapshot before any query fires", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    const snapshot = {
      version: CACHE_SNAPSHOT_VERSION,
      scope: getCacheScope(),
      entries: { [JSON.stringify(key)]: { data: balance(1250), updatedAt: 900 } },
    };
    storage.setItem(CACHE_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));

    const sync = createVaultCacheSync(clientA, { channel, storage, tabId: "tab-a" });

    expect(clientA.getQueryData(key)).toEqual(balance(1250));
    expect(clientA.getEntry(key).updatedAt).toBe(900);
    sync.dispose();
  });

  it("ignores mismatched-version / mismatched-scope snapshots", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    storage.setItem(
      CACHE_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({ version: 99, scope: getCacheScope(), entries: { [JSON.stringify(key)]: { data: balance(999), updatedAt: 900 } } }),
    );
    storage.setItem(
      `${CACHE_SNAPSHOT_STORAGE_KEY}.badscope`,
      JSON.stringify({ version: CACHE_SNAPSHOT_VERSION, scope: `${getCacheScope()}-other`, entries: { [JSON.stringify(key)]: { data: balance(888), updatedAt: 900 } } }),
    );
    const sync = createVaultCacheSync(clientA, { channel, storage, tabId: "tab-a" });

    expect(clientA.getQueryData(key)).toBeNull();
    sync.dispose();
  });

  it("fans a committed update out to other tabs", () => {
    mountA();
    mountB();
    const key = vaultQueryKeys.portfolio("0xabc");

    clientA.setQueryData(key, balance(7777));

    const message = channel.messages[0] as { type: string; key: string; data: BalanceDatum; updatedAt: number; tabId: string };
    expect(message.type).toBe("cache_update");
    expect(message.tabId).toBe("tab-a");
    expect(channel.messages.length).toBe(1);
    expect(clientB.getQueryData(key)).toEqual(balance(7777));
  });

  it("does not echo a received update back onto the channel", () => {
    mountA();
    mountB();
    const key = vaultQueryKeys.portfolio("0xabc");

    clientA.setQueryData(key, balance(1234));

    expect(channel.messages.length).toBe(1);
    expect(clientB.getQueryData(key)).toEqual(balance(1234));
  });

  it("drops an out-of-order broadcast that is older than the local value", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    clientB.setQueryDataAt(key, balance(9000), 900);
    mountA();
    mountB();

    clientA.setQueryDataAt(key, balance(1000), 100);

    expect(channel.messages.length).toBe(1);
    expect(clientB.getQueryData(key)).toEqual(balance(9000));
  });

  it("applies the last-writer-wins update when timestamps race", () => {
    mountA();
    mountB();
    const key = vaultQueryKeys.portfolio("0xabc");
    clientA.setQueryDataAt(key, balance(2000), 200);
    clientB.setQueryDataAt(key, balance(3000), 300);

    const message = channel.messages[channel.messages.length - 1] as { updatedAt: number };
    expect(message.updatedAt).toBe(300);
    expect(clientB.getQueryData(key)).toEqual(balance(3000));
    expect(clientA.getQueryData(key)).toEqual(balance(3000));
  });

  it("converges through the storage-event fallback when channels are unavailable", () => {
    const key = vaultQueryKeys.portfolio("0xabc");
    let storageListener = () => {};
    const storageFallback = (handler: () => void): (() => void) => {
      storageListener = handler;
      return () => {
        storageListener = () => {};
      };
    };

    const tabReceive = createVaultCacheSync(clientB, {
      channel: null,
      storage,
      subscribeStorage: storageFallback,
      tabId: "tab-b",
    });

    storage.setItem(
      CACHE_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({
        version: CACHE_SNAPSHOT_VERSION,
        scope: getCacheScope(),
        entries: { [JSON.stringify(key)]: { data: balance(5555), updatedAt: 600 } },
      }),
    );
    storageListener();

    expect(clientB.getQueryData(key)).toEqual(balance(5555));
    tabReceive.dispose();
  });

  it("degrades silently when no channel or storage is available", () => {
    const sync = createVaultCacheSync(clientA, { channel: null, storage: null, tabId: "tab-a" });
    const key = vaultQueryKeys.portfolio("0xabc");

    expect(() => clientA.setQueryData(key, balance(1))).not.toThrow();
    expect(clientA.getQueryData(key)).toEqual(balance(1));
    expect(() => sync.dispose()).not.toThrow();
  });

  it("persists committed entries to the snapshot for later tabs", () => {
    mountA();
    const key = vaultQueryKeys.portfolio("0xabc");

    clientA.setQueryData(key, balance(4242));

    const persisted = JSON.parse(storage.getItem(CACHE_SNAPSHOT_STORAGE_KEY) ?? "null") as {
      version: number;
      entries: Record<string, { data: BalanceDatum; updatedAt: number }>;
    };
    expect(persisted.version).toBe(CACHE_SNAPSHOT_VERSION);
    expect(persisted.entries[JSON.stringify(key)].data).toEqual(balance(4242));
  });
});