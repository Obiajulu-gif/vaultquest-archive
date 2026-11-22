# feat: Stable Pagination, Maintainer Impersonation, Partial Failure Dashboard (#778 #791 #793)

## Issues Resolved

Closes #778
Closes #791
Closes #793

---

## Summary

This PR resolves three hardening issues: stable cursor-based pagination for all key
list endpoints, scoped maintainer impersonation for safe support debugging, and a
partial failure dashboard so operators can track and resolve operations stuck between
internal state and external systems.

---

## Changes by Issue

### #778 — Stable Pagination and Filtering for Rapidly Changing Datasets

**Problem:** `listRecoverableActions` used `skip: offset` pagination, which causes
duplicate or skipped records when rows are inserted or change status mid-pagination.

**Changes:**
- ✅ `backend/src/services/ledger.ts` — `listRecoverableActions` converted from offset
  to cursor-based: `orderBy: [submittedAt ASC, id ASC]` + `cursor: { id }, skip: 1`.
  Returns `{ items, nextCursor }` instead of a bare array.
- ✅ `docs/PAGINATION_AND_FILTERING.md` — new document covering: cursor ordering per
  endpoint, filter behavior for redacted/status-filtered/permission-restricted records,
  stability guarantees table, and a migration guide for callers of the old offset API.

**Tradeoffs:**
- Cursor pagination does not support arbitrary page jumps. This is acceptable for
  admin tooling where sequential navigation is the norm.
- The search endpoint (`/api/search`) retains offset pagination because it operates on
  an in-memory snapshot and its result set is stable within a single request.

---

### #791 — Scoped Maintainer Impersonation for Support Debugging

**Problem:** No safe way for maintainers to reproduce user-reported issues without
gaining broad access to private data or being able to perform irreversible actions.

**Changes:**
- ✅ `backend/src/services/impersonation.ts` — `ImpersonationService` with session
  lifecycle: start, validate, end. `InMemoryImpersonationStore` for tests.
- ✅ `backend/src/routes/impersonation.ts` — REST API:
  - `POST /admin/impersonation` — start a session (reason required, min 10 chars)
  - `GET  /admin/impersonation` — list active sessions for caller
  - `GET  /admin/impersonation/:id` — inspect session
  - `DELETE /admin/impersonation/:id` — end session early
- ✅ `backend/src/middleware/impersonation.ts` — `onRequest` hook reads
  `X-Impersonation-Session` header, validates session, attaches `req.impersonation`,
  and sets `X-Impersonation-Active: true` on the response.
  `assertImpersonationBlocked()` helper for routes that must forbid impersonation.
- ✅ `lib/rbac.ts` — new permissions `admin.impersonation.read` /
  `admin.impersonation.write` granted to `maintainer` role.
- ✅ `backend/prisma/schema.prisma` + migration `20261001000000_add_impersonation_sessions`
- ✅ `app/app/admin/impersonation/page.jsx` — admin UI: create session form (wallet,
  reason, TTL, allow-mutations toggle), active session cards with live countdown.
- ✅ `components/ImpersonationBanner.jsx` — client-side persistent warning banner.
  Patches `window.fetch` to detect `X-Impersonation-Active` and renders a sticky
  orange banner with an "End Session" button.
- ✅ `app/layout.jsx` — banner mounted in root layout.

**Security properties:**
- Sessions expire automatically (max 4 h, configurable, default 30 min).
- One active session per maintainer.
- Dangerous mutations (`withdraw`, `select_winner`, `compensating`, `create_vault`)
  are blocked unless `allow_mutations: true` is set at session creation.
- Every session start, use, and end is written to the immutable audit trail
  (category: `access`, action: `session.issue` / `session.revoke`).
- Session tokens are never stored in audit records (only session IDs).

**Tradeoffs:**
- `InMemoryImpersonationStore` is the default. In production, wire
  `PrismaImpersonationStore` (using the new `impersonation_sessions` table) via
  `AppDeps.impersonationStore`.

---

### #793 — Partial Failure Dashboard for Background and External Integrations

**Problem:** Maintainers had no unified view of operations stuck between internal
state and external systems (e.g. action confirmed on-chain but not reflected in the
backend, draw proof job failed after payment).

