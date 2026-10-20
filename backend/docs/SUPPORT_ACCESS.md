# Time-Bounded Maintainer Impersonation / Support Access

## Overview
Support access is modelled as an explicit **grant** the maintainer must possess before touching a scoped resource. Grants are scoped, time-bounded, and every use (or denied use) is recorded in an append-only, hash-chained audit trail.

## Grant Model
A `SupportAccessGrant` has:
- **requesterId** — the maintainer's identifier
- **reason** — why the grant was created
- **ticketRef** — an operator ticket reference
- **scopeType** — one of `wallet`, `indexer`, `quests`
- **scope** — the specific resource the grant applies to (e.g. a Stellar address for `wallet` scope)
- **expiresAt** — absolute expiry, enforced on every `authorize()` call via injected clock
- **revokedAt / revokedBy** — optional revocation metadata

## TTL Limits
- **minTtlMinutes**: 1 (hard floor)
- **defaultTtlMinutes**: 30
- **maxTtlMinutes**: 240 (4 hours, hard cap)
Requested TTLs outside this range are rejected with a 400 validation error.

## Authorization Flow (`authorize`)
Every `authorize()` call:
1. Looks up the grant by `grantId`.
2. If not found → appends `access_denied` to audit trail; returns `allowed: false` with `denial_reason: "grant_not_found"`.
3. If revoked → returns `allowed: false`, `denial_reason: "grant_revoked"`.
4. If expired ( `expiresAt <= now` ) → returns `allowed: false`, `denial_reason: "grant_expired"`.
5. If scope mismatch (`scopeType` or `scope` differ) → returns `allowed: false`, `denial_reason: "scope_mismatch"`.
6. If all checks pass → appends `grant_used` to audit trail; returns `allowed: true`, `notice` (user-safe text), `expiresAt`, and `remaining_ms` until expiry.

**Fail-closed**: if the audit append throws (e.g. DB failure), the call throws instead of returning data; no state is returned to the caller.

## Immutable Audit Trail (`SupportAccessAuditEntry`)
- Every outcome — allowed or denied — appends a `SupportAccessAuditEntry` record.
- Records: `grantId`, `actor`, `action`, `scope`, `detail`, `prevHash`, `entryHash`.
- **Hash chain**: each `entryHash = sha256( {grant_id, actor, action, scope, detail, created_at, prev_hash} )`.
- **Append-only at DB layer**: a PostgreSQL trigger `support_access_audit_immutable` blocks all `UPDATE` and `DELETE` on the audit table, raising `'support_access_audit is append-only; UPDATE/DELETE rejected'`. The chain is verified globally via `verifyAuditChain()`.

## Audit Chain Verification (`verifyAuditChain`)
- Fetches all `SupportAccessAuditEntry` rows ordered by `created_at ASC, id ASC`.
- Recomputes each `entryHash` from the canonical payload and the previous `prevHash`.
- Returns `{ valid: boolean, entries: number, broken_at?: string }` — if a mismatch is found, `broken_at` is the id of the first broken entry.

## User-Safe Notices (`buildSupportNotice`)
The notice rendered for the user includes:
- An agent badge: first 8 hex chars of `sha256(requesterId)` — never exposes the maintainer's real identifier.
- Scope and ticket reference (sanitised via `sanitizeRenderedText`).
- Expiry ISO timestamp.
- A statement that the grant is audit-logged.
- The raw `reason` text is deliberately **excluded** from the notice.

## Revocation (`revokeGrant`)
Sets `revokedAt` and `revokedBy` on the grant; appends `grant_revoked` to the audit trail. Idempotent if already revoked.

## Public Notices Endpoint (`GET /support-access/notices?wallet=G...`)
- Queries active/previous grants scoped to the requested wallet (looking back `NOTICE_LOOKBACK_DAYS = 30` days).
- For each grant, renders a notice via `buildSupportNotice`.
- Notice text includes the agent badge, ticket reference (sanitised), scope, expiry — never the raw reason or requester identity.

## Operational Edge Cases
- **Automatic expiry**: every `authorize()` call re-evaluates `expiresAt` against the injected clock — no background cleanup job needed.
- **Scope validation**: `wallet` scope requires a Stellar address matching `^G[A-Z0-9]{55}$`; other scopes match `[A-Za-z0-9:_-]{1,120}`.
- **Denial reasons**: `"grant_not_found"`, `"grant_revoked"`, `"grant_expired"`, `"scope_mismatch"` — machine-readable, reported in the API error code `SUPPORT_ACCESS_DENIED` (403).
- **Audit immutability**: even direct SQL `UPDATE`/`DELETE` on `support_access_audit` is rejected by the DB trigger; the only way to alter history is through the verified append API.
- **Fail-closed audit**: if audit append fails mid-authorize, the call throws — the caller never receives a partial result.
- **Ticket references**: run through `sanitizeRenderedText` before appearing in user notices, neutralising `<script>` / control characters.

## API Surface
### Internal Routes (service-secret protected)
- `POST /internal/support-access/grants` — create a new grant (body: requester_id, reason, ticket_ref, scope_type, scope, ttl_minutes?)
- `POST /internal/support-access/grants/:id/revoke` — revoke a grant
- `POST /internal/support-access/access` — attempt a scoped access (body: grant_id, scope_type, scope, actor?)
- `GET /internal/support-access/grants/:id/audit` — retrieve the audit trail for a grant
- `GET /internal/support-access/audit/verify` — verify the global hash-chain integrity

### Public Route
- `GET /support-access/notices?wallet=G...` — user-safe notices for a wallet

## Database Migration (`20261016000000_support_access_and_imports`)
- Creates `support_access_grants`, `support_access_audit` (with immutability trigger), `import_batches`, `import_rows`.
- The audit trigger:
  ```sql
  CREATE OR REPLACE FUNCTION support_access_audit_immutable()
  RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'support_access_audit is append-only; UPDATE/DELETE rejected';
  END;
  $$ LANGUAGE plpgsql;
  
  CREATE TRIGGER support_access_audit_no_mutation
    BEFORE UPDATE OR DELETE ON "support_access_audit"
    FOR EACH ROW EXECUTE FUNCTION support_access_audit_immutable();
  ```

## Reset in Tests (`tests/helpers/db.ts`)
- `resetDb` truncates `support_access_audit` via `TRUNCATE TABLE "support_access_audit"` (bypasses row-level triggers while respecting table-level permissions).
- All other tables cleared via `deleteMany`.

## Files
- `backend/src/services/supportAccessService.ts` — `SupportAccessService` class
- `backend/src/routes/supportAccess.ts` — route plugins
- `backend/src/schemas/supportAccess.ts` — Zod schemas
- `backend/prisma/schema.prisma` — `SupportAccessGrant`, `SupportAccessAuditEntry`
- `backend/prisma/migrations/20261016000000_support_access_and_imports/migration.sql` — migration with tables + trigger
- `backend/tests/support-access.spec.ts` — integration tests
- `docs/SUPPORT_ACCESS.md` — this document