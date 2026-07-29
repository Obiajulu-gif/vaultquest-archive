# VaultQuest Backend

Action ledger and reconciliation service for TrustQuest (issue #34).

## Stack

- Node 20 + TypeScript
- Fastify 4 (HTTP)
- Prisma 5 + Postgres 16 (storage)
- Zod (validation)
- Pino (logging)
- node-cron (orphan sweep)
- Vitest + Testcontainers (tests against real Postgres)

## Setup

```bash
cp .env.example .env
pnpm install
# Setup database (migrations and mock seed data)
pnpm run db:setup
pnpm test
pnpm dev
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | /health | Liveness probe |
| POST | /actions | Create intent (requires `Idempotency-Key: <uuid>`) |
| PATCH | /actions/:id/submitted | Attach `tx_hash` after wallet broadcasts |
| POST | /actions/:id/cancel | Mark a pending intent failed |
| GET  | /actions/:id | Read a single action |
| GET  | /actions?wallet=G...&status=&cursor=&limit= | Paginated activity history |
| GET  | /dashboard/summary?wallet=G...&stale_after_ms= | Per-wallet rollup for the dashboard (#14) |
| GET  | /saved-pools?wallet=G... | Saved-pools watchlist entries |
| POST | /saved-pools | Save or update a pool watchlist entry |
| DELETE | /saved-pools/:poolId?wallet=G... | Remove a saved pool from a wallet watchlist |
| DELETE | /actions?wallet=G... | Privacy scrub (nulls payload, sets redacted_at) |
| POST | /internal/reconcile | Event indexer → ledger (requires `X-Internal-Secret`) |

See `docs/superpowers/specs/2026-04-23-action-ledger-design.md` for the full contract, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the service layout, schema, worker runtime, and migration strategy. For response envelopes, errors, and pagination, see [`docs/API_RESPONSES.md`](./docs/API_RESPONSES.md). For how the frontend should submit, poll, and **retry** these endpoints safely, see [`docs/transaction-status-api.md`](./docs/transaction-status-api.md). Indexer contributors should also follow the contract [`event schema`](../contracts/docs/EVENT_SCHEMA.md) and [`pause/recovery model`](../contracts/docs/PAUSE_RECOVERY.md).

## Environment

See `.env.example`. All values are validated at boot via Zod.

## Tests

Tests use Testcontainers to spin up Postgres 16 per run. Docker must be available.

```bash
pnpm test
```
