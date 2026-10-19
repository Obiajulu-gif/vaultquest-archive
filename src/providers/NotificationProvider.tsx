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
 *
 * Durable preference routing (`lib/notification-routing`): optional alerts
 * respect the wallet's stored preferences (per-type disable plus a global
 * optional mute window) while mandatory lifecycle/security alerts are always
 * deliverable. Every routing evaluation is recorded in a bounded audit trail
 * that survives reloads, so suppressions can be explained later.
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
  markNotificationUnread,
  isNotificationTargeted,
  pruneExpiredNotifications,
  sortNotifications,
  upsertNotification,
  type NotificationInput,
  type NotificationType,
  type NotificationViewer,
  type NotificationScope,
  type VaultNotification,
} from "../../lib/notification-dedup";
import {
  appendRoutingAudit,
  DEFAULT_ROUTING_AUDIT_LIMIT,
  loadNotificationPreferences,
  loadRoutingAudit,
  routeNotification,
  saveNotificationPreferences,
  saveRoutingAudit,
  setOptionalMuteUntil,
  setOptionalNotificationEnabled,
  type NotificationPreferences,
  type NotificationRoutingAuditRecord,
} from "../../lib/notification-routing";

const STORAGE_PREFIX = "vaultquest:notifications:";

interface PersistedNotificationState {
  readIds: string[];
  dismissedIds: string[];
}

export interface NotificationCenterApi {
  scopeKey: string;
  notifications: VaultNotification[];
  unreadCount: number;
  /** Adds/updates/collapses an incoming protocol alert, honoring preferences. */
  dispatchAlert: (input: NotificationInput) => void;
  markRead: (id: string) => void;
  markUnread: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  dismissAll: (scope?: NotificationScope) => void;
  clearExpired: () => void;
  /** Current durable preference document for this wallet+network scope. */
  preferences: NotificationPreferences;
  /**
   * Enables/disables one optional type. Mandatory types are rejected and the
   * preference document is unchanged (`changed: false`).
   */
  setOptionalEnabled: (type: NotificationType | string, enabled: boolean) => { changed: boolean; rejectedReason?: string };
  /** Mutes or unmutes all optional alerts until an ISO timestamp (null = unmute). */
  muteOptionalUntil: (untilIso: string | null) => { changed: boolean; rejectedReason?: string };
  /** Bounded, newest-first routing audit trail. */
  routingAudit: NotificationRoutingAuditRecord[];
  clearRoutingAudit: () => void;
}

const NotificationCenterContext = createContext<NotificationCenterApi | null>(null);

