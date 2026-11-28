# Partial failure operator workflow

The maintainer-only dashboard at `/admin/partial-failures` lists unresolved and
retryable work, supports severity/type/state filters, and provides a summary.
Every endpoint requires `admin.recovery.read` or `admin.recovery.write`; write
requests also require the existing `X-Maintainer-Approval` scope and actor
binding. The backend remains the authorization boundary.

## Retry and recovery

The dashboard does not replay arbitrary side effects. An operator must first
retry the operation in its owning system, verify whether it completed, and
then record the result with `POST /admin/partial-failures/:id/retry`:

- `{"outcome":"resolved"}` marks it resolved and records the maintainer.
- `{"outcome":"still_failing"}` leaves it retryable and updates the retry time.

This avoids re-submitting financial or external effects without their specific
idempotency and compensation guarantees. If the operation cannot be retried,
resolve it with a required note after verifying recovery, or ignore it with a
required reason. Resolved and ignored records cannot be retried. Invalid state
transitions return `409`; missing records return `404`.

## Recording and duplicate detection

`POST /admin/partial-failures` records one issue for each
`(operation_type, operation_id)` pair. Concurrent detections are serialized
with a transaction-scoped PostgreSQL advisory lock; repeating a detection
returns the existing record. The API shape and existing table are unchanged.
Explicit `create()` service calls remain available to trusted code that needs a
distinct record.

Metadata is sanitized before storage: secret-like keys are redacted and
payload/body fields are omitted. Do not put credentials in the description or
external reference; those are operator-visible fields.

## Failure and rollback behavior

- A failed list/summary request is surfaced in the dashboard; refresh after the
  API or database recovers.
- A failed retry request leaves the record unchanged unless the server
  completed the state update; re-check the record before repeating an external
  operation.
- State transitions are audited. If audit recording fails after a transition,
  inspect the current record and audit trail before retrying or resolving it.
- No schema migration is required by this workflow. Roll back the application
  code if needed; existing partial-failure rows and audit entries remain
  intact and can be handled by the prior version.

## Verification

Run the route tests, state/service tests, and backend typecheck:

```bash
pnpm --dir backend exec vitest run tests/partialFailures.routes.spec.ts tests/maintainerOperations.spec.ts
pnpm --dir backend run build
```
