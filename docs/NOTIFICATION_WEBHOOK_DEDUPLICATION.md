# Notification and Webhook Deduplication

## Overview

`lib/notification-webhook-dedup.ts` provides a unified, tenant-scoped deduplication coordinator (`NotificationWebhookDedupCoordinator`) for both **notifications** (`notification`) and **webhooks** (`webhook_inbound`, `webhook_outbound`).

It preserves all existing contracts (`lib/notification-dedup.ts`, `backend/src/services/notificationService.ts`, `backend/src/services/webhookService.ts`, and `backend/src/services/webhookDelivery.ts`) and can be adopted incrementally behind a pluggable `DedupStore` interface.

## Deterministic Key Format

```text
<channel>:<tenantId>:<eventType>:<eventId>:<target>
```

- All segments are trimmed and lowercased.
- Missing or empty segments fail fast with `DedupError("INVALID_KEY", 400)`.
- Including `channel`, `tenantId`, and `target` guarantees that:
  - A notification and an outbound webhook for the same `eventId` do not collide.
  - Different tenants or subscriber endpoints never share deduplication state.

## Lifecycle & State Machine

| State | Meaning | Duplicate Behavior |
| --- | --- | --- |
| `in_flight` | A worker holds an active lease (`leaseExpiresAt > now`). | Returns `{ status: "in_flight", deduplicated: true }` without re-executing. |
| `completed` | Delivery succeeded and result is cached until `expiresAt`. | Returns `{ status: "duplicate", deduplicated: true, result }`. |
| `failed_retryable` | Transient error (`retryable: true`) and `attempts < maxAttempts`. | Next dispatch increments `attempts`, acquires a fresh lease, and retries. |
| `failed_terminal` | Non-retryable error (`retryable: false`) or `attempts >= maxAttempts`. | Blocks automatic retries (`deduplicated: true`) until operator recovery. |

## Authorization Model

- **Authentication (`401 UNAUTHENTICATED`)**: Requires a `DedupPrincipal` with non-empty `actorId` and `tenantId`.
- **Tenant Isolation (`403 UNAUTHORIZED`)**: Non-privileged roles (`user`, `service`) can only dispatch or inspect records belonging to their own `tenantId`.
- **Channel Scope (`403 UNAUTHORIZED`)**: `user` principals are restricted to the `notification` channel; `allowedChannels` can further restrict any principal.
- **Operator Actions (`403 UNAUTHORIZED`)**: `requeueForRecovery`, `rollbackEntry`, and `pruneExpired` require `admin` or `system` role.

## Edge Cases

1. **Payload Conflict on Reused Key (`409 PAYLOAD_CONFLICT`)**: Payloads are canonicalized (recursively sorted object keys) and SHA-256 hashed. Reusing an active dedup key with a different payload throws `PAYLOAD_CONFLICT` instead of silently returning a stale result.
2. **Worker Crash During `in_flight`**: Every `in_flight` record carries a `leaseExpiresAt` timestamp (default `30s`). Once the lease expires, a retry worker automatically takes over and increments `attempts`.
3. **TTL Expiration & Pruning**: Completed notifications expire after `24h` and webhooks after `7d` by default. Expired records are ignored on read and removed by `pruneExpired()`.

## Recovery & Rollback

- **Recovery (`requeueForRecovery`)**: After a downstream outage or bug fix, an `admin`/`system` principal resets a `failed_terminal` record to `failed_retryable` with `attempts = 0` so the next dispatch safely replays.
- **Rollback (`rollbackEntry`)**: Deletes the dedup entry completely (e.g., to roll back a poisoned payload or faulty deployment), allowing fresh evaluation.
- **Zero-Downtime Migration Plan**:
  1. Deploy `NotificationWebhookDedupCoordinator` alongside existing services (no breaking schema or API changes).
  2. Implement a persistent `DedupStore` adapter (e.g., Prisma/Postgres or Redis) backed by a unique index on `dedupKey`.
  3. Wrap `NotificationService` and `WebhookDeliveryService` calls with `coordinator.dispatch(...)`.
  4. Rollback by bypassing the coordinator wrapper; existing service behavior remains intact.

## Verification

Run the automated test suite:

```bash
node --test tests/notification-webhook-dedup.test.ts
```
