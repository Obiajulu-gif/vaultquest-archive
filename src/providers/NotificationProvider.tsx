/**
 * VaultQuest notification provider (#652).
 *
 * Owns the deduplicated notification list for the current wallet+network and
 * persists read/dismissed state so alerts survive reloads. Protocol alerts are
 * scoped (`wallet` | `vault` | `global`) and collapsed by identity via
 * `lib/notification-dedup`; the provider never stores duplicate alerts.
 *
 * State is keyed by `scopeKey` (e.g. `${walletAddress}@${network}`) in
 * localStorage so dismissed state is scoped per wallet/network and cannot leak
 * between accounts.
 */

"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  createNotification,
  countUnread,
  dismissAllNotifications,
  dismissNotification,
  markAllNotificationsRead,
  markNotificationRead,
  pruneExpiredNotifications,
  sortNotifications,
  upsertNotification,
  type NotificationInput,
  type NotificationScope,
  type VaultNotification,
} from "../../lib/notification-dedup";

const STORAGE_PREFIX = "vaultquest:notifications:";

interface PersistedNotificationState {
  readIds: string[];
  dismissedIds: string[];
}

export interface NotificationCenterApi {
  scopeKey: string;
  notifications: VaultNotification[];
  unreadCount: number;
  /** Adds/updates/collapses an incoming protocol alert. */
  dispatchAlert: (input: NotificationInput) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  dismissAll: (scope?: NotificationScope) => void;
  clearExpired: () => void;
}

const NotificationCenterContext = createContext<NotificationCenterApi | null>(null);

interface NotificationProviderProps {
  children: ReactNode;
  /** Wallet+network scope key; dismissed/read state is persisted under this. */
  scopeKey?: string;
  /** Seed alerts (e.g. demo data or pre-fetch). Deduplicated on load. */
  initialAlerts?: NotificationInput[];
  /** Injected implementation for tests / non-DOM environments. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
}

function loadPersisted(scopeKey: string, storage?: Pick<Storage, "getItem">): PersistedNotificationState {
  const fallback: PersistedNotificationState = { readIds: [], dismissedIds: [] };
  try {
    const raw = storage?.getItem(`${STORAGE_PREFIX}${scopeKey}`);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedNotificationState>;
    return {
      readIds: Array.isArray(parsed.readIds) ? parsed.readIds : [],
      dismissedIds: Array.isArray(parsed.dismissedIds) ? parsed.dismissedIds : [],
    };
  } catch {
    return fallback;
  }
}

function loadSeeds(alerts: NotificationInput[] | undefined): VaultNotification[] {
  if (!alerts || alerts.length === 0) return [];
  let list: VaultNotification[] = [];
  for (const input of alerts) {
    list = upsertNotification(list, createNotification(input)).notifications;
  }
  return list;
}

export function NotificationProvider({
  children,
  scopeKey = "anonymous@testnet",
  initialAlerts = [],
  storage,
}: NotificationProviderProps) {
  const store: Pick<Storage, "getItem" | "setItem" | "removeItem"> = useMemo(
    () => storage ?? (typeof window !== "undefined" ? window.localStorage : undefined),
    [storage],
  );
  const storeRef = useRef(store);
  storeRef.current = store;

  const [notifications, setNotifications] = useState<VaultNotification[]>(() => {
    const seeded = loadSeeds(initialAlerts);
    const persisted = loadPersisted(scopeKey, storeRef.current);
    const hydrated = seeded.map((n) => ({
      ...n,
      status: persisted.readIds.includes(n.id) ? ("read" as const) : n.status,
      dismissed: persisted.dismissedIds.includes(n.id) ? true : n.dismissed,
    }));
    return sortNotifications(pruneExpiredNotifications(hydrated));
  });

  // Persist read/dismissed by wallet+network scope. Removed alerts (expired or
  // replaced) drop out of the stored ids to avoid unbounded growth.
  useEffect(() => {
    if (!storeRef.current) return;
    const state: PersistedNotificationState = {
      readIds: notifications.filter((n) => n.status === "read").map((n) => n.id),
      dismissedIds: notifications.filter((n) => n.dismissed).map((n) => n.id),
    };
    try {
      storeRef.current.setItem(`${STORAGE_PREFIX}${scopeKey}`, JSON.stringify(state));
    } catch {
      // storage unavailable (SSR/private mode) — state still works in memory
    }
  }, [notifications, scopeKey]);

  const dispatchAlert = useCallback((input: NotificationInput) => {
    setNotifications((current) => {
      const { notifications: next } = upsertNotification(current, createNotification(input));
      return sortNotifications(next);
    });
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((current) => markNotificationRead(current, id));
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((current) => markAllNotificationsRead(current));
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications((current) => dismissNotification(current, id));
  }, []);

  const dismissAll = useCallback((scope?: NotificationScope) => {
    setNotifications((current) => dismissAllNotifications(current, scope));
  }, []);

  const clearExpired = useCallback(() => {
    setNotifications((current) => pruneExpiredNotifications(current));
  }, []);

  const unreadCount = useMemo(() => countUnread(notifications), [notifications]);

  const api = useMemo<NotificationCenterApi>(
    () => ({
      scopeKey,
      notifications,
      unreadCount,
      dispatchAlert,
      markRead,
      markAllRead,
      dismiss,
      dismissAll,
      clearExpired,
    }),
    [scopeKey, notifications, unreadCount, dispatchAlert, markRead, markAllRead, dismiss, dismissAll, clearExpired],
  );

  return <NotificationCenterContext.Provider value={api}>{children}</NotificationCenterContext.Provider>;
}

/** Access to the notification center (must be used under `NotificationProvider`). */
export function useNotificationCenter(): NotificationCenterApi {
  const ctx = useContext(NotificationCenterContext);
  if (!ctx) {
    throw new Error("useNotificationCenter must be used within <NotificationProvider>");
  }
  return ctx;
}

export { NotificationCenterContext };