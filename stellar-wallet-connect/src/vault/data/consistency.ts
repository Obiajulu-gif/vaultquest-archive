/**
 * Cross-tab / cross-device dashboard consistency (#749).
 *
 * Enforces the guarantees documented in `docs/DASHBOARD_CONSISTENCY.md`:
 *
 *  1. Monotonicity — committed balance/portfolio data for a given cache key
 *     only ever moves forward: any update whose intrinsic observation time
 *     (`updatedAt`) is older than the currently committed value is dropped.
 *     A stale or out-of-order update arriving from a background refetch, an
 *     older in-flight request, another tab, or another device can never roll
 *     the dashboard backward (this composes with the fetch ordering guard in
 *     `./queryClient` from #748).
 *
 *  2. Last-writer-wins with deterministic ordering — when two writers race,
 *     the update with the greater `updatedAt` wins; an update that a writer
 *     merely *received* is never re-broadcast, so there are no echo loops.
 *
 *  3. Fresh-tab convergence — a newly opened tab rehydrates from the persisted
 *     snapshot before firing its own queries, so it starts from the latest
 *     known dashboard state instead of flashing a blank or older baseline.
 *
 *  4. Silent degradation — if BroadcastChannel, localStorage or JSON
 *     serialization is unavailable, the app keeps working with plain in-tab
 *     caching and never throws.
 */

import { vaultQueryClient, type VaultQueryClient } from "./queryClient";
import { serializeQueryKey } from "./queryKeys";

export const CACHE_SYNC_CHANNEL = "vaultquest.cache.sync.v1";
export const CACHE_SNAPSHOT_STORAGE_KEY = "vaultquest.cache.snapshot.v1";
export const CACHE_SNAPSHOT_VERSION = 1 as const;

export interface CacheSyncMessage {
  type: "cache_update";
  key: string;
  data: unknown;
  updatedAt: number;
  tabId: string;
}

export interface VaultCacheSnapshotEntry {
  data: unknown;
  updatedAt: number;
}

export interface VaultCacheSnapshot {
  version: typeof CACHE_SNAPSHOT_VERSION;
  scope: string;
  entries: Record<string, VaultCacheSnapshotEntry>;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  close(): void;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface VaultCacheSyncDeps {
  channel?: BroadcastChannelLike | null;
  storage?: StorageLike | null;
  /** Cross-tab storage change subscription (window `storage` event in browsers). */
  subscribeStorage?: (handler: () => void) => () => void;
  tabId?: string;
}

export interface VaultCacheSync {
  dispose: () => void;
}

export function getCacheScope(): string {
  if (typeof location !== "undefined" && typeof location.origin === "string") {
    return location.origin;
  }
  return "vaultquest";
}

function makeTabId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseKey(serialized: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [serialized];
  }
}

function emptySnapshot(scope: string): VaultCacheSnapshot {
  return { version: CACHE_SNAPSHOT_VERSION, scope, entries: {} };
}

function readSnapshot(storage: StorageLike | null | undefined, scope: string): VaultCacheSnapshot {
  if (!storage) return emptySnapshot(scope);
  try {
    const raw = storage.getItem(CACHE_SNAPSHOT_STORAGE_KEY);
    if (!raw) return emptySnapshot(scope);
    const parsed = JSON.parse(raw) as Partial<VaultCacheSnapshot>;
    if (parsed?.version !== CACHE_SNAPSHOT_VERSION || (parsed.scope && parsed.scope !== scope)) {
      return emptySnapshot(scope);
    }
    return { version: CACHE_SNAPSHOT_VERSION, scope, entries: parsed.entries ?? {} };
  } catch {
    return emptySnapshot(scope);
  }
}

