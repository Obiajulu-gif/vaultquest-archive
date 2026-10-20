/**
 * Durable notification preference and mandatory-alert routing model.
 *
 * `lib/notification-dedup.ts` owns notification identity, deduplication, and
 * targeting. This module adds the layer above it:
 *
 *  - every notification type is classified as `mandatory` (security /
 *    lifecycle / governance / recovery alerts that must stay deliverable) or
 *    `optional` (informational alerts the wallet may mute),
 *  - preferences are a versioned, durable document (survives reload through
 *    the same storage the notification center already uses),
 *  - mandatory notifications bypass preferences, while optional ones are
 *    suppressed when disabled or muted,
 *  - every routing evaluation produces a bounded, deterministic audit record
 *    so "why wasn't this alert shown?" is answerable without log archaeology.
 *
 * Everything is pure TypeScript. Storage is injectable, so the model is
 * unit-testable without a DOM and the integration point for the React
 * provider (`src/providers/NotificationProvider.tsx`) stays thin.
 */

import {
  getDefaultSeverity,
  type NotificationSeverity,
  type NotificationType,
} from "./notification-dedup";

// ── Classification ───────────────────────────────────────────────────────────

export type RoutingClassification = "mandatory" | "optional";

export type MandatoryReason = "security" | "lifecycle" | "governance" | "recovery" | "severity_promotion";

export interface NotificationRoutingPolicyEntry {
  classification: RoutingClassification;
  /** Present only for mandatory types; explains why preferences cannot mute it. */
  reason?: MandatoryReason;
  /** Short operator-facing description of the delivery guarantee. */
  description: string;
}

/**
 * The routing policy for every notification type. Mandatory types can never
 * be disabled or muted; the remaining types respect wallet preferences.
 *
 * Only failures, recovery flows, approvals, protocol-wide alerts, and vault
 * pauses are mandatory — these are the events where a missed alert can strand
 * funds or hide a security problem. Confirmations and reminders are optional.
 */
export const NOTIFICATION_ROUTING_POLICY: Record<NotificationType, NotificationRoutingPolicyEntry> = {
  // Mandatory: security / lifecycle critical. Bypass user preferences.
  action_failed: {
    classification: "mandatory",
    reason: "security",
    description: "A user action (deposit, withdraw, claim, draw) failed and may need intervention.",
  },
  recovery_failed: {
    classification: "mandatory",
    reason: "recovery",
    description: "Automatic recovery exhausted its retries; a maintainer may need to step in.",
  },
  recovery_path_available: {
    classification: "mandatory",
    reason: "recovery",
    description: "A stuck action has a recoverable path the user should act on.",
  },
  recovery_resolved: {
    classification: "mandatory",
    reason: "recovery",
    description: "A previously stuck action finished recovering; users need the receipt trail.",
  },
  approval_required: {
    classification: "mandatory",
    reason: "governance",
    description: "A governance/multi-signature approval is pending and blocking progress.",
  },
  protocol_alert: {
    classification: "mandatory",
    reason: "security",
    description: "Protocol-wide security or integrity alert.",
  },
  vault_pause: {
    classification: "mandatory",
    reason: "lifecycle",
    description: "A vault was paused; deposits/withdrawals may be blocked.",
  },
  // Optional: wallets may mute these through preferences.
  apy_change: { classification: "optional", description: "APY changed for a watched vault." },
  pending_transaction: { classification: "optional", description: "A submitted transaction is still settling." },
  reward_event: { classification: "optional", description: "Reward granted or distributed." },
  deposit: { classification: "optional", description: "Deposit position update." },
  withdrawal: { classification: "optional", description: "Withdrawal position update." },
  round_update: { classification: "optional", description: "Prize round schedule/status update." },
  account: { classification: "optional", description: "Account or profile notice." },
  action_completed: { classification: "optional", description: "An action confirmed on chain (receipt)." },
  maturity: { classification: "optional", description: "Vault maturity reminder." },
  claim_window: { classification: "optional", description: "Claim window reminder." },
};

