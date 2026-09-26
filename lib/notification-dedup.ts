/**
 * Notification identity, scoping, and deduplication model (#652).
 *
 * Protocol alerts can be emitted for a wallet, a specific vault, or the whole
 * protocol. The same underlying event (APY change, pending transaction, vault
 * pause, reward event) may fire repeatedly or for overlapping scopes. This
 * module defines how notifications are identified and collapsed so that:
 *
 *  - repeated alerts resolve to a single *current* notification,
 *  - a wallet-specific and a global alert never collide,
 *  - dismissed/read state persists per wallet+network (see NotificationProvider),
 *  - stale alerts can be pruned once they expire.
 *
 * Runs in pure JS so the whole model is unit-testable without the DOM.
 */

export type NotificationScope = "wallet" | "vault" | "global";

export type NotificationType =
  | "apy_change"
  | "pending_transaction"
  | "vault_pause"
  | "reward_event"
  | "protocol_alert"
  | "deposit"
  | "withdrawal"
  | "round_update"
  | "account";

export type NotificationReadStatus = "read" | "unread";

export interface NotificationIdentityInput {
  type: NotificationType;
  scope: NotificationScope;
  /** Subject of the alert: vault id/name for `vault`, wallet address for `wallet`. */
  subject?: string | null;
}

export interface NotificationInput extends NotificationIdentityInput {
  title: string;
  message: string;
  date?: string;
  expiresAt?: string | null;
}

export interface VaultNotification extends NotificationIdentityInput {
  /** Stable client-generated id (does not change across updates). */
  id: string;
  /** `type::scope::subject` — the deduplication identity. */
  identityKey: string;
  title: string;
  message: string;
  /** ISO timestamp of the latest event the notification represents. */
  date: string;
  status: NotificationReadStatus;
  dismissed: boolean;
  /** Bumped whenever the alert content is refreshed. */
  version: number;
  expiresAt: string | null;
}

/**
 * Key identifying one logical alert. Scope is part of the identity so a
 * wallet alert and a global alert for the same subject never conflict.
 */
export function computeIdentityKey(input: NotificationIdentityInput): string {
  const subject = input.subject || "global";
  return `${input.type}::${input.scope}::${subject}`;
}

/** Cheap stable content signature to detect a true duplicate vs an update. */
function contentSignature(n: Pick<VaultNotification, "title" | "message" | "date">): string {
  return [n.title, n.message, n.date].join("|");
}

/**
 * FNV-1a hash keeps notification ids deterministic across reloads so that
 * persisted read/dismissed flags (keyed by id) survive a remount.
 */
function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Builds a fresh (version 1) notification from raw event data. */
export function createNotification(input: NotificationInput): VaultNotification {
  const date = input.date ?? new Date().toISOString();
  const identityKey = computeIdentityKey(input);
  return {
    id: `notif-${hashString(identityKey)}`,
    type: input.type,
    scope: input.scope,
    subject: input.subject ?? null,
    identityKey,
    title: input.title,
    message: input.message,
    date,
    status: "unread",
    dismissed: false,
    version: 1,
    expiresAt: input.expiresAt ?? null,
  };
}

export interface UpsertResult {
  notifications: VaultNotification[];
  /** `"created"`, `"updated"`, or `"duplicate"` depending on what happened. */
  outcome: "created" | "updated" | "duplicate";
}

/**
 * Inserts or collapses an incoming alert by its identity key.
 *
 * Semantics (mirrored by NotificationProvider and covered by tests):
 *  - a true duplicate (same identity + same content) collapses into the
 *    existing notification — one current alert per identity;
 *  - an updated alert replaces its predecessor in place, bumps `version`, and
 *    becomes unread again;
 *  - a dismissed alert stays dismissed across updates so a refreshed alert of
 *    the same family does not re-notify a user who already dismissed it.
 */
export function upsertNotification(
  existing: VaultNotification[],
  incoming: VaultNotification,
): UpsertResult {
  const index = existing.findIndex((n) => n.identityKey === incoming.identityKey);

  if (index === -1) {
    return { notifications: [incoming, ...existing], outcome: "created" };
  }

  const current = existing[index];
  if (contentSignature(current) === contentSignature(incoming)) {
    return { notifications: existing, outcome: "duplicate" };
  }

  const updated: VaultNotification = {
    ...incoming,
    id: current.id,
    identityKey: current.identityKey,
    status: "unread",
    dismissed: current.dismissed,
    version: current.version + 1,
  };

  const next = existing.slice();
  next[index] = updated;
  return { notifications: next, outcome: "updated" };
}

export function markNotificationRead(
  notifications: VaultNotification[],
  id: string,
): VaultNotification[] {
  return notifications.map((n) => (n.id === id && n.status !== "read" ? { ...n, status: "read" } : n));
}

export function markAllNotificationsRead(notifications: VaultNotification[]): VaultNotification[] {
  return notifications.map((n) => (n.status === "read" ? n : { ...n, status: "read" }));
}

export function dismissNotification(
  notifications: VaultNotification[],
  id: string,
): VaultNotification[] {
  return notifications.map((n) => (n.id === id && !n.dismissed ? { ...n, dismissed: true } : n));
}

/** Dismisses every notification, optionally limited to one scope. */
export function dismissAllNotifications(
  notifications: VaultNotification[],
  scope?: NotificationScope,
): VaultNotification[] {
  return notifications.map((n) => {
    if (n.dismissed) return n;
    if (scope !== undefined && n.scope !== scope) return n;
    return { ...n, dismissed: true };
  });
}

/** Removes notifications whose `expiresAt` has passed (in place, deterministic). */
export function pruneExpiredNotifications(
  notifications: VaultNotification[],
  now: string = new Date().toISOString(),
): VaultNotification[] {
  const nowMs = Date.parse(now);
  return notifications.filter((n) => n.expiresAt === null || Date.parse(n.expiresAt) > nowMs);
}

/** Stable ordering: newest first, then by identity key. */
export function sortNotifications(notifications: VaultNotification[]): VaultNotification[] {
  return notifications.slice().sort((a, b) => {
    const byDate = Date.parse(b.date) - Date.parse(a.date);
    return byDate !== 0 ? byDate : a.identityKey.localeCompare(b.identityKey);
  });
}

export function countUnread(notifications: VaultNotification[]): number {
  return notifications.filter((n) => n.status === "unread" && !n.dismissed).length;
}