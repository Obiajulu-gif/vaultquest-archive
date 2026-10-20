/**
 * Notification identity, scoping, and deduplication model (#652, #776).
 *
 * Protocol alerts can be emitted for a wallet, a specific vault, or the whole
 * protocol. The same underlying event (APY change, pending transaction, vault
 * pause, reward event, critical failure, approval, completed action, recovery path)
 * may fire repeatedly, be retried, or have overlapping scopes. This module
 * defines how notifications are identified, targeted, and collapsed so that:
 *
 *  - critical lifecycle events generate notifications once,
 *  - retried events collapse into a single current alert without duplicates,
 *  - private user data is never exposed to the wrong user/wallet,
 *  - read/unread state is tracked and toggleable,
 *  - deep links direct users straight into the relevant workflow,
 *  - dismissed/read state persists per wallet+network,
 *  - stale alerts are pruned once they expire.
 *
 * Runs in pure TypeScript/JS so the whole model is unit-testable without the DOM.
 */

export type NotificationScope = "wallet" | "vault" | "global" | "admin";

export type NotificationType =
  | "apy_change"
  | "pending_transaction"
  | "vault_pause"
  | "reward_event"
  | "protocol_alert"
  | "deposit"
  | "withdrawal"
  | "round_update"
  | "account"
  // #776: Critical lifecycle and recovery event types
  | "action_failed"
  | "approval_required"
  | "action_completed"
  | "recovery_path_available"
  | "recovery_resolved"
  | "recovery_failed"
  | "maturity"
  | "claim_window";

export type NotificationCategory =
  | "failure"
  | "approval"
  | "completed_action"
  | "recovery_path"
  | "vault"
  | "protocol"
  | "account";

export type NotificationSeverity = "critical" | "warning" | "info" | "success";

export type NotificationReadStatus = "read" | "unread";

export interface NotificationViewer {
  walletAddress?: string | null;
  role?: "user" | "admin" | "anonymous";
}

export interface NotificationIdentityInput {
  type: NotificationType;
  scope: NotificationScope;
  /** Subject of the alert: vault id/name for `vault`, wallet address for `wallet`. */
  subject?: string | null;
  /**
   * Unique event or action identifier (e.g. actionId, txHash, proposalId, recoveryId).
   * When provided, retries for the same event instance share identityKey and collapse
   * into a single notification.
   */
  eventId?: string | null;
}

export interface NotificationInput extends NotificationIdentityInput {
  title: string;
  message: string;
  date?: string;
  expiresAt?: string | null;
  /** Direct link to the relevant workflow (e.g. /app/activity?tx=..., /app/admin/proposals/...) */
  deepLink?: string | null;
  /** Actionable CTA label for the deep link button (e.g. "View Recovery", "Review Proposal") */
  actionLabel?: string | null;
  /** Visual priority / severity classification */
  severity?: NotificationSeverity;
  /** Explicit recipient wallet address. Defaults to subject when scope is "wallet". */
  recipient?: string | null;
  /** Target role constraint (e.g. "admin" for maintainer-only approvals) */
  targetRole?: "user" | "admin" | "all";
  /** If true, payload contains sensitive user data and is hidden from non-recipients */
  isPrivate?: boolean;
  /** Retry attempt count for retried lifecycle operations */
  retryCount?: number;
  /** Logical category */
  category?: NotificationCategory;
}

export interface VaultNotification extends NotificationIdentityInput {
  /** Stable client-generated id (does not change across updates). */
  id: string;
  /** `type::scope::subject(::eventId)` — the deduplication identity. */
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
  deepLink: string | null;
  actionLabel: string | null;
  severity: NotificationSeverity;
  recipient: string | null;
  targetRole: "user" | "admin" | "all";
  isPrivate: boolean;
  retryCount: number;
  category: NotificationCategory;
}

/**
 * Resolves the functional category for a notification type.
 */