/** Notification types that can never be muted through preferences. */
export const MANDATORY_NOTIFICATION_TYPES: NotificationType[] = (
  Object.keys(NOTIFICATION_ROUTING_POLICY) as NotificationType[]
).filter((type) => NOTIFICATION_ROUTING_POLICY[type].classification === "mandatory");

export function isMandatoryNotificationType(type: NotificationType | string): boolean {
  return (NOTIFICATION_ROUTING_POLICY as Record<string, NotificationRoutingPolicyEntry | undefined>)[type]
    ?.classification === "mandatory";
}

/**
 * Classifies a concrete notification. A `critical` severity promotes any
 * optional type to mandatory for that delivery: operators can escalate a
 * specific rare alert (e.g. a suspicious `account` notice) without changing
 * the catalog for the whole protocol.
 */
export function classifyNotification(
  type: NotificationType | string,
  severity?: NotificationSeverity,
): { classification: RoutingClassification; reason?: MandatoryReason } {
  const entry = (NOTIFICATION_ROUTING_POLICY as Record<string, NotificationRoutingPolicyEntry | undefined>)[type];
  if (entry?.classification === "mandatory") {
    return { classification: "mandatory", reason: entry.reason };
  }
  if (severity === "critical") {
    return { classification: "mandatory", reason: "severity_promotion" };
  }
  return { classification: "optional" };
}

// ── Durable preferences ──────────────────────────────────────────────────────

export const NOTIFICATION_PREFERENCE_SCHEMA_VERSION = 2;
export const NOTIFICATION_PREFERENCE_STORAGE_PREFIX = "vaultquest:notification-preferences:";

export interface NotificationPreferences {
  schemaVersion: typeof NOTIFICATION_PREFERENCE_SCHEMA_VERSION;
  /** Optional types the wallet muted. Mandatory types are stripped on write. */
  disabledTypes: NotificationType[];
  /** ISO timestamp until which ALL optional alerts are muted; null = not muted. */
  optionalMutedUntil: string | null;
  /** Monotonic revision; audit records reference the revision they saw. */
  revision: number;
  updatedAt: string;
}

export function createDefaultNotificationPreferences(now: Date = new Date()): NotificationPreferences {
  return {
    schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
    disabledTypes: [],
    optionalMutedUntil: null,
    revision: 1,
    updatedAt: now.toISOString(),
  };
}

export interface SanitizedPreferences {
  preferences: NotificationPreferences;
  /** Preference entries that were dropped and why (auditable repairs). */
  repairs: string[];
  /** True when the stored shape differed from the current schema. */
  migrated: boolean;
}

/**
 * Coerces any historically stored preference document into the current,
 * safe shape. Accepted inputs:
 *
 *  - v1: a bare `string[]` of disabled types (earliest client format),
 *  - v0: `{ disabledTypes: string[] }` (backend-style record),
 *  - v2: the current `NotificationPreferences` document.
 *
 * Guarantees regardless of input: mandatory types never remain disabled,
 * unknown types are dropped, the list is deduplicated, and the revision and
 * timestamps are valid. Callers surface `repairs` in the audit trail.
 */