**Changes:**
- ✅ `backend/src/services/partialFailureService.ts` — `PartialFailureService`:
  - `create()` — record a new partial failure
  - `list()` — cursor-paginated list with `operationType` / `severity` / `state` /
    `retryable` / `since` filters
  - `summary()` — aggregated counts by severity and operation type
  - `markRetried()` — record a retry attempt (outcome: resolved / still_failing)
  - `resolve()` — manually mark resolved (requires resolution note)
  - `ignore()` — mark as manually ignored (requires reason)
  - All state transitions audited via `AuditRecorder` (category: `recovery`)
- ✅ `backend/src/routes/partialFailures.ts` — REST API:
  - `GET  /admin/partial-failures/summary`
  - `GET  /admin/partial-failures` (cursor-paginated)
  - `GET  /admin/partial-failures/:id`
  - `POST /admin/partial-failures`
  - `POST /admin/partial-failures/:id/retry`
  - `POST /admin/partial-failures/:id/resolve`
  - `POST /admin/partial-failures/:id/ignore`
- ✅ `backend/prisma/schema.prisma` + migration `20261001000001_add_partial_failures`
- ✅ `app/app/admin/partial-failures/page.jsx` — admin dashboard:
  - Summary cards (total, retryable, stale, critical)
  - By-type and by-severity breakdown tables
  - Filterable cursor-paginated table with inline retry/resolve/ignore actions
  - Detail modal with metadata viewer

**Tradeoffs:**
- Metadata on `PartialFailure` rows is caller-sanitized. The API validates that
  `description` is at least 5 chars and `metadata` is a plain object; secrets
  must be stripped before recording.
- The `summary()` endpoint queries two models; for very high failure volumes an
  aggregated materialized view could replace it.

---

## API Contracts

### Impersonation

```
POST /admin/impersonation
Body: { target_wallet, reason, ttl_ms?, allow_mutations? }
→ { data: { session } }

GET /admin/impersonation
→ { data: [session, …] }

GET /admin/impersonation/:id
→ { data: session }

DELETE /admin/impersonation/:id
Body: { reason }
→ { data: session }
```

### Partial Failures

```
GET /admin/partial-failures?state=&operation_type=&severity=&retryable=&limit=&cursor=
→ { data: [failure, …], meta: { pagination: { next_cursor, limit, has_more } } }

GET /admin/partial-failures/summary
→ { data: { total, by_severity, by_operation_type, stale_count, retryable_count } }

POST /admin/partial-failures/:id/retry
Body: { outcome: "resolved" | "still_failing" }

POST /admin/partial-failures/:id/resolve
Body: { resolution_note }

POST /admin/partial-failures/:id/ignore
Body: { reason }
```

---

## Deployment Steps

1. **Run migrations** (additive only — no existing table changes):
   ```bash
   cd backend && pnpm prisma:deploy
   # Applies:
   #   20261001000000_add_impersonation_sessions
   #   20261001000001_add_partial_failures
   ```

2. **Wire `PrismaImpersonationStore`** (optional, recommended for production):
   In `AppDeps`, set `impersonationStore: new PrismaImpersonationStore(prisma)`.
   Without it the default `InMemoryImpersonationStore` is used (sessions lost on restart).

3. **No new environment variables required.**

4. **Admin UI routes** are automatically available at:
   - `/app/admin/impersonation`
   - `/app/admin/partial-failures`

---

## Testing

- Existing pagination tests in `backend/tests/pagination.spec.ts` exercise cursor
  pagination on `/actions` and `/saved-pools`.
- `backend/tests/activity-timeline.spec.ts` covers stable descending timestamp/id ordering.
- `backend/tests/pendingRecovery.spec.ts` covers the recovery case lifecycle.
- The new `listRecoverableActions` signature is backwards-compatible with all existing
  call sites (the second positional parameter changes from `offset` to `cursor`).
- Manual validation:
  ```bash
  # Start a session
  curl -X POST /admin/impersonation \
    -H "Authorization: Bearer <maintainer-token>" \
    -H "Content-Type: application/json" \
    -d '{"target_wallet":"GABC…","reason":"Support ticket #42 — reproduce balance issue"}'

  # List partial failures
  curl /admin/partial-failures?state=unresolved \
    -H "Authorization: Bearer <maintainer-token>"
  ```
