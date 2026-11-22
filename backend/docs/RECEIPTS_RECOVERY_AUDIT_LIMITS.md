# Receipts, pending-action recovery, audit trail and operation limits

Covers issues **#812** (signed activity receipts), **#813** (recovery for stuck
pending actions), **#814** (immutable audit trail for ownership and access
changes) and **#815** (policy-based limits for expensive operations).

The four features share one building block, the **audit trail** (#814):
recovery transitions (#813) and limit overrides/resets (#815) are written to
the same append-only, hash-chained log as access changes.

| Concern | Service | Routes | Store (tests / prod) |
|---|---|---|---|
| #812 receipts | `src/services/receipts.ts` | `src/routes/receipts.ts` | `InMemoryReceiptStore` / `PrismaReceiptStore` (`action_receipts`) |
| #813 recovery | `src/services/pendingRecovery.ts` | `src/routes/recovery.ts` | `InMemoryRecoveryCaseStore` / `PrismaRecoveryCaseStore` (`recovery_cases`) |
| #814 audit trail | `src/services/auditTrail.ts` | `src/routes/auditTrail.ts` | `InMemoryAuditTrailStore` / `PrismaAuditTrailStore` (`audit_trail`) |
| #815 limits | `src/services/operationLimits.ts`, `src/middleware/operationLimit.ts` | `src/routes/operationLimits.ts` | in-memory or Redis counters; `PrismaLimitOverrideStore` (`limit_overrides`) |

Every service keeps its storage behind an interface (the pattern used by
`changeHistoryService.ts` and `invitationService.ts`), so the unit tests run
the real business rules against in-memory stores with no database.

---

## #812 Signed activity receipts

**Critical operations:** every `ActionLedger` action of type `deposit`,
`withdraw`, `claim`, `create_vault` or `select_winner`. `compensating` actions
are internal and get no receipt.

**One receipt per (action, stage).** Stages mirror the ledger status:
`requested` (pending) → `submitted` → `confirmed` / `failed` / `reverted` /
`orphaned`. Earlier receipts are kept, so an action's receipts form its signed
timeline.

**Payload** (canonical JSON, keys sorted):

```json
{
  "version": 1,
  "receiptId": "rcpt_<sha256(actionId:stage)[0..40]>",
  "operation": "deposit",
  "stage": "confirmed",
  "actionId": "…uuid…",
  "idempotencyKey": "…uuid…",
  "actor": { "walletAddress": "G…" },
  "requestDigest": "<sha256 of canonical {walletAddress, actionType, actionPayload, idempotencyKey}>",
  "requestedAt": "2026-09-29T10:00:00.000Z",
  "occurredAt": "2026-09-29T10:02:13.000Z",
  "externalRefs": { "txHash": "…", "sorobanEventId": "…", "correlationId": "…" },
  "errorCode": null
}
```

- **Stable:** the payload is derived only from the ledger row, never from the
  clock. The same action and stage always produce the same bytes and the same
  `receiptId`.
- **Duplicate requests:** a repeated `POST /actions` with the same
  `Idempotency-Key` returns the existing receipt. Issuance is insert-if-absent
  on `receiptId`.
- **Verifiable:** ed25519 signature over `"vaultquest-receipt:v1\n" + canonicalJson(payload)`,
  made with the Stellar keypair in `RECEIPT_SIGNING_SECRET`. `keyId` is the
  public `G…` key, so anyone can verify offline with
  `Keypair.fromPublicKey(keyId).verify(message, Buffer.from(signature, "base64"))`.
- **Tamper detection:**
  - Changing any payload field breaks the signature (`BAD_SIGNATURE`).
  - A re-signed or forged receipt fails `STORED_COPY_MISMATCH` / `NOT_ISSUED`.
  - `GET /admin/receipts/:id/verify` re-derives the payload from the ledger
    row and reports `LEDGER_MISMATCH` if either the receipt or the ledger was
    edited afterwards.
- **No hidden payload:** the raw `action_payload` is not in the receipt;
  `requestDigest` commits to it.

**When receipts are issued:**
- After `POST /actions`, `PATCH /actions/:id/submitted` and `POST /actions/:id/cancel`.
- After `POST /internal/reconcile` matches a transaction.

If an issuance hook fails, the error is logged and the committed operation is
not rolled back. `GET /actions/:id/receipts` issues any missing receipt for the
current stage, so lookups heal gaps.

| Route | Access |
|---|---|
| `GET /receipts/public-key` | public |
| `POST /receipts/verify` `{ "receipt": {…} }` | public, limited by `receipt.verify` |
| `GET /receipts/:id` | owner wallet (`own.receipts.read`) or maintainer (`admin.receipts.read`); another wallet gets **403** |
| `GET /actions/:id/receipts` | owner or maintainer |
| `GET /admin/receipts/:id/verify` | maintainer |

Receipts are returned verbatim (camelCase), because renaming keys would
invalidate the signature.

## #813 Recovery for stuck pending actions

An action in `pending` or `submitted` that hasn't changed for
`PENDING_STALE_THRESHOLD_MINUTES` (default 30) is **stale**.

| State | Meaning |
|---|---|
| `pending` | in flight, under the threshold (derived; no case yet) |
| `retryable` | stale; a retry may still resolve it |
| `failed` | `RECOVERY_MAX_ATTEMPTS` (default 3) retries used up; needs a maintainer |
| `manual_review` | escalated to a maintainer |
| `resolved` | terminal: resolved automatically, or by a maintainer (`failed` or `dismissed`) |

The next state is a pure function of (state, attempts, max attempts, retry
outcome):

```
pending ──stale──► retryable ──retry ok──► resolved
                   retryable ──retry fails──► retryable (attempts < max) | failed (attempts = max)
retryable|failed ──escalate──► manual_review
retryable|failed|manual_review ──resolve──► resolved
```

- A **retry** re-reads the ledger through a pluggable `RecoveryExecutor`. If
  the action has moved on (confirmed, failed…), the case resolves; if it is
  still in flight, the attempt counts as failed. An executor crash is a failed
  attempt, never a success.
- **Resolve as `failed`** fails the ledger action first (through
  `LedgerService.cancelAction`, so the ledger's own transition rules apply) and
  only then closes the case. **`dismissed`** closes the case without touching
  the ledger.
- Every transition, including automatic detection, is written to the audit
  trail (`category: "recovery"`) with actor, reason and before/after state.
  Updates use optimistic concurrency (`version`), so two maintainers can't
  both apply a transition.
- **Visibility:** `GET /admin/recovery/diagnostics` reads stale actions straight
  from the ledger, so they appear the moment they cross the threshold, before
  any scan. The owner's `GET /actions/:id/recovery` opens the case on demand.

| Route | Access |
|---|---|
| `GET /actions/:id/recovery` | owner: state, user-safe message, `can_retry` |
| `POST /actions/:id/recovery/retry` | owner, while `retryable`; limited by `recovery.retry` |
| `GET /admin/recovery/diagnostics?sample=25` | `admin.recovery.read` |
| `GET /admin/recovery/cases?state=` | `admin.recovery.read` |
| `POST /admin/recovery/scan` | `admin.recovery.write` (run from a cron/worker if you want cases opened in bulk) |
| `POST /admin/recovery/cases/:id/{retry,escalate,resolve}` | `admin.recovery.write`; escalate/resolve need a `reason` |

## #814 Immutable audit trail

**Audited access changes:**
- **Invitations** (the vault-access grant path): `invitation.create`,
  `invitation.accept`, `invitation.revoke`, `invitation.expire`.
- **Wallet sessions:** `session.issue`, `session.refresh`, `session.revoke`,
  `session.revoke_all`.
- **Admin sessions:** `admin_session.issue`, `admin_session.revoke`,
  `admin_session.revoke_role`.
- **Reserved for callers of `AuditTrailService.record`:** `role.grant`,
  `role.revoke`, `permission.grant`, `permission.revoke`,
  `ownership.transfer`. The `access` category rejects unknown actions, and
  role, permission and ownership changes require a reason.

**Record:** `sequence` (global, gap-free), `category`, `action`,
`actor {subject, role}`, `target {type, id}`, `reason`, `before`, `after`,
`metadata`, `redactedFields`, `occurredAt`, `prevHash`, `recordHash`.

**Immutability:**
1. The store API is append-only (no update or delete).
2. A Postgres trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` on `audit_trail`.
3. `recordHash = sha256(canonicalJson(record without recordHash))` chains
   through `prevHash`. `GET /admin/audit-trail/verify` reports `ALTERED`,
   `BROKEN_LINK` and `SEQUENCE_GAP`, even if someone disabled the trigger.

**No secrets or hidden payloads:** before hashing, `before`/`after`/`metadata`
pass through `sanitizeAuditState`:
- Keys that look like credentials (token, secret, password, signature, seed,
  nonce, challenge, api key, authorization, cookie, session id) become
  `"[REDACTED]"`.
- Stellar secret seeds, JWTs and bearer strings become `"[REDACTED]"`
  whatever the key.
- Raw payloads, bodies and headers become `"[OMITTED]"`.
- The withheld paths are listed in `redactedFields`.

Session records reference the session row id, and admin sessions a sha256
fingerprint, never the token.

| Route | Access |
|---|---|
| `GET /admin/audit-trail?category&action&actor&target_type&target_id&since&until&cursor&limit` | `admin.audit_trail.read` |
| `GET /admin/audit-trail/export?format=ndjson\|csv` | `admin.audit_trail.export`, limited by `audit.export`, max 5,000 rows, includes hashes for offline re-verification, CSV cells escaped against formula injection |
| `GET /admin/audit-trail/verify` | `admin.audit_trail.read` |

The older `GET /admin/audit` (protocol parameter changes) is unchanged.

## #815 Operation limits

| Operation | Consumes | Default | Scope |
|---|---|---|---|
| `action.create` | storage, indexing | 30 / min | wallet (from the body; IP if absent) |
| `data.export` | compute, storage | 10 / hour | wallet |
| `data.import` | storage | 10 / hour | wallet |
| `receipt.verify` | compute | 120 / min | IP |
| `wallet_auth.challenge` | storage | 20 / 10 min | IP |
| `recovery.retry` | external (chain lookups) | 10 / hour | wallet |
| `audit.export` | compute | 20 / hour | subject |

- **Server-side, consistent:**
  - Guarded routes chain `enforceOperationLimit` after the permission guard,
    so limits are keyed by the authenticated identity.
  - Public routes are matched by method + route pattern in an app-level
    preHandler, so query strings and trailing slashes can't bypass them.
  - Counters use Redis when `REDIS_URL` is set (shared across replicas),
    otherwise they are per process.
  - A missing wallet falls back to the client IP, never to "unlimited".
- **Configuration:** `OPERATION_LIMITS='{"action.create":{"limit":50,"windowSeconds":60}}'`.
  Unknown operations or bad numbers fail at boot.
- **Overrides:**
  - Scoped to one operation and one scope key (`wallet:…`, `ip:…`, `subject:…`).
  - Must expire within 30 days, must have a reason, and are capped at 100× the base limit.
  - At most one active override per (operation, scope key).
  - Grant and revoke are audited (`limits.override.grant` / `limits.override.revoke`).
- **Reset:** clears the current window for one operation and scope key
  (audited as `limits.reset`). Windows also reset on their own at `reset_at`.
- **Error:** HTTP 429 `OPERATION_LIMIT_EXCEEDED` with a `Retry-After` header:

```json
{
  "error": {
    "code": "OPERATION_LIMIT_EXCEEDED",
    "category": "rate_limit",
    "retryable": true,
    "message": "Limit reached for action.create: 30 per minute. Wait for your pending actions to finish before starting new ones, then try again after the limit resets.",
    "recovery": "Wait until the limit resets (see the Retry-After header), or follow the remediation in the error details.",
    "details": {
      "operation": "action.create",
      "limit": 30,
      "window_seconds": 60,
      "retry_after_seconds": 42,
      "reset_at": "2026-09-29T10:01:00.000Z",
      "remediation": "Wait for your pending actions to finish before starting new ones, then try again after the limit resets."
    }
  }
}
```

Successful limited requests carry `X-Operation-Limit`,
`X-Operation-Limit-Remaining` and `X-Operation-Limit-Reset`.

| Route | Access |
|---|---|
| `GET /admin/limits` | `admin.limits.read` — policies + active overrides |
| `GET /admin/limits/usage?operation&scope_key` | `admin.limits.read` |
| `POST /admin/limits/overrides` `{operation, scope_key, limit, duration_seconds, reason}` | `admin.limits.write` |
| `POST /admin/limits/overrides/:id/revoke` `{reason}` | `admin.limits.write` |
| `POST /admin/limits/reset` `{operation, scope_key, reason}` | `admin.limits.write` |

## Configuration and deployment

| Variable | Default | Notes |
|---|---|---|
| `RECEIPT_SIGNING_SECRET` | — | Stellar secret seed (`S…`). **Set it in every shared environment.** Without it, an ephemeral key is generated per process and receipts stop verifying after a restart (logged as a warning, and `GET /receipts/public-key` reports `"ephemeral": true`). |
| `RECEIPT_PREVIOUS_PUBLIC_KEYS` | — | Comma-separated `G…` keys still trusted after a rotation. |
| `PENDING_STALE_THRESHOLD_MINUTES` | 30 | |
| `RECOVERY_MAX_ATTEMPTS` | 3 | 1–20 |
| `OPERATION_LIMITS` | — | JSON, see above. |

**Migration:** `20260929000000_add_receipts_recovery_audit_limits` is
additive. It adds four tables, a partial index on `action_ledger(updated_at)
WHERE status IN ('pending','submitted')`, and the audit-trail immutability
trigger. Run `pnpm --filter @trustquest/backend prisma:deploy`. No backfill
is needed: receipts for existing actions are issued lazily on first lookup.

**Rollback:** drop the four new tables, the partial index and the
`audit_trail_block_mutation()` function. Nothing else depends on them.

## Validation

```bash
cd backend
npx vitest run tests/receipts.spec.ts tests/pendingRecovery.spec.ts \
  tests/auditTrail.spec.ts tests/operationLimits.spec.ts tests/governanceRoutes.spec.ts \
  tests/governanceStores-unit.spec.ts tests/rbac.spec.ts
```

None of these need Docker or a database.