export function sanitizeNotificationPreferences(
  raw: unknown,
  now: Date = new Date(),
): SanitizedPreferences {
  const repairs: string[] = [];
  let disabled: unknown = [];
  let mutedUntil: unknown = null;
  let revision: unknown = 1;
  let updatedAt: unknown;
  let migrated = false;

  if (Array.isArray(raw)) {
    disabled = raw;
    migrated = true;
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    disabled = record.disabledTypes ?? [];
    mutedUntil = record.optionalMutedUntil ?? null;
    revision = record.revision ?? 1;
    updatedAt = record.updatedAt;
    migrated = record.schemaVersion !== NOTIFICATION_PREFERENCE_SCHEMA_VERSION;
  } else if (raw !== null && raw !== undefined) {
    migrated = true;
    repairs.push("Ignored malformed notification preferences payload.");
  }

  const knownTypes = new Set<string>(Object.keys(NOTIFICATION_ROUTING_POLICY));
  const seen = new Set<string>();
  const sanitized: NotificationType[] = [];
  for (const entry of Array.isArray(disabled) ? disabled : []) {
    if (typeof entry !== "string" || !knownTypes.has(entry)) {
      repairs.push(`Dropped unknown notification type "${String(entry)}".`);
      continue;
    }
    if (isMandatoryNotificationType(entry)) {
      repairs.push(`Refused to disable mandatory notification type "${entry}".`);
      continue;
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    sanitized.push(entry as NotificationType);
  }

  let sanitizedMutedUntil: string | null = null;
  if (typeof mutedUntil === "string" && Number.isFinite(Date.parse(mutedUntil))) {
    sanitizedMutedUntil = new Date(mutedUntil).toISOString();
  } else if (mutedUntil !== null && mutedUntil !== undefined) {
    repairs.push("Dropped invalid optional-mute timestamp.");
  }

  const safeRevision =
    typeof revision === "number" && Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
  const safeUpdatedAt =
    typeof updatedAt === "string" && Number.isFinite(Date.parse(updatedAt))
      ? new Date(updatedAt).toISOString()
      : now.toISOString();

  return {
    preferences: {
      schemaVersion: NOTIFICATION_PREFERENCE_SCHEMA_VERSION,
      disabledTypes: sanitized,
      optionalMutedUntil: sanitizedMutedUntil,
      revision: safeRevision,
      updatedAt: safeUpdatedAt,
    },
    repairs,
    migrated,
  };
}

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function notificationPreferencesStorageKey(scopeKey: string): string {
  return `${NOTIFICATION_PREFERENCE_STORAGE_PREFIX}${scopeKey}`;
}

/**
 * Loads preferences for a wallet+network scope. Missing or corrupt payloads
 * degrade to defaults rather than throwing, so a bad local document can never
 * brick the notification center.
 */
export function loadNotificationPreferences(
  storage: PreferenceStorage | undefined,
  scopeKey: string,
  now: Date = new Date(),
): SanitizedPreferences {
  if (!storage) return { preferences: createDefaultNotificationPreferences(now), repairs: [], migrated: false };
  let raw: unknown;
  try {
    const text = storage.getItem(notificationPreferencesStorageKey(scopeKey));
    if (!text) return { preferences: createDefaultNotificationPreferences(now), repairs: [], migrated: false };
    raw = JSON.parse(text);
  } catch {
    return {
      preferences: createDefaultNotificationPreferences(now),
      repairs: ["Discarded unreadable stored notification preferences."],
      migrated: false,
    };
  }
  return sanitizeNotificationPreferences(raw, now);
}

/** Persists preferences durably. Throws only if the storage adapter throws. */
export function saveNotificationPreferences(
  storage: PreferenceStorage | undefined,
  scopeKey: string,
  preferences: NotificationPreferences,
): void {
  storage?.setItem(notificationPreferencesStorageKey(scopeKey), JSON.stringify(preferences));
}

/**
 * Enables or disables one optional notification type. Mandatory types are
 * rejected (the document is returned unchanged) so a caller bug cannot
 * silently mute a security alert.
 */
export function setOptionalNotificationEnabled(
  preferences: NotificationPreferences,
  type: NotificationType | string,
  enabled: boolean,
  now: Date = new Date(),
): { preferences: NotificationPreferences; changed: boolean; rejectedReason?: string } {
  if (!(type in NOTIFICATION_ROUTING_POLICY)) {
    return { preferences, changed: false, rejectedReason: `Unknown notification type "${type}".` };
  }
  if (isMandatoryNotificationType(type)) {
    return {
      preferences,
      changed: false,
      rejectedReason: `"${type}" is mandatory and cannot be disabled.`,
    };
  }
  const current = new Set(preferences.disabledTypes);
  const wasDisabled = current.has(type as NotificationType);
  if (enabled ? !wasDisabled : wasDisabled) {
    return { preferences, changed: false };
  }
  if (enabled) current.delete(type as NotificationType);
  else current.add(type as NotificationType);

  return {
    preferences: {
      ...preferences,
      disabledTypes: Array.from(current).sort(),
      revision: preferences.revision + 1,
      updatedAt: now.toISOString(),
    },
    changed: true,
  };
}

/** Mutes or unmutes optional alerts globally for this scope. */
export function setOptionalMuteUntil(
  preferences: NotificationPreferences,
  untilIso: string | null,
  now: Date = new Date(),
): { preferences: NotificationPreferences; changed: boolean; rejectedReason?: string } {
  let next: string | null = null;
  if (untilIso !== null) {
    if (!Number.isFinite(Date.parse(untilIso))) {
      return { preferences, changed: false, rejectedReason: "Mute-until must be a valid ISO timestamp." };
    }
    next = new Date(untilIso).toISOString();
  }
  if (next === preferences.optionalMutedUntil) return { preferences, changed: false };
  return {
    preferences: {
      ...preferences,
      optionalMutedUntil: next,
      revision: preferences.revision + 1,
      updatedAt: now.toISOString(),
    },
    changed: true,
  };
}

// ── Routing ──────────────────────────────────────────────────────────────────

export type RoutingDecision = "delivered" | "suppressed";
export type RoutingReason =
  | "mandatory_type"
  | "mandatory_severity_promotion"
  | "preferences_allow"
  | "disabled_by_preference"
  | "optional_muted";

export interface RoutingEvaluable {
  type: NotificationType | string;
  severity?: NotificationSeverity;
  identityKey?: string;
  expiresAt?: string | null;
}

export interface NotificationRoutingAuditRecord {
  id: string;
  /** Number of collapsed identical evaluations (duplicate dispatches). */
  count: number;
  firstAt: string;
  lastAt: string;
  scopeKey: string;
  identityKey: string | null;
  type: string;
  classification: RoutingClassification;
  severity: NotificationSeverity;
  decision: RoutingDecision;
  reason: RoutingReason;
  /** Preference revision evaluated against; 0 for default/absent document. */
  preferenceRevision: number;
}

export interface RoutingResult {
  deliver: boolean;
  classification: RoutingClassification;
  decision: RoutingDecision;
  reason: RoutingReason;
  audit: Omit<NotificationRoutingAuditRecord, "count" | "firstAt" | "lastAt"> & { at: string };
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Routes one notification against the wallet's durable preferences.
 *
 * Mandatory notifications are always delivered — an expired timestamp or a
 * disabled preference cannot suppress them. Optional notifications are
 * suppressed while disabled or within a global mute window. The returned
 * `audit` record explains the decision deterministically (same inputs ⇒ same
 * id and reason), so it can be persisted and reconciled later.
 */
export function routeNotification(
  input: RoutingEvaluable,
  preferences: NotificationPreferences,
  options: { scopeKey: string; now?: Date } = { scopeKey: "anonymous@testnet" },
): RoutingResult {
  const now = options.now ?? new Date();
  const classification = classifyNotification(input.type, input.severity);
  const severity = input.severity ?? getDefaultSeverity(input.type as NotificationType);
  const isMandatory = classification.classification === "mandatory";

  let reason: RoutingReason;
  if (isMandatory) {
    reason = classification.reason === "severity_promotion" ? "mandatory_severity_promotion" : "mandatory_type";
  } else if (preferences.disabledTypes.includes(input.type as NotificationType)) {
    reason = "disabled_by_preference";
  } else if (
    preferences.optionalMutedUntil !== null &&
    Number.isFinite(Date.parse(preferences.optionalMutedUntil)) &&
    Date.parse(preferences.optionalMutedUntil) > now.getTime()
  ) {
    reason = "optional_muted";
  } else {
    reason = "preferences_allow";
  }

  const decision: RoutingDecision = reason === "preferences_allow" || isMandatory ? "delivered" : "suppressed";
  const at = now.toISOString();

  return {
    deliver: decision === "delivered",
    classification: classification.classification,
    decision,
    reason,
    audit: {
      id: `route-${hashString(
        [options.scopeKey, input.type, input.identityKey ?? "", decision, reason, String(preferences.revision)].join("|"),
      )}`,
      at,
      scopeKey: options.scopeKey,
      identityKey: input.identityKey ?? null,
      type: input.type,
      classification: classification.classification,
      severity,
      decision,
      reason,
      preferenceRevision: preferences.revision,
    },
  };
}

// ── Bounded audit trail ──────────────────────────────────────────────────────

export const DEFAULT_ROUTING_AUDIT_LIMIT = 200;
export const ROUTING_AUDIT_STORAGE_PREFIX = "vaultquest:notification-routing-audit:";

export function routingAuditStorageKey(scopeKey: string): string {
  return `${ROUTING_AUDIT_STORAGE_PREFIX}${scopeKey}`;
}

/**
 * Appends a routing decision, collapsing consecutive identical evaluations
 * (same id) into one record with an incremented `count`. The log is bounded:
 * the oldest records are dropped first, and the result is sorted newest-first
 * with a deterministic tiebreak.
 */
export function appendRoutingAudit(
  existing: NotificationRoutingAuditRecord[],
  record: RoutingResult["audit"],
  limit: number = DEFAULT_ROUTING_AUDIT_LIMIT,
): NotificationRoutingAuditRecord[] {
  const index = existing.findIndex((entry) => entry.id === record.id);
  if (index !== -1) {
    const current = existing[index];
    const collapsed: NotificationRoutingAuditRecord = {
      ...current,
      count: current.count + 1,
      lastAt: record.at,
    };
    const next = existing.slice();
    next[index] = collapsed;
    return next;
  }

  const created: NotificationRoutingAuditRecord = {
    id: record.id,
    count: 1,
    firstAt: record.at,
    lastAt: record.at,
    scopeKey: record.scopeKey,
    identityKey: record.identityKey,
    type: record.type,
    classification: record.classification,
    severity: record.severity,
    decision: record.decision,
    reason: record.reason,
    preferenceRevision: record.preferenceRevision,
  };
  const next = [created, ...existing];
  if (next.length <= limit) return next;
  return next
    .slice()
    .sort((a, b) => {
      const byLast = Date.parse(b.lastAt) - Date.parse(a.lastAt);
      return byLast !== 0 ? byLast : a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

export function loadRoutingAudit(
  storage: PreferenceStorage | undefined,
  scopeKey: string,
  limit: number = DEFAULT_ROUTING_AUDIT_LIMIT,
): NotificationRoutingAuditRecord[] {
  if (!storage) return [];
  try {
    const text = storage.getItem(routingAuditStorageKey(scopeKey));
    if (!text) return [];
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is NotificationRoutingAuditRecord =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as NotificationRoutingAuditRecord).id === "string" &&
          typeof (entry as NotificationRoutingAuditRecord).decision === "string",
      )
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function saveRoutingAudit(
  storage: PreferenceStorage | undefined,
  scopeKey: string,
  audit: NotificationRoutingAuditRecord[],
): void {
  storage?.setItem(routingAuditStorageKey(scopeKey), JSON.stringify(audit));
}

/** Human-readable explanation of a routing reason for operator tooling. */
export function describeRoutingReason(reason: RoutingReason): string {
  switch (reason) {
    case "mandatory_type":
      return "Mandatory alert: delivered regardless of notification preferences.";
    case "mandatory_severity_promotion":
      return "Critical severity promoted this optional alert to mandatory for this delivery.";
    case "preferences_allow":
      return "Optional alert allowed: no preference disabled it and no mute window is active.";
    case "disabled_by_preference":
      return "Optional alert suppressed: the wallet disabled this notification type.";
    case "optional_muted":
      return "Optional alert suppressed: the wallet muted all optional alerts for this period.";
  }
}
