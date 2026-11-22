# User Activity Timeline

`GET /api/activity?wallet=<connected-wallet>` returns the authenticated wallet's public activity timeline. It requires a wallet-session bearer token and rejects requests unless the supplied connected wallet exactly matches the address in that session.

The public event allowlist is deposits, withdrawals, and prize claims. Scrubbed actions and unsupported action types are excluded. The response projects only an event ID/type/status/time, validated amount and asset, and stable activity/vault links. It never returns raw action payloads, wallet identifiers, idempotency or correlation keys, error details, recovery checkpoints, actors, reasons, or before/after audit state. Maintainer audit and change-history records remain on their separate permission-guarded endpoints.

Pagination uses an opaque cursor over descending `(created_at, id)` ordering. The ID tie-breaker makes equal timestamps deterministic; cursors are bound to the authenticated wallet. The response is private and non-cacheable. `type` accepts `deposit`, `withdrawal`, or `prize_claim`; `limit` defaults to 20 and is capped at 50.