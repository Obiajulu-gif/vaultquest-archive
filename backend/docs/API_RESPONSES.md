# API response standard

Backend HTTP responses use one envelope so frontend code can parse success,
validation, and recovery states without route-specific branching.

## Success

Single-object responses:

```json
{
  "data": {
    "id": "act_123",
    "status": "pending"
  }
}
```

List responses:

```json
{
  "data": [{ "id": "act_123" }],
  "meta": {
    "pagination": {
      "next_cursor": "4f2b9a1d-...",
      "limit": 25,
      "has_more": true
    }
  }
}
```

`next_cursor: null` and `has_more: false` mean the client has reached the end.
Clients should pass the returned cursor back as `?cursor=` unchanged.

## Errors

All errors use one envelope. The full field reference, the complete code
table (category, retryability, HTTP status) and worked examples live in
[`docs/API.md`(________docs/API.md#standard-errors); they are enforced by
`tests/apiContract.spec.ts`.

```json
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "category": "validation",
    "message": "validation failed",
    "retryable": false,
    "recovery": "Correct the highlighted fields and submit again.",
    "error_id": "9c1d0e0e-5b8c-4b4f-8a53-2f1a6d3f7b10",
    "status_code": 400,
    "issues": []
  }
}
```

Codes, categories, retryability and user-facing text come from the catalog in
`src/errorTaxonomy.ts`. Internal messages never reach clients on server errors;
`error_id` is the request's correlation id (also the `Correlation-Id` header)
and is what users should quote to support.

Validation responses include Zod `issues`; frontend code should prefer`
error.message` for general copy and field-specific `issues` when rendering
forms.

## Network and upstream failures

Backend routes that cannot reach Stellar RPC, Horizon, Prisma, or another
upstream should return `NETWORK_ERROR` when the failure is expected/recoverable.
Unknown exceptions fall back to `INTERNAL`. Frontends should retry only when
`error.retryable` is `true` (with backoff, honouring `Retry-After`); never
auto-retry validation, auth, or conflict errors.

## Contract versioning

Every core response has a semantic version recorded in
`src/contracts/apiContract.ts` (`CONTRACT_VERSIONS`) and enforced by
`tests/apiContract.spec.ts`. The current versions are:

| Contract | Version | Description |
| --- | --- | --- |
| `action` | 1.0.0 | Single action ledger record returned by `/actions`. |
| `action-list` | 1.0.0 | Paginated action list with watermark. |
| `error` | 1.0.0 | Standard error envelope. |
| `health` | 1.0.0 | Liveness probe. |
| `job` | 1.0.0 | Worker job record. |
| `job-list` | 1.0.0 | List of worker jobs. |
| `schema-version` | 1.1.0 | Database/indexer schema version info plus envelope/contract version metadata. |
| `schema-validation` | 1.1.0 | Preflight compatibility result. |

### Version rules

- **Major** bumps are breaking. Adding, renaming, removing, or changing the
  type of a field in a `strict()` schema is a breaking change.
- **Minor** bumps add new optional fields or new contracts.
- **Patch** bumps clarify documentation or tighten validation without
  changing the observable shape.

### Deprecation rules

1. A contract is marked deprecated by adding an entry to `DEPRECATED_CONTRACTS`
   in `src/contracts/apiContract.ts`. The entry must name a `replacedBy`
   contract that exists in `CONTRACTS` and a sunset date.
2. Deprecated contracts must continue to validate against their published
   schema until the sunset date. The contract tests fail if a deprecated
   contract loses its replacement or sunset metadata.
3. After the sunset date the contract may be removed in a major release.

### Examples

Success (`contract=action`):

```json contract=action
{
  "data": {
    "id": "5d3a8a4c-89a5-4b8a-9a1c-1f0d4b2c7e11",
    "idempotency_key": "0b1f7e9e-3c1d-4d6e-8d55-0c5f6a3b2f10",
    "wallet_address": "GBCDEF1234567890",
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

Error (`contract=error`):

```json contract=error
{
  "error": {
    "code": "INVALID_PAYLOAD",
    "category": "validation",
    "message": "validation failed",
    "retryable": false,
    "recovery": "Correct the highlighted fields and submit again.",
    "error_id": "9c1d0e0e-5b8c-4b4f-8a53-2f1a6d3f7b10",
    "status_code": 400,
    "issues": []
  }
}
```

List (`contract=action-list`):

```json contract=action-list
{
  "data": [],
  "meta": {
    "pagination": {
      "next_cursor": null,
      "limit": 25,
      "has_more": false
    },
    "watermark": {
      "latest_ledger": null,
      "as_of": null
    }
  }
}
```
## Data exports (`GET /exports`)

Wallet-scoped exports are the one documented exception to the `data`/`meta`
envelope above. They are generated on demand and never stored, so the response
is a downloadable JSON bundle with its own contract:

```json
{
  "metadata": {
    "schema_version": "1.0.0",
    "generated_at": "2026-03-01T12:00:00.000Z",
    "expires_at": "2026-03-02T12:00:00.000Z",
    "retention_hours": 24,
    "wallet": "GALICE",
    "generated_by_role": "user",
    "sections": ["actions", "saved_pools"],
    "record_counts": { "actions": 1, "saved_pools": 1 },
    "truncated": false,
    "max_records_per_section": 10000,
    "checksum": "<key sha256 of `data`>"
  },
  "data": {
    "actions": [],
    "saved_pools": []
  }
}
```

- `Get /exports` is authenticated and requires the `own.data.export` permission.
- `?wallet=` defaults to the caller's own wallet. Exporting another wallet
  requires `admin.export.any` and is enforced in the service layer.
- `?sections=` is a comma-separated subset of `actions` and `saved_pools`.
- Responses are sent with `Cache-Control: no-store` and a `Content-Disposition`
  attachment filename derived from `generated_at`.
- Exports are not persisted; consumers must discard the bundle after
  `expires_at` (`retention_hours` from generation).
- `truncated` is `true` when a section hit `max_records_per_section`; the
  corresponding `record_counts` entry then reflects the capped count.
- `checksum` is the SHA-256 of the serialized `data` object for tamper
  detection by downstream consumers.
