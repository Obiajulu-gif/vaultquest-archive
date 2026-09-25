# VaultQuest API Contract Reference

Developer-facing reference for the VaultQuest backend REST API. Covers pool
actions, dashboard summary, saved-pools watchlist, and activity export.
Frontend contributors can build UI integrations against these shapes without
reading the backend source.

All responses use `application/json` unless noted. Successful responses wrap
data in `{ "data": ... }`. Paginated responses include a `meta.pagination`
block. Errors return the envelope described under [Standard errors](#standard-errors).

> **Contract tests.** The shapes in this file are enforced by
> `backend/tests/apiContract.spec.ts` against the schemas in
> `backend/src/contracts/apiContract.ts`. Every JSON block tagged
> `contract=<name>` is validated, the route index below is compared with the
> routes the server registers, and the error table is compared with the error
> catalog. Run them with `pnpm --filter backend exec vitest run tests/apiContract.spec.ts`.
> If you change a response, update the schema **and** this file, or CI fails.

---

## Authentication and request headers

| Access level | How to authenticate | Used by |
|---|---|---|
| Public | Nothing. Wallet-scoped reads take the wallet address as a query parameter and the API trusts it. | Actions, dashboard, saved pools, health |
| CSRF (browser clients) | Every non-`GET` request outside `/internal/*` needs the `csrf-token` cookie **and** an identical `X-CSRF-Token` header. Any `GET` response sets both. Missing or mismatched → `403 FORBIDDEN`. | All mutating public routes |
| API key | `X-Api-Key: <key>`. Enforced only when the server has `API_KEY` configured. | `/api/actions/:walletAddress`, `/api/metrics*`, `/api/v1/metrics/*`, `/api/categories`, `POST /dashboard/aggregates/refresh` |
| Wallet session | `Authorization: Bearer <token>` from `POST /wallet-auth/verify`. | `/api/users/me` |
| Admin session | `Authorization: Bearer <token>` for an allow-listed admin wallet. | `/admin/audit*` |
| Service secret | `X-Internal-Secret: <secret>`. CSRF is not required. | `/internal/*` |

Other headers:

| Header | Direction | Description |
|---|---|---|
| `Idempotency-Key` | request | UUID; required by `POST /actions`. |
| `Correlation-Id` | request / response | Optional on requests (any non-empty string is echoed). Always present on responses. It equals `error.error_id` on failures; quote it to support. |
| `Retry-After` | response | Seconds to wait; sent with `429`. |

### Pagination

List endpoints take `limit` and an opaque `cursor`. The response
`meta.pagination` block holds `next_cursor` (pass it back as `cursor`),
`limit`, and `has_more`. `next_cursor` is `null` on the last page.

---

## Route index

Every route the server registers. `HEAD` variants are implied for each `GET`.
`/internal/jobs*` exists only when the background worker is enabled
(`WORKER_ENABLED`, default on).

<!-- route-index:start -->
| Method | Path | Purpose | Access |
|---|---|---|---|
| `POST` | `/actions` | Create an action intent | Public + CSRF |
| `GET` | `/actions` | List a wallet's actions | Public |
| `GET` | `/actions/:id` | Get one action | Public |
| `PATCH` | `/actions/:id/submitted` | Attach a tx hash | Public + CSRF |
| `POST` | `/actions/:id/cancel` | Cancel a pending action | Public + CSRF |
| `DELETE` | `/actions` | Scrub a wallet's activity | Public + CSRF |
| `GET` | `/actions/export` | Export activity as JSON or CSV | Public |
| `GET` | `/api/actions/:walletAddress` | Actions for a wallet (service use) | API key |
| `GET` | `/dashboard/summary` | Wallet dashboard rollup | Public |
| `GET` | `/portfolio/summary` | Wallet portfolio summary | Public |
| `GET` | `/dashboard/aggregates` | Consistent aggregate snapshot | Public |
| `POST` | `/dashboard/aggregates/refresh` | Recompute aggregates | API key + CSRF |
| `POST` | `/wallet-auth/challenge` | Start wallet sign-in | Public + CSRF |
| `POST` | `/wallet-auth/verify` | Finish wallet sign-in | Public + CSRF |
| `POST` | `/wallet-auth/refresh` | Refresh a session | Public + CSRF |
| `POST` | `/wallet-auth/logout` | Revoke a session | Public + CSRF |
| `GET` | `/health` | Liveness | Public |
| `GET` | `/health/attestation` | Deployment attestation | Public |
| `GET` | `/health/indexer` | Indexer sync health | Public |
| `GET` | `/saved-pools` | List saved pools | Public |
| `POST` | `/saved-pools` | Save a pool | Public + CSRF |
| `DELETE` | `/saved-pools/:poolId` | Remove a saved pool | Public + CSRF |
| `GET` | `/schema-version` | Schema versions | Public |
| `GET` | `/schema-version/validate` | Check schema compatibility | Public |
| `GET` | `/api/users/me` | Current profile | Wallet session |
| `PUT` | `/api/users/me` | Update profile | Wallet session + CSRF |
| `GET` | `/api/metrics` | Protocol summary | API key |
| `GET` | `/api/metrics/aggregate` | Aggregate metrics | API key |
| `GET` | `/api/metrics/round` | Round metrics | API key |
| `GET` | `/api/metrics/history` | Metric history | API key |
| `GET` | `/metrics` | Prometheus scrape endpoint | Public (restrict at the network edge) |
| `GET` | `/api/draw-proofs` | List draw proofs | Public |
| `GET` | `/api/draw-proofs/:drawId` | Get a draw proof | Public |
| `GET` | `/api/draw-proofs/:drawId/verify` | Read verification state | Public |
| `POST` | `/api/draw-proofs/:drawId/verify` | Re-verify a proof | Public + CSRF |
| `GET` | `/api/v1/metrics/transactions` | Transaction metrics | API key |
| `GET` | `/api/v1/metrics/transactions/:actionType` | Metrics for one action type | API key |
| `GET` | `/api/categories` | Categories | API key |
| `GET` | `/api/notifications` | List notifications | Public |
| `POST` | `/api/notifications/:id/dismiss` | Dismiss a notification | Public + CSRF |
| `PUT` | `/api/notifications/preferences` | Update preferences | Public + CSRF |
| `POST` | `/admin/audit` | Record an audit entry | Admin session + CSRF |
| `GET` | `/admin/audit` | List audit entries | Admin session |
| `GET` | `/admin/audit/export` | Export audit entries | Admin session |
| `POST` | `/internal/reconcile` | Apply an indexed chain event | Service secret |
| `POST` | `/internal/checkpoint` | Persist indexer progress | Service secret |
| `GET` | `/internal/trace/:txHash` | Trace a transaction | Service secret |
| `POST` | `/internal/reconciliation/proposals` | Create a repair proposal | Service secret |
| `POST` | `/internal/reconciliation/proposals/:id/approve` | Approve a proposal | Service secret |
| `POST` | `/internal/reconciliation/proposals/:id/execute` | Execute a proposal | Service secret |
| `GET` | `/internal/jobs` | List background jobs | Service secret |
| `GET` | `/internal/jobs/:id` | Inspect a background job | Service secret |
| `POST` | `/internal/jobs/:id/retry` | Requeue a dead job | Service secret |
<!-- route-index:end -->

---

## Endpoints

### Actions

#### POST /actions

Create a new wallet action intent.

**Headers**

| Header | Required | Description |
|---|---|---|
| `Idempotency-Key` | Yes | UUID v4. Reusing the same key with the same payload is a safe no-op (returns 200). Reusing with a different payload returns 409. |

**Request body**

```json
{
  "wallet_address": "GABCDEF1234567890",
  "action_type": "deposit",
  "action_payload": {
    "vault_id": "42",
    "amount": "1000000",
    "token": "USDC"
  }
}
```

| Field | Type | Values |
|---|---|---|
| `wallet_address` | string | Stellar wallet address (max 120 chars) |
| `action_type` | enum | `deposit` `withdraw` `create_vault` `claim` `select_winner` |
| `action_payload` | object | Arbitrary JSON; shape depends on `action_type` |

**Response — 201 Created** (new action) or **200 OK** (idempotent replay)

```json contract=action
{
  "data": {
    "id": "5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11",
    "idempotency_key": "0b1f7e9e-3c1d-4d6e-8d55-0c5f6a3b2f10",
    "wallet_address": "GABCDEF1234567890",
    "action_type": "deposit",
    "action_payload": { "vault_id": "42", "amount": "1000000", "token": "USDC" },
    "status": "pending",
    "tx_hash": null,
    "soroban_event_id": null,
    "correlation_id": "7f0c2f84-2f2b-4f38-9d8e-3b1f5c9a1a11",
    "error_code": null,
    "error_detail": null,
    "retry_count": 0,
    "created_at": "2026-09-26T10:00:00.000Z",
    "updated_at": "2026-09-26T10:00:00.000Z",
    "submitted_at": null,
    "confirmed_at": null,
    "redacted_at": null
  }
}
```

**Response — 409 Conflict** when the `Idempotency-Key` was already used with a different body

```json contract=error
{
  "error": {
    "code": "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
    "category": "conflict",
    "message": "idempotency key reused with a different payload",
    "retryable": false,
    "recovery": "Generate a new Idempotency-Key for a different request.",
    "error_id": "9c1d0e0e-5b8c-4b4f-8a53-2f1a6d3f7b10",
    "status_code": 409
  }
}
```

**Response — 400 Bad Request** when `Idempotency-Key` is missing or not a UUID, or the body is invalid (`INVALID_PAYLOAD`, with `issues`).

**Response — 403 Forbidden** when the CSRF cookie/header pair is missing or mismatched.

---

#### GET /actions

List actions for a wallet, newest first.

**Query parameters**

| Param | Required | Default | Description |
|---|---|---|---|
| `wallet` | Yes | — | Wallet address |
| `status` | No | — | Filter: `pending` `submitted` `confirmed` `failed` `reverted` `orphaned` |
| `cursor` | No | — | UUID of the last item from the previous page |
| `limit` | No | 25 | Items per page (1–100) |

**Response — 200 OK**

```json contract=action-list
{
  "data": [
    {
      "id": "5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11",
      "idempotency_key": "0b1f7e9e-3c1d-4d6e-8d55-0c5f6a3b2f10",
      "wallet_address": "GABCDEF1234567890",
      "action_type": "deposit",
      "action_payload": { "vault_id": "42", "amount": "1000000", "token": "USDC" },
      "status": "confirmed",
      "tx_hash": "e3b0c44298fc1c14",
      "soroban_event_id": "0000123-1",
      "correlation_id": "7f0c2f84-2f2b-4f38-9d8e-3b1f5c9a1a11",
      "error_code": null,
      "error_detail": null,
      "retry_count": 0,
      "created_at": "2026-09-26T10:00:00.000Z",
      "updated_at": "2026-09-26T10:05:00.000Z",
      "submitted_at": "2026-09-26T10:01:00.000Z",
      "confirmed_at": "2026-09-26T10:05:00.000Z",
      "redacted_at": null
    }
  ],
  "meta": {
    "pagination": {
      "next_cursor": "5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11",
      "limit": 25,
      "has_more": true
    },
    "watermark": { "latest_ledger": 1234567, "as_of": "2026-09-26T10:04:30.000Z" }
  }
}
```

`meta.watermark` reports the indexer ledger this read reflects (`null` values
until the indexer has synced), so clients can tell whether two reads come from
the same ingestion point. See [`backend/docs/READ_CONSISTENCY.md`](../backend/docs/READ_CONSISTENCY.md).

**Response — 400 Bad Request** when `wallet` is missing or `limit` is out of range — see [Standard errors](#standard-errors).

---

#### GET /actions/:id

Get a single action by ID.

**Response — 200 OK** — action object (same shape as POST response)

**Response — 404 Not Found**

```json contract=error
{
  "error": {
    "code": "NOT_FOUND",
    "category": "not_found",
    "message": "action 5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11 not found",
    "retryable": false,
    "recovery": "Check the identifier and try again.",
    "error_id": "9c1d0e0e-5b8c-4b4f-8a53-2f1a6d3f7b10",
    "status_code": 404
  }
}
```

---

#### PATCH /actions/:id/submitted

Attach a transaction hash after the wallet has broadcast to the network.
Advances status from `pending` → `submitted`.

**Request body**

```json
{ "tx_hash": "abc123..." }
```

**Response — 200 OK** — updated action object

---

#### POST /actions/:id/cancel

Cancel a pending action (e.g. user rejected the wallet prompt).
Advances status from `pending` → `failed`.

**Request body**

```json
{
  "error_code": "WALLET_REJECTED",
  "error_detail": "User dismissed the wallet popup"
}
```

| `error_code` values | Meaning |
|---|---|
| `WALLET_REJECTED` | User explicitly rejected the signing request |
| `WALLET_TIMEOUT` | Signing timed out with no response |
| `NETWORK_ERROR` | Could not reach the RPC endpoint |

**Response — 200 OK** — updated action object

---

#### DELETE /actions?wallet=...

Scrub all personal data for a wallet (GDPR / right-to-erasure). Sets
`action_payload` to null and stamps `redacted_at` on all rows.
Scrubbed rows are excluded from future export responses.

**Response — 200 OK**

```json
{ "data": { "scrubbed": 12 } }
```

---

#### GET /actions/export

Export the wallet's full activity history as JSON or CSV.

**Query parameters**

| Param | Required | Default | Description |
|---|---|---|---|
| `wallet` | Yes | — | Wallet address |
| `format` | No | `json` | `json` or `csv` |
| `from` | No | — | ISO 8601 datetime — return actions created at or after this time |
| `to` | No | — | ISO 8601 datetime — return actions created at or before this time |
| `limit` | No | 500 | Max rows returned (1–1000) |

**Response — 200 OK (JSON format)**

```json
{
  "data": [
    {
      "id": "550e8400-...",
      "wallet_address": "GABCDEF1234567890",
      "action_type": "deposit",
      "action_payload": { "vault_id": "42", "amount": "1000000", "token": "USDC" },
      "status": "confirmed",
      "tx_hash": "abc123...",
      "error_code": null,
      "created_at": "2025-05-29T12:00:00.000Z",
      "submitted_at": "2025-05-29T12:00:05.000Z",
      "confirmed_at": "2025-05-29T12:00:30.000Z"
    }
  ]
}
```

**Response — 200 OK (CSV format)**

Returns `Content-Type: text/csv` with `Content-Disposition: attachment; filename="vaultquest-activity-<wallet-prefix>.csv"`.

```
"id","date","action_type","pool_id","amount","token","status","tx_hash","error_code","submitted_at","confirmed_at"
"550e8400-...","2025-05-29T12:00:00.000Z","deposit","42","1000000","USDC","confirmed","abc123...","","2025-05-29T12:00:05.000Z","2025-05-29T12:00:30.000Z"
```

**Notes**
- Scrubbed rows (`redacted_at != null`) are never included in export output.
- Large histories: use `from`/`to` date ranges to paginate manually. The `limit`
  cap is 1 000 rows per request.
- Wallet-scoping: the export only returns data for the `wallet` parameter value.
  Never returns another user's data.

---

### Portfolio / Dashboard

#### GET /dashboard/summary

Aggregated dashboard rollup for a wallet. Provides per-status action counts,
in-flight tx hashes the wallet should keep polling, and a freshness flag.

**Query parameters**

| Param | Required | Default | Description |
|---|---|---|---|
| `wallet` | Yes | — | Wallet address |
| `stale_after_ms` | No | 300 000 (5 min) | If the most recent ledger update is older than this, `is_stale` is true |

**Response — 200 OK**

```json
{
  "data": {
    "wallet_address": "GABCDEF1234567890",
    "total_actions": 14,
    "by_status": {
      "pending": 0,
      "submitted": 1,
      "confirmed": 11,
      "failed": 1,
      "reverted": 1,
      "orphaned": 0
    },
    "pending_tx_hashes": ["abc123..."],
    "is_stale": false,
    "latest_activity_at": "2025-05-29T12:00:00.000Z",
    "latest_confirmed_at": "2025-05-29T11:55:00.000Z",
    "watermark": { "latest_ledger": 1234567, "as_of": "2025-05-29T12:00:00.000Z" }
  }
}
```

`watermark` is the indexer point the summary was computed at, read in the same
snapshot as the counts. `GET /portfolio/summary?wallet=` (a valid Stellar
address is required) returns the portfolio summary with the same top-level
`watermark`. See [`backend/docs/READ_CONSISTENCY.md`](../backend/docs/READ_CONSISTENCY.md).

---

### Saved pools / watchlist

#### GET /saved-pools

Return the saved pools for a wallet, newest first.

**Query parameters**

| Param | Required | Default | Description |
|---|---|---|---|
| `wallet` | Yes | — | Wallet address |

**Response — 200 OK**

```json
{
  "data": [
    {
      "id": "550e8400-...",
      "wallet_address": "GABCDEF1234567890",
      "pool_id": "pool-42",
      "pool_name": "Weekly USDC",
      "status": "open",
      "tvl": "12500.5",
      "asset": "USDC",
      "participant_count": 24,
      "expected_yield": "5.2% APY",
      "prize": "50 USDC",
      "opens_at": "2026-05-29T12:00:00.000Z",
      "locks_at": "2026-06-05T12:00:00.000Z",
      "draws_at": "2026-06-12T12:00:00.000Z",
      "created_at": "2026-05-29T12:00:00.000Z",
      "updated_at": "2026-05-29T12:00:00.000Z"
    }
  ]
}
```

#### POST /saved-pools

Create or update a saved pool entry for a wallet. Reusing the same wallet and
pool ID updates the stored summary instead of creating duplicates.

**Request body**

```json
{
  "wallet_address": "GABCDEF1234567890",
  "pool": {
    "pool_id": "pool-42",
    "pool_name": "Weekly USDC",
    "status": "open",
    "tvl": "12500.5",
    "asset": "USDC",
    "participant_count": 24,
    "expected_yield": "5.2% APY",
    "prize": "50 USDC",
    "opens_at": "2026-05-29T12:00:00.000Z",
    "locks_at": "2026-06-05T12:00:00.000Z",
    "draws_at": "2026-06-12T12:00:00.000Z"
  }
}
```

**Response — 201 Created** for a new saved pool, or **200 OK** when updating an existing entry

```json
{
  "data": {
    "saved": {
      "id": "550e8400-...",
      "wallet_address": "GABCDEF1234567890",
      "pool_id": "pool-42",
      "pool_name": "Weekly USDC",
      "status": "open",
      "tvl": "12500.5",
      "asset": "USDC",
      "participant_count": 24,
      "expected_yield": "5.2% APY",
      "prize": "50 USDC",
      "opens_at": "2026-05-29T12:00:00.000Z",
      "locks_at": "2026-06-05T12:00:00.000Z",
      "draws_at": "2026-06-12T12:00:00.000Z",
      "created_at": "2026-05-29T12:00:00.000Z",
      "updated_at": "2026-05-29T12:00:00.000Z"
    }
  }
}
```

#### DELETE /saved-pools/:poolId

Remove a saved pool entry for the wallet supplied in the query string.

**Query parameters**

| Param | Required | Default | Description |
|---|---|---|---|
| `wallet` | Yes | — | Wallet address |

**Response — 200 OK**

```json
{ "data": { "deleted": 1 } }
```

---

## Standard errors

Every failure, from any route, uses one envelope:

```json contract=error
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "category": "validation",
    "message": "Request body validation failed",
    "retryable": false,
    "recovery": "Correct the highlighted fields and submit again.",
    "error_id": "9c1d0e0e-5b8c-4b4f-8a53-2f1a6d3f7b10",
    "status_code": 400,
    "issues": [
      { "code": "invalid_type", "expected": "string", "received": "undefined", "path": ["action_type"], "message": "Required" }
    ]
  }
}
```

| Field | Description |
|---|---|
| `code` | Stable, machine-readable. Safe to branch on; new codes may be added, existing ones are not renamed. |
| `category` | Coarse grouping for UI treatment: `validation`, `authorization`, `not_found`, `conflict`, `rate_limit`, `wallet`, `settlement`, `dependency`, `internal`. |
| `message` | Safe to show to users. Internal detail (SQL, stack traces, RPC payloads, wallet addresses) is never included; server errors always use the catalog text. |
| `retryable` | `true` when repeating the same request may succeed. |
| `recovery` | What the user can do next, when there is something to do. |
| `error_id` | The request's correlation id. Also returned as the `Correlation-Id` header and logged with the failure. |
| `status_code` | Mirrors the HTTP status. |
| `details`, `issues` | Optional context; `issues` are per-field validation problems. |

A forbidden request without a CSRF token:

```json contract=error
{
  "error": {
    "code": "FORBIDDEN",
    "category": "authorization",
    "message": "Invalid or missing CSRF token",
    "retryable": false,
    "recovery": "Use an account with access, or contact support with your error ID.",
    "error_id": "3b1f5c9a-1a11-4d6e-8d55-0c5f6a3b2f10",
    "status_code": 403
  }
}
```

An unexpected server failure (the cause is logged under `error_id`, never returned):

```json contract=error
{
  "error": {
    "code": "INTERNAL",
    "category": "internal",
    "message": "Something went wrong on our side.",
    "retryable": true,
    "recovery": "Try again shortly. If it keeps happening, contact support with your error ID.",
    "error_id": "e4f0a9d2-6a2c-4c1e-9d7e-8b1c2d3e4f50",
    "status_code": 500
  }
}
```

### Error codes

| Code | Category | Retryable | Typical HTTP | Meaning |
|---|---|---|---|---|
| `INVALID_PAYLOAD` | validation | no | 400 | Body, query or required header failed validation |
| `INVALID_CURSOR` | validation | no | 400 | Pagination cursor is malformed |
| `EXPIRED_CURSOR` | validation | no | 400 | Pagination cursor has expired |
| `HTTP_ERROR` | validation | no | 4xx | Framework-level client error (bad JSON, unsupported media type) |
| `UNAUTHORIZED` | authorization | no | 401 | Missing or invalid credentials |
| `FORBIDDEN` | authorization | no | 403 | Authenticated but not allowed, or CSRF check failed |
| `NOT_FOUND` | not_found | no | 404 | Resource does not exist |
| `ILLEGAL_TRANSITION` | conflict | no | 409 | Status change not allowed (e.g. cancel a confirmed action) |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` | conflict | no | 409 | Same `Idempotency-Key`, different body |
| `TX_HASH_ALREADY_ATTACHED` | conflict | no | 409 | `tx_hash` already belongs to an action |
| `CONFLICT` | conflict | no | 409 | Unique-constraint conflict |
| `RATE_LIMIT_EXCEEDED` | rate_limit | yes | 429 | Too many requests; honour `Retry-After` |
| `WALLET_REJECTED` | wallet | yes | — | Wallet declined the request (recorded on the action as `error_code`) |
| `WALLET_TIMEOUT` | wallet | yes | — | Wallet did not respond in time |
| `NETWORK_ERROR` | dependency | yes | — | Stellar network unreachable |
| `DATABASE_ERROR` | dependency | yes | 500 | Storage failure |
| `REVERTED_ON_CHAIN` | settlement | no | — | Transaction reverted on-chain |
| `ORPHAN_TTL_EXPIRED` | settlement | no | — | Transaction never confirmed before expiry |
| `SETTLEMENT_SUBMIT_FAILED` | settlement | yes | — | Payout submission failed; retried automatically |
| `SETTLEMENT_RETRIES_EXHAUSTED` | settlement | no | — | Payout gave up after repeated failures |
| `SETTLEMENT_ALREADY_RESOLVED` | settlement | no | — | Vault already settled |
| `SETTLEMENT_IN_PROGRESS` | settlement | yes | — | Vault is being settled right now |
| `SETTLEMENT_PAYOUT_UNVERIFIED` | settlement | no | — | Payout sent but not yet verified |
| `INTERNAL` | internal | yes | 500 | Unexpected failure |

Codes with `—` are recorded on actions and settlements rather than returned as
an HTTP status by a route today.

---

## Internal: background jobs

Delayed and retryable work (currently draw-proof generation after a
`select_winner` action confirms) runs on a background worker. These
service-secret endpoints let operators inspect it. See
[`backend/docs/BACKGROUND_JOBS.md`](../backend/docs/BACKGROUND_JOBS.md).

#### GET /internal/jobs?status=&type=&limit=

`status` is one of `queued`, `running`, `succeeded`, `dead`; `limit` is 1–200
(default 50). Newest first.

```json contract=job-list
{
  "data": [
    {
      "id": "1c9d2a4e-7f3b-4a55-9e0a-5d6b7c8d9e01",
      "type": "draw_proof.generate",
      "status": "dead",
      "idempotency_key": "draw_proof.generate:5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11",
      "payload": { "actionId": "5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11" },
      "attempts": 5,
      "max_attempts": 5,
      "run_at": "2026-09-26T10:06:00.000Z",
      "correlation_id": "7f0c2f84-2f2b-4f38-9d8e-3b1f5c9a1a11",
      "last_error": { "attempt": 5, "at": "2026-09-26T10:20:00.000Z", "code": "INTERNAL", "message": "rpc timeout", "retryable": true },
      "failures": [
        { "attempt": 5, "at": "2026-09-26T10:20:00.000Z", "code": "INTERNAL", "message": "rpc timeout", "retryable": true }
      ],
      "created_at": "2026-09-26T10:05:00.000Z",
      "updated_at": "2026-09-26T10:20:00.000Z",
      "completed_at": "2026-09-26T10:20:00.000Z"
    }
  ]
}
```

#### GET /internal/jobs/:id

Returns `{ "data": <job> }` (same job object). `404 NOT_FOUND` if unknown,
`400 INVALID_PAYLOAD` if `:id` is not a UUID.

```json contract=job
{
  "data": {
    "id": "1c9d2a4e-7f3b-4a55-9e0a-5d6b7c8d9e01",
    "type": "draw_proof.generate",
    "status": "queued",
    "idempotency_key": "draw_proof.generate:5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11",
    "payload": { "actionId": "5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11" },
    "attempts": 0,
    "max_attempts": 5,
    "run_at": "2026-09-26T10:05:00.000Z",
    "correlation_id": null,
    "last_error": null,
    "failures": [],
    "created_at": "2026-09-26T10:05:00.000Z",
    "updated_at": "2026-09-26T10:05:00.000Z",
    "completed_at": null
  }
}
```

#### POST /internal/jobs/:id/retry

Gives a `dead` job a fresh attempt budget and returns it as `queued`.
`404 NOT_FOUND` if the job does not exist or is not dead.

---

## Integration flows

### 1. Record a deposit and follow it to confirmation

1. `GET /health` — obtain the `csrf-token` cookie and `X-CSRF-Token` header.
2. `POST /actions` with `Idempotency-Key: <new uuid>`, the CSRF cookie + header
   and the body from [POST /actions](#post-actions) → `201` with `status: "pending"`.
   Retrying the identical request returns `200` with the same action; a
   different body under the same key returns `409`
   `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
3. Sign and submit in the wallet, then `PATCH /actions/:id/submitted` with
   `{ "tx_hash": "..." }` → `status: "submitted"`.
4. Poll `GET /actions/:id` (or `GET /dashboard/summary?wallet=`, whose
   `pending_tx_hashes` lists what to keep polling) until `status` is `confirmed`.
5. If the user abandons the wallet prompt: `POST /actions/:id/cancel` with
   `{ "error_code": "WALLET_REJECTED" }` → `status: "failed"`.

### 2. Handle failures uniformly

Branch on `error.code` (or `error.category` for generic UI), show
`error.message` and `error.recovery` to the user, retry only when
`error.retryable` is `true` (respecting `Retry-After` on `429`), and include
`error.error_id` in any support request.

### 3. Page through history

`GET /actions?wallet=...&limit=25`, then repeat with
`cursor=<meta.pagination.next_cursor>` until `has_more` is `false`.

---

## Action status lifecycle

```
pending ──► submitted ──► confirmed
   │               └──────► reverted
   └──────────────────────► failed
submitted ────────────────► orphaned
```

Terminal states (no further transitions): `confirmed`, `failed`, `reverted`, `orphaned`.

---

## Action payload shapes by type

| `action_type` | Payload fields |
|---|---|
| `deposit` | `vault_id`, `amount`, `token` |
| `withdraw` | `vault_id`, `amount`, `token` |
| `create_vault` | `vault_id`, `amount`, `token` |
| `claim` | `vault_id` |
| `select_winner` | `vault_id` |

The `action_payload` is stored verbatim and surfaced as-is in responses and
exports. Consumers should treat unknown fields as additive and not error on them.