export function getNotificationCategory(type: NotificationType): NotificationCategory {
  switch (type) {
    case "action_failed":
    case "recovery_failed":
      return "failure";
    case "approval_required":
      return "approval";
    case "action_completed":
    case "recovery_resolved":
    case "deposit":
    case "withdrawal":
    case "reward_event":
      return "completed_action";
    case "recovery_path_available":
      return "recovery_path";
    case "apy_change":
    case "vault_pause":
      return "vault";
    case "protocol_alert":
    case "round_update":
      return "protocol";
    case "account":
    case "maturity":
    case "claim_window":
    case "pending_transaction":
    default:
      return "account";
  }
}

/**
 * Resolves a default severity level based on the event type.
 */
export function getDefaultSeverity(type: NotificationType): NotificationSeverity {
  switch (type) {
    case "action_failed":
    case "recovery_failed":
      return "critical";
    case "approval_required":
    case "recovery_path_available":
    case "vault_pause":
      return "warning";
    case "action_completed":
    case "recovery_resolved":
    case "deposit":
    case "withdrawal":
    case "reward_event":
      return "success";
    default:
      return "info";
  }
}

/**
 * Key identifying one logical alert. Scope and optional eventId are part
 * of the identity so wallet alerts, global alerts, and distinct action instances
 * never conflict, while retries for the same event collapse.
 */
export function computeIdentityKey(input: NotificationIdentityInput): string {
  const subject = input.subject || "global";
  const eventPart = input.eventId ? `::${input.eventId}` : "";
  return `${input.type}::${input.scope}::${subject}${eventPart}`;
}

