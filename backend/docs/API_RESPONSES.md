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
[`docs/API.md`](../../docs/API.md#standard-errors); they are enforced by
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

Validation responses include Zod `issues`; frontend code should prefer
`error.message` for general copy and field-specific `issues` when rendering
forms.

## Network and upstream failures

Backend routes that cannot reach Stellar RPC, Horizon, Prisma, or another
upstream should return `NETWORK_ERROR` when the failure is expected/recoverable.
Unknown exceptions fall back to `INTERNAL`. Frontends should retry only when
`error.retryable` is `true` (with backoff, honouring `Retry-After`); never
auto-retry validation, auth, or conflict errors.
