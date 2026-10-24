# Notification preferences and mandatory-alert routing

`lib/notification-routing.ts` sits above the deduplication model in
[`NOTIFICATIONS.md`](./NOTIFICATIONS.md) and decides **whether a notification
is delivered to a wallet**, given the wallet's durable preferences.

Two guarantees drive the design:

1. **Optional alerts respect preferences.** A wallet can disable individual
   optional types (reminders, confirmations, APY updates) and mute all
   optional alerts for a window of time.
2. **Mandatory alerts stay deliverable.** Security, lifecycle, governance, and
   recovery alerts bypass preferences entirely, and every routing decision is
   recorded in a bounded audit trail.

## Classification

`NOTIFICATION_ROUTING_POLICY` classifies every notification type:

| Classification | Types |
| --- | --- |
| Mandatory | `action_failed`, `recovery_failed`, `recovery_path_available`, `recovery_resolved`, `approval_required`, `protocol_alert`, `vault_pause` |
| Optional | `apy_change`, `pending_transaction`, `reward_event`, `deposit`, `withdrawal`, `round_update`, `account`, `action_completed`, `maturity`, `claim_window` |

Two rules extend the table:

- **Severity promotion.** Any notification dispatched with `severity:
  "critical"` is treated as mandatory for that delivery, even if its type is
  optional. Operators can escalate a rare alert without a catalog change.
- **Mandatory types cannot be disabled.** `setOptionalNotificationEnabled`
  rejects them, and `sanitizeNotificationPreferences` strips mandatory (and
  unknown) entries out of stored preference documents, recording a repair
  note. A corrupt or hand-edited document can therefore never mute a security
  alert.

## Durable preference document

Preferences are stored per wallet+network scope under
`vaultquest:notification-preferences:<scopeKey>` with schema version 2:

```json
{
  "schemaVersion": 2,
  "disabledTypes": ["claim_window"],
  "optionalMutedUntil": "2026-10-20T00:00:00.000Z",
  "revision": 4,
  "updatedAt": "2026-10-16T12:00:00.000Z"
}
```

- `revision` increments on every real change and is stamped into audit
  records, so a suppressed alert can be tied to the exact preference revision
  that suppressed it.
- Legacy shapes (a bare `string[]`, or `{ disabledTypes }` from older
  deployments) are migrated automatically on load.
- Missing, unreadable, or corrupt documents degrade to all-deliver defaults
  and record a repair note; they never block the notification center.

## Routing decisions and audit trail

`routeNotification` returns `{ deliver, classification, reason, audit }`.
Reasons: `mandatory_type`, `mandatory_severity_promotion`,
`preferences_allow`, `disabled_by_preference`, `optional_muted`.

Decisions are appended to a bounded (default 200 records) newest-first audit
trail under `vaultquest:notification-routing-audit:<scopeKey>`. Repeated
identical evaluations (same scope, type, identity, decision, reason, and
revision) collapse into one record with a `count` and `lastAt` timestamp
instead of flooding the log. Audit ids are deterministic hashes, so the same
evaluation always produces the same id.

The React integration (`src/providers/NotificationProvider.tsx`) exposes:

- `preferences`, `setOptionalEnabled(type, enabled)`, `muteOptionalUntil(iso)`,
- `routingAudit`, `clearRoutingAudit()`,
- optional `onPreferencesChange` and `onRoutingDecision` callbacks for
  logging/telemetry; both are additive and the provider stays
  backwards-compatible when they are omitted.

Seed alerts (`initialAlerts`) are routed through the same model, so a
disabled optional type cannot enter state through seeding, and their
evaluations are visible in the audit trail.

## Operational edge cases

| Edge case | Behavior |
| --- | --- |
| Storage disabled (private mode / quota exceeded) | Queue of preferences and audit degrades to in-memory; delivery guarantees unchanged. The change is not durable across reloads. |
| Corrupt stored preference JSON | Loads defaults, records "Discarded unreadable stored notification preferences", keeps working. |
| Stored document lists a mandatory type as disabled | Entry is stripped on load with a repair note; the mandatory alert delivers. |
| Mute window in the past | Treated as expired; notifications deliver and the reason is `preferences_allow`. |
| Invalid mute timestamp supplied | Rejected (`changed: false`, `rejectedReason`), document untouched. |
| Two tabs change preferences | Each tab persists the full document (last write wins per revision). Audit trails collapse by deterministic id. |
| Wallet switches accounts | Preferences and audit are scoped by `scopeKey` (wallet+network), so another account's mute choices never apply. |

## Failure modes and recovery

- **Alert suppressed that should have been delivered.** Read the audit trail
  for the scope: `disabled_by_preference` / `optional_muted` entries name the
  type and preference revision. Re-enable the type
  (`setOptionalEnabled(type, true)`) or clear the mute
  (`muteOptionalUntil(null)`). Mandatory alerts can never be suppressed this
  way — if one is missing, check targeting/`scopeKey` instead.
- **Preference change did not stick.** The storage write failed silently by
  design (the in-memory state still worked). Re-apply the change in a session
  where storage is available; the current document is shown by
  `preferences.revision`.
- **Audit trail grows stale or too long.** It is bounded; the oldest records
  drop first. `clearRoutingAudit()` resets it (e.g. before handing a device to
  another user). The audit is diagnostic, not a source of truth: the backend
  delivery log remains authoritative for backend-originated alerts.

## Rollback

Reverting the feature is behavior-neutral: pass no `preferences` prop and the
provider loads all-deliver defaults (identical to pre-routing behavior); the
stored preference documents are ignored by older versions. To fully remove
stored state, delete keys prefixed `vaultquest:notification-preferences:` and
`vaultquest:notification-routing-audit:`.

## Verification

```bash
pnpm exec vitest run tests/notification-routing.test.ts tests/notification-provider-routing.test.tsx tests/notification-dedup.test.tsx
```
