# Signed Webhook Verification & Replay-Window Enforcement (#799)

## Overview

VaultQuest accepts inbound webhooks and integration callbacks from external and internal services, including:
- **Payment Providers** (e.g. Stripe checkout & deposit confirmations)
- **Smart Contract Oracles & Stellar Indexers** (e.g. prize draw execution callbacks)
- **Internal Cron & Vault Management Services** (e.g. settlement and batch deposit notifications)

To ensure high-security invariants:
1. **Cryptographic Signature Verification**: Every inbound request is authenticated using provider-specific cryptographic signatures (HMAC-SHA256, Stripe `t=...,v1=...` schemes, or Stellar Ed25519 asymmetric signatures).
2. **Replay-Window Enforcement**: Timestamps must fall within an acceptable drift window (default 300 seconds, configurable via `WEBHOOK_TOLERANCE_SECONDS`). Stale or future-dated events exceeding clock-skew tolerance (60s) are rejected immediately.
3. **Atomic Event Deduplication**: Processed event IDs are persisted in the `processed_webhook_events` table (`ProcessedWebhookEvent` Prisma model) using transactional locking. Duplicate deliveries return the cached result with `{ "duplicate": true }` without repeating side effects.
4. **Structured Error Taxonomy**: Standardized error codes and user-safe recovery messages are returned on any failure.
5. **Dry-Run Validation**: Callers can pass `?dry_run=true` to test signature validity and event structure without executing side effects or persisting the event.

---

## Endpoints

| Endpoint | Method | Supported Provider | Description |
|---|---|---|---|
| `/webhooks/:provider` | `POST` | `stripe`, `internal`, `stellar`, `vaultquest`, `custom` | Parameterized inbound webhook endpoint |
| `/webhooks/stripe` | `POST` | `stripe` | Dedicated Stripe webhook endpoint |
| `/webhooks/internal` | `POST` | `internal` / `vaultquest` | Internal backend & cron callbacks |
| `/webhooks/vault` | `POST` | `internal` / `vaultquest` | Vault deposit/settlement callbacks |
| `/webhooks/stellar` | `POST` | `stellar` | Stellar smart contract & oracle callbacks |
| `/webhooks/draw-oracle` | `POST` | `stellar` | Dedicated prize draw oracle callbacks |

---

## Supported Providers & Signature Schemes

### 1. Stripe (`provider: stripe`)

- **Header**: `Stripe-Signature` (format: `t=<timestamp>,v1=<signature>`)
- **Algorithm**: HMAC-SHA256 over `${timestamp}.${rawBody}` using `STRIPE_WEBHOOK_SECRET`.
- **Timestamp Unit**: Unix epoch seconds.

### 2. Internal / VaultQuest HMAC (`provider: internal` / `vaultquest` / `custom`)

- **Signature Header**: `X-VaultQuest-Signature` or `X-Webhook-Signature`
- **Timestamp Header**: `X-VaultQuest-Timestamp` or `X-Webhook-Timestamp`
- **Algorithm**: HMAC-SHA256 over `${timestamp}.${rawBody}` using `WEBHOOK_SECRET` (fallback: `INTERNAL_SERVICE_SECRET`).
- **Timestamp Unit**: Unix epoch seconds or ISO-8601 string.

### 3. Stellar Ed25519 (`provider: stellar`)

- **Signature Header**: `X-Stellar-Signature` or `X-Webhook-Signature` (hex or base64)
- **Timestamp Header**: `X-Stellar-Timestamp` or `X-Webhook-Timestamp`
- **Algorithm**: Ed25519 asymmetric signature over `${timestamp}.${rawBody}` using `STELLAR_WEBHOOK_PUBLIC_KEY` (Stellar public key `G...`).
- **Timestamp Unit**: Unix epoch seconds or ISO-8601 string.

---

## Timing-Safe Equality

All signature comparisons use constant-time byte comparisons via `crypto.timingSafeEqual` to eliminate timing side-channel attacks.

---

## Replay Window & Clock Drift

- **Past Tolerance**: Requests with timestamps older than `WEBHOOK_TOLERANCE_SECONDS` (default 300s) fail with `WEBHOOK_TIMESTAMP_STALE` (`400 Bad Request`).
- **Future Tolerance**: Requests with timestamps more than 60s into the future fail with `WEBHOOK_TIMESTAMP_STALE` (`400 Bad Request`).

---

## Deduplication & Idempotency Storage

Events are persisted in Postgres via Prisma:

```prisma
model ProcessedWebhookEvent {
  id          String   @id @default(uuid())
  provider    String   // stripe, internal, stellar, custom
  eventId     String   // Provider-specific unique event id
  eventType   String   // e.g. payment_intent.succeeded, prize_draw.completed
  status      String   @default("processed")
  payloadHash String   // SHA-256 hash of the canonical raw payload
  response    Json?    // Cached execution response
  processedAt DateTime @default(now()) @map("processed_at")
  createdAt   DateTime @default(now()) @map("created_at")

  @@unique([provider, eventId], name: "provider_eventId")
  @@index([provider, eventId])
  @@index([processedAt])
  @@map("processed_webhook_events")
}
```

When a duplicate webhook delivery arrives:
1. `WebhookService.processEvent` identifies the existing `(provider, eventId)` record.
2. The endpoint returns `200 OK` with `{ status: "processed", duplicate: true, result: cachedResponse }`.
3. Side-effect handlers (e.g. prize distribution, vault settlement) are NOT re-executed.

---

## Error Taxonomy Mapping

| Error Code | HTTP Status | Category | Description |
|---|---|---|---|
| `WEBHOOK_SIGNATURE_MISSING` | `400` | `authorization` | Missing required signature header |
| `WEBHOOK_SIGNATURE_INVALID` | `400` | `authorization` | Cryptographic signature mismatch |
| `WEBHOOK_TIMESTAMP_MISSING` | `400` | `validation` | Missing timestamp header or timestamp in signature |
| `WEBHOOK_TIMESTAMP_STALE` | `400` | `validation` | Event timestamp outside tolerance window |
| `WEBHOOK_EVENT_MALFORMED` | `400` | `validation` | Body is invalid JSON or missing required fields |
| `WEBHOOK_PROVIDER_UNSUPPORTED` | `400` | `validation` | Unknown provider route parameter |
| `WEBHOOK_DUPLICATE_EVENT` | `409` | `conflict` | Concurrent duplicate event processing race |

---

## Dry-Run Verification

Appending `?dry_run=true` to any webhook URL allows callers to verify signatures and payload validity without persisting the event or executing business logic:

```bash
curl -X POST "http://localhost:3001/webhooks/stripe?dry_run=true" \
  -H "Stripe-Signature: t=1759320000,v1=abc..." \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_123","type":"payment_intent.succeeded"}'
```

Response:
```json
{
  "data": {
    "status": "verified",
    "dry_run": true,
    "provider": "stripe",
    "event_id": "evt_123",
    "event_type": "payment_intent.succeeded",
    "timestamp": "2026-10-01T12:00:00.000Z"
  }
}
```

---

## Testing & Validation

Run the dedicated test suite:

```bash
# Unit tests
pnpm --filter backend test tests/webhookService.unit.spec.ts

# HTTP integration tests
pnpm --filter backend test tests/webhooks.spec.ts
```