function writeSnapshot(storage: StorageLike | null | undefined, scope: string, snapshot: VaultCacheSnapshot): void {
  if (!storage) return;
  try {
    storage.setItem(CACHE_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded or storage disabled — keep running without persistence.
  }
}

/**
 * Reapplies the persisted snapshot onto the local cache. Used on initial
 * creation (fresh-tab convergence) and whenever another tab writes a new
 * snapshot (storage event fallback). Only moves entries forward via the
 * monotonic `setQueryDataAt`, so a stale snapshot can't regress live data.
 */
function applySnapshot(
  client: VaultQueryClient,
  storage: StorageLike | null | undefined,
  scope: string,
): void {
  const snapshot = readSnapshot(storage, scope);
  for (const [serializedKey, entry] of Object.entries(snapshot.entries)) {
    if (
      entry &&
      typeof entry.updatedAt === "number" &&
      Number.isFinite(entry.updatedAt) &&
      entry.data !== undefined
    ) {
      client.setQueryDataAt(parseKey(serializedKey), entry.data, entry.updatedAt, { emit: false });
    }
  }
}

export function createVaultCacheSync(
  client: VaultQueryClient,
  deps: VaultCacheSyncDeps = {},
): VaultCacheSync {
  const tabId = deps.tabId ?? makeTabId();
  const scope = getCacheScope();
  const channel = deps.channel ?? null;
  const storage = deps.storage ?? null;

  // Guarantee 3 — converge a fresh tab/device to the last known state before
  // its own queries run.
  applySnapshot(client, storage, scope);

  const persist = (serializedKey: string, data: unknown, updatedAt: number): void => {
    if (!storage) return;
    let json: string;
    try {
      json = JSON.stringify(data);
    } catch {
      return; // Non-serializable payload — never persisted.
    }
    const next = readSnapshot(storage, scope);
    next.entries[serializedKey] = { data: JSON.parse(json), updatedAt };
    writeSnapshot(storage, scope, next);
  };

  const emit = (key: readonly unknown[], data: unknown, updatedAt: number): void => {
    const serializedKey = serializeQueryKey(key);
    persist(serializedKey, data, updatedAt);
    if (channel) {
      const message: CacheSyncMessage = { type: "cache_update", key: serializedKey, data, updatedAt, tabId };
      try {
        channel.postMessage(message);
      } catch {
        // Channel unavailable — ignore.
      }
    }
  };

  const unbindCommit = client.onDataCommitted(emit);

  const onMessage = (event: { data: unknown }): void => {
    const message = event.data as CacheSyncMessage | undefined;
    if (!message || message.type !== "cache_update" || message.tabId === tabId) return;
    const key = parseKey(message.key);
    const entry = client.getEntry(key);
    const current = entry.updatedAt ?? 0;
    // Guarantee 1 & 2 — monotonic, last-writer-wins with no echo loops: apply
    // the update locally without re-broadcasting what we merely received.
    if (message.updatedAt <= current) return;
    client.setQueryDataAt(key, message.data, message.updatedAt, { emit: false });
    persist(message.key, message.data, message.updatedAt);
  };

  let unbindChannel = (): void => {};
  if (channel) {
    channel.addEventListener("message", onMessage);
    unbindChannel = () => channel.removeEventListener("message", onMessage);
  }

  const unbindStorage = deps.subscribeStorage
    ? deps.subscribeStorage(() => applySnapshot(client, storage, scope))
    : (): void => {};

  return {
    dispose: () => {
      unbindCommit();
      unbindChannel();
      unbindStorage();
      try {
        channel?.close();
      } catch {
        // ignore
      }
    },
  };
}

let ensureStarted = false;

/**
 * Wires the cross-tab/device consistency layer for the shared
 * {@link vaultQueryClient} exactly once. Safe to call from app boot on the
 * client; a no-op during SSR. Returns null when already wired or not browser.
 */
export function ensureVaultCacheSync(
  client: VaultQueryClient = vaultQueryClient,
): VaultCacheSync | null {
  if (ensureStarted || typeof window === "undefined") return null;
  ensureStarted = true;

  let channel: BroadcastChannelLike | null = null;
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CACHE_SYNC_CHANNEL) as BroadcastChannelLike;
    }
  } catch {
    // BroadcastChannel unavailable — fall back to storage events.
  }

  return createVaultCacheSync(client, {
    channel,
    storage: window.localStorage,
    subscribeStorage: (handler) => {
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
  });
}