interface NotificationProviderProps {
  children: ReactNode;
  /** Wallet+network scope key; dismissed/read state is persisted under this. */
  scopeKey?: string;
  /** Seed alerts (e.g. demo data or pre-fetch). Deduplicated on load. */
  initialAlerts?: NotificationInput[];
  /**
   * Authenticated notification viewer. Wallet and admin-only alerts are
   * filtered before they enter this provider's state, so an alert supplied
   * for another account cannot be rendered or persisted by this session.
   */
  viewer?: NotificationViewer;
  /** Injected implementation for tests / non-DOM environments. */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  /**
   * Controlled preference document. When omitted, preferences are loaded
   * from `storage` (defaulting to sensible all-deliver defaults).
   */
  preferences?: NotificationPreferences;
  /** Called with the new document after a preference change is committed. */
  onPreferencesChange?: (preferences: NotificationPreferences) => void;
  /** Called for every routing decision (mandatory or suppressed). */
  onRoutingDecision?: (record: NotificationRoutingAuditRecord) => void;
  /** Max audit records retained (defaults to 200). */
  routingAuditLimit?: number;
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

function mergeAudit(
  persisted: NotificationRoutingAuditRecord[],
  evaluations: Array<ReturnType<typeof routeNotification>>,
  limit: number,
): NotificationRoutingAuditRecord[] {
  let audit = persisted;
  for (const evaluation of evaluations) {
    audit = appendRoutingAudit(audit, evaluation.audit, limit);
  }
  return audit;
}

export function NotificationProvider({
  children,
  scopeKey = "anonymous@testnet",
  initialAlerts = [],
  viewer,
  storage,
  preferences: controlledPreferences,
  onPreferencesChange,
  onRoutingDecision,
  routingAuditLimit = DEFAULT_ROUTING_AUDIT_LIMIT,
}: NotificationProviderProps) {
  const store: Pick<Storage, "getItem" | "setItem" | "removeItem"> = useMemo(
    () => storage ?? (typeof window !== "undefined" ? window.localStorage : undefined),
    [storage],
  );
  const storeRef = useRef(store);
  storeRef.current = store;

  const [preferences, setPreferences] = useState<NotificationPreferences>(() => {
    if (controlledPreferences) return controlledPreferences;
    return loadNotificationPreferences(storeRef.current, scopeKey).preferences;
  });

  // Follow the controlled document when the parent supplies a new revision.
  const controlledRevision = controlledPreferences?.revision;
  useEffect(() => {
    if (controlledPreferences) setPreferences(controlledPreferences);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledRevision]);

  /**
   * Seed alerts are evaluated once per mount through the same preference
   * model as live dispatches, so a disabled optional type cannot enter state
   * through `initialAlerts` either. Evaluations land in the audit trail.
   */
  const seedResult = useMemo(() => {
    const evaluations = loadSeeds(initialAlerts)
      .filter((alert) => isNotificationTargeted(alert, viewer))
      .map((alert) => ({
        alert,
        route: routeNotification(
          {
            type: alert.type,
            severity: alert.severity,
            identityKey: alert.identityKey,
            expiresAt: alert.expiresAt,
          },
          preferences,
          { scopeKey },
        ),
      }));
    return {
      notifications: evaluations.filter((entry) => entry.route.deliver).map((entry) => entry.alert),
      evaluations: evaluations.map((entry) => entry.route),
    };
    // Seeds are evaluated once per mount; live dispatches route in dispatchAlert.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [routingAudit, setRoutingAudit] = useState<NotificationRoutingAuditRecord[]>(() =>
    mergeAudit(
      loadRoutingAudit(storeRef.current, scopeKey, routingAuditLimit),
      seedResult.evaluations,
      routingAuditLimit,
    ),
  );

  const recordRoutingDecision = useCallback(
    (result: ReturnType<typeof routeNotification>) => {
      setRoutingAudit((current) => {
        const next = appendRoutingAudit(current, result.audit, routingAuditLimit);
        try {
          saveRoutingAudit(storeRef.current, scopeKey, next);
        } catch {
          // storage unavailable (SSR/private mode) — audit stays in memory
        }
        return next;
      });
      onRoutingDecision?.({
        ...result.audit,
        count: 1,
        firstAt: result.audit.at,
        lastAt: result.audit.at,
      });
    },
    [onRoutingDecision, routingAuditLimit, scopeKey],
  );

  const commitPreferences = useCallback(
    (next: NotificationPreferences) => {
      setPreferences(next);
      try {
        saveNotificationPreferences(storeRef.current, scopeKey, next);
      } catch {
        // storage unavailable — keep working in memory, document in audit trail
      }
      onPreferencesChange?.(next);
    },
    [onPreferencesChange, scopeKey],
  );

  const [notifications, setNotifications] = useState<VaultNotification[]>(() => {
    const persisted = loadPersisted(scopeKey, storeRef.current);
    const hydrated = seedResult.notifications.map((n) => ({
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
    const incoming = createNotification(input);
    // Targeting is enforced at the state boundary. This matters for a
    // shared event stream where an event can be delivered after account
    // switching; never retain another wallet's private payload locally.
    if (!isNotificationTargeted(incoming, viewer)) return;

    const routed = routeNotification(
      {
        type: incoming.type,
        severity: incoming.severity,
        identityKey: incoming.identityKey,
        expiresAt: incoming.expiresAt,
      },
      preferences,
      { scopeKey },
    );
    recordRoutingDecision(routed);
    if (!routed.deliver) return;

    setNotifications((current) => {
      const { notifications: next } = upsertNotification(current, incoming);
      return sortNotifications(next);
    });
  }, [preferences, recordRoutingDecision, scopeKey, viewer]);

  const markRead = useCallback((id: string) => {
    setNotifications((current) => markNotificationRead(current, id));
  }, []);

  const markUnread = useCallback((id: string) => {
    setNotifications((current) => markNotificationUnread(current, id));
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

  const setOptionalEnabled = useCallback(
    (type: NotificationType | string, enabled: boolean) => {
      const outcome = setOptionalNotificationEnabled(preferences, type, enabled);
      if (outcome.changed) commitPreferences(outcome.preferences);
      return { changed: outcome.changed, rejectedReason: outcome.rejectedReason };
    },
    [commitPreferences, preferences],
  );

  const muteOptionalUntil = useCallback(
    (untilIso: string | null) => {
      const outcome = setOptionalMuteUntil(preferences, untilIso);
      if (outcome.changed) commitPreferences(outcome.preferences);
      return { changed: outcome.changed, rejectedReason: outcome.rejectedReason };
    },
    [commitPreferences, preferences],
  );

  const clearRoutingAudit = useCallback(() => {
    setRoutingAudit([]);
    try {
      saveRoutingAudit(storeRef.current, scopeKey, []);
    } catch {
      // storage unavailable — in-memory log cleared
    }
  }, [scopeKey]);

  const unreadCount = useMemo(() => countUnread(notifications, viewer), [notifications, viewer]);

  const api = useMemo<NotificationCenterApi>(
    () => ({
      scopeKey,
      notifications,
      unreadCount,
      dispatchAlert,
      markRead,
      markUnread,
      markAllRead,
      dismiss,
      dismissAll,
      clearExpired,
      preferences,
      setOptionalEnabled,
      muteOptionalUntil,
      routingAudit,
      clearRoutingAudit,
    }),
    [
      scopeKey,
      notifications,
      unreadCount,
      dispatchAlert,
      markRead,
      markUnread,
      markAllRead,
      dismiss,
      dismissAll,
      clearExpired,
      preferences,
      setOptionalEnabled,
      muteOptionalUntil,
      routingAudit,
      clearRoutingAudit,
    ],
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
