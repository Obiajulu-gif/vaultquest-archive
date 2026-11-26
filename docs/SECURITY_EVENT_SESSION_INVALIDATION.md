# Security-event session invalidation (#1168)

`SecuritySessionManager.invalidateOnSecurityEvent` invalidates sessions and
increments the principal's token version as one operation. The authorization
check runs before the idempotency lookup so a retry cannot disclose a receipt
to an actor who is no longer authorized.

## Scope and retry rules

- `all_sessions` invalidates every active session for the principal.
- `all_except_current` requires `currentSessionId` to identify a session owned
  by the principal. The retained session receives the new token version.
- `single_session` requires `targetSessionId` to identify a session owned by
  the principal.
- An idempotency key is bound to the target principal, event, scope, selected
  session, actor, and reason. A retry with the same intent returns the original
  receipt without another version bump. Reusing the key for different intent
  fails with `IDEMPOTENCY_CONFLICT` (`409`). Retry timestamps do not change the
  intent fingerprint.

## Failure and recovery

Invalid or cross-principal scoped session IDs fail before mutation. The manager
restores the session snapshot and token version if invalidation fails while
applying. A caller may retry a transient failure with the same intent and key;
for a changed scope or target, generate a new idempotency key. Old tokens remain
invalid after a successful event; create a fresh session to restore access.

The in-memory manager is a deterministic model for the session boundary. A
production adapter must persist the revocations and token-version increment
transactionally and retain the same authorization and idempotency guarantees.