/** Cheap stable content signature to detect a true duplicate vs an update. */
function contentSignature(
  n: Pick<VaultNotification, "title" | "message" | "date" | "deepLink" | "severity">,
): string {
  return [n.title, n.message, n.date, n.deepLink ?? "", n.severity ?? ""].join("|");
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
  const category = input.category ?? getNotificationCategory(input.type);
  const severity = input.severity ?? getDefaultSeverity(input.type);
  const recipient =
    input.recipient ?? (input.scope === "wallet" ? input.subject ?? null : null);
  // Supplying a recipient is an explicit request for one-account delivery;
  // make that safe by default even if a producer accidentally chooses a broad
  // scope. Public, wallet-independent notices simply omit `recipient`.
  const isPrivate = input.isPrivate ?? recipient !== null;

  return {
    id: `notif-${hashString(identityKey)}`,
    type: input.type,
    category,
    scope: input.scope,
    subject: input.subject ?? null,
    eventId: input.eventId ?? null,
    identityKey,
    title: input.title,
    message: input.message,
    date,
    status: "unread",
    dismissed: false,
    version: 1,
    expiresAt: input.expiresAt ?? null,
    deepLink: input.deepLink ?? null,
    actionLabel: input.actionLabel ?? null,
    severity,
    recipient,
    targetRole: input.targetRole ?? "all",
    isPrivate,
    retryCount: input.retryCount ?? 0,
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
 *  - a true duplicate (same identity + same content + same retry count) collapses
 *    into the existing notification — one current alert per identity;
 *  - an updated or retried alert replaces its predecessor in place, bumps `version`,
 *    synchronizes the latest payload/deepLink, and resets `status` to `"unread"`;
 *  - a dismissed alert stays dismissed across updates so a refreshed alert of
 *    the same family does not re-notify a user who already dismissed it;
 *  - critical lifecycle events generate notifications once without unbounded accumulation.
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
  const isExactDuplicate =
    contentSignature(current) === contentSignature(incoming) &&
    current.retryCount === incoming.retryCount;

  if (isExactDuplicate) {
    return { notifications: existing, outcome: "duplicate" };
  }

  const updated: VaultNotification = {
    ...incoming,
    id: current.id,
    identityKey: current.identityKey,
    status: "unread",
    dismissed: current.dismissed,
    version: current.version + 1,
    retryCount: Math.max(current.retryCount, incoming.retryCount),
  };

  const next = existing.slice();
  next[index] = updated;
  return { notifications: next, outcome: "updated" };
}

/**
 * Evaluates whether a notification is authorized and targeted for a specific viewer.
 *
 * Privacy Guarantees:
 *  - Notifications targeted to wallet A are NEVER returned to wallet B or an unauthenticated viewer.
 *  - Admin-only notifications require role "admin".
 *  - Private notifications without matching recipient are suppressed.
 */
export function isNotificationTargeted(
  notification: VaultNotification,
  viewer?: NotificationViewer | null,
): boolean {
  const viewerWallet = viewer?.walletAddress?.trim().toLowerCase();
  const viewerRole = viewer?.role || (viewerWallet ? "user" : "anonymous");

  // Admin-scoped or admin-targeted notifications require admin credentials
  if (notification.scope === "admin" || notification.targetRole === "admin") {
    return viewerRole === "admin";
  }

  // Wallet-scoped notifications MUST match the authenticated viewer's wallet
  if (notification.scope === "wallet") {
    const targetWallet = (notification.recipient || notification.subject || "").trim().toLowerCase();
    if (!targetWallet) return false;
    return !!viewerWallet && viewerWallet === targetWallet;
  }

  // Explicitly private notifications require matching recipient
  if (notification.isPrivate) {
    if (!viewerWallet || !notification.recipient) return false;
    return viewerWallet === notification.recipient.trim().toLowerCase();
  }

  // Global and vault-scoped notifications are visible to all users
  return true;
}

/**
 * Filters a notification list so it only contains items targeted to the viewer.
 */
export function filterNotificationsForRecipient(
  notifications: VaultNotification[],
  viewer?: NotificationViewer | null,
): VaultNotification[] {
  return notifications.filter((n) => isNotificationTargeted(n, viewer));
}

export function markNotificationRead(
  notifications: VaultNotification[],
  id: string,
): VaultNotification[] {
  return notifications.map((n) => (n.id === id && n.status !== "read" ? { ...n, status: "read" } : n));
}

export function markNotificationUnread(
  notifications: VaultNotification[],
  id: string,
): VaultNotification[] {
  return notifications.map((n) => (n.id === id && n.status !== "unread" ? { ...n, status: "unread" } : n));
}

export function toggleNotificationRead(
  notifications: VaultNotification[],
  id: string,
): VaultNotification[] {
  return notifications.map((n) =>
    n.id === id ? { ...n, status: n.status === "read" ? "unread" : "read" } : n,
  );
}

export function markAllNotificationsRead(
  notifications: VaultNotification[],
  scope?: NotificationScope,
): VaultNotification[] {
  return notifications.map((n) => {
    if (scope !== undefined && n.scope !== scope) return n;
    return n.status === "read" ? n : { ...n, status: "read" };
  });
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

export function countUnread(
  notifications: VaultNotification[],
  viewer?: NotificationViewer | null,
): number {
  const list = filterNotificationsForRecipient(notifications, viewer);
  return list.filter((n) => n.status === "unread" && !n.dismissed).length;
}

// ── Lifecycle & Recovery Notification Helpers (#776) ─────────────────────────

function capitalize(text: string): string {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Creates a notification for a critical failure event.
 */
export function createFailureNotification(params: {
  actionType: string;
  errorMessage: string;
  walletAddress?: string | null;
  actionId?: string | null;
  txHash?: string | null;
  deepLink?: string | null;
  date?: string;
}): NotificationInput {
  const eventId = params.actionId || params.txHash || null;
  const deepLink =
    params.deepLink ||
    (params.txHash ? `/app/activity?tx=${params.txHash}&status=failed` : "/app/activity");

  return {
    type: "action_failed",
    scope: params.walletAddress ? "wallet" : "global",
    subject: params.walletAddress || "Protocol",
    recipient: params.walletAddress || null,
    eventId,
    title: `${capitalize(params.actionType)} action failed`,
    message: params.errorMessage || `The ${params.actionType} action encountered a failure and could not be finalized.`,
    deepLink,
    actionLabel: "View Activity",
    severity: "critical",
    category: "failure",
    isPrivate: !!params.walletAddress,
    date: params.date,
  };
}

/**
 * Creates a notification for an approval workflow event.
 */
export function createApprovalNotification(params: {
  title: string;
  message: string;
  proposalId?: string | null;
  walletAddress?: string | null;
  role?: "admin" | "user";
  deepLink?: string | null;
  date?: string;
}): NotificationInput {
  return {
    type: "approval_required",
    scope: params.role === "admin" ? "admin" : params.walletAddress ? "wallet" : "global",
    subject: params.walletAddress || (params.role === "admin" ? "Admin Governance" : "Protocol"),
    recipient: params.walletAddress || null,
    targetRole: params.role || "user",
    eventId: params.proposalId || null,
    title: params.title,
    message: params.message,
    deepLink: params.deepLink || (params.role === "admin" ? "/app/admin/proposals" : "/app/vaults"),
    actionLabel: "Review Approval",
    severity: "warning",
    category: "approval",
    isPrivate: !!params.walletAddress,
    date: params.date,
  };
}

/**
 * Creates a notification for a successfully completed action.
 */
export function createCompletedActionNotification(params: {
  actionType: string;
  walletAddress?: string | null;
  txHash?: string | null;
  actionId?: string | null;
  summary?: string;
  deepLink?: string | null;
  date?: string;
}): NotificationInput {
  const eventId = params.actionId || params.txHash || null;
  const deepLink =
    params.deepLink || (params.txHash ? `/app/activity?tx=${params.txHash}` : "/app/activity");

  return {
    type: "action_completed",
    scope: params.walletAddress ? "wallet" : "global",
    subject: params.walletAddress || "Protocol",
    recipient: params.walletAddress || null,
    eventId,
    title: `${capitalize(params.actionType)} completed`,
    message: params.summary || `Your ${params.actionType} action was confirmed on chain.`,
    deepLink,
    actionLabel: "View Details",
    severity: "success",
    category: "completed_action",
    isPrivate: !!params.walletAddress,
    date: params.date,
  };
}

/**
 * Creates a notification for a recovery path event.
 */
export function createRecoveryNotification(params: {
  actionId: string;
  walletAddress: string;
  actionType: string;
  state: "retryable" | "failed" | "manual_review" | "resolved";
  message?: string;
  attempts?: number;
  maxAttempts?: number;
  deepLink?: string | null;
  date?: string;
}): NotificationInput {
  const isResolved = params.state === "resolved";
  const isFailed = params.state === "failed";
  const type: NotificationType = isResolved
    ? "recovery_resolved"
    : isFailed
      ? "recovery_failed"
      : "recovery_path_available";
  const severity: NotificationSeverity = isResolved ? "success" : isFailed ? "critical" : "warning";
  const deepLink = params.deepLink || `/app/activity?action=${params.actionId}&tab=recovery`;

  const defaultMsg =
    params.state === "retryable"
      ? `Action took longer than expected (attempt ${params.attempts || 1}/${params.maxAttempts || 3}). A recovery path is available.`
      : params.state === "failed"
        ? `Automatic recovery exhausted retries for ${params.actionType}. Maintainer review requested.`
        : params.state === "manual_review"
          ? `A maintainer is reviewing your stuck ${params.actionType} action.`
          : `Stuck ${params.actionType} action was successfully recovered.`;

  return {
    type,
    scope: "wallet",
    subject: params.walletAddress,
    recipient: params.walletAddress,
    eventId: `recovery-${params.actionId}`,
    title: isResolved ? "Action recovered" : isFailed ? "Recovery failed" : "Recovery path available",
    message: params.message || defaultMsg,
    deepLink,
    actionLabel: isResolved ? "View Receipt" : "Open Recovery",
    severity,
    category: "recovery_path",
    isPrivate: true,
    retryCount: params.attempts || 0,
    date: params.date,
  };
}
