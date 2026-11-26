# Expiring Capability Grants for Sensitive Actions

`lib/capability-grants.ts` implements fine-grained, expiring, use-bounded capability tokens for sensitive administrative and recovery operations.

## Lifecycle & Invariants

1. **Dual-control issuance (`issueCapabilityGrant`)**:
   - `grantee !== approver` is enforced at creation (`CAPABILITY_SELF_APPROVAL`).
   - Duration is bounded to `[1ms, 24h]` (`MAX_CAPABILITY_DURATION_MS`).
   - `maxUses` defaults to `1` (single-use elevation) and is bounded to `1..=100`.
2. **Scoped consumption (`consumeCapabilityGrant`)**:
   - Checks revocation, wall-clock expiry (`now >= expiresAt`), actor identity (`actor === grantee`), action scope, and target resource (`resourceType:resourceId` or `*`).
   - Decrements `usesRemaining` and transitions to `exhausted` when `usesRemaining === 0`.
3. **Idempotent retry (`operationId`)**:
   - Retrying a guarded action with an already-recorded `operationId` on an active/exhausted (but unexpired and unrevoked) grant returns `{ deduplicatedRetry: true }` without burning a second use.
4. **Immediate revocation & rollback (`revokeCapabilityGrant`)**:
   - The original approver, the grantee (self-relinquish), or `admin`/`system` can revoke a grant at any time, zeroing `usesRemaining` and blocking all subsequent calls (including retries).

## Migration Plan

Existing coarse maintainer grants in `lib/access-grants.ts` remain untouched for backwards compatibility. Sensitive action endpoints adopt `CapabilityGrantRegistry.authorizeAndConsume` incrementally alongside a `capability_grants` persistence table keyed by `id` with an index on `(grantee, state, expires_at)`.
