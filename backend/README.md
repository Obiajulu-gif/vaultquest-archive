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

## Contributor diagnostics

Before you start working on VaultQuest -- and any time your local setup stops behaving -- run the diagnostics command:

```bash
pnpm run doctor
```

It checks the complete local contributor environment in one pass and prints a pass/fail report with actionable remediation text for every failure.

What it verifies:

| Area              | Check                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Tooling           | Node 20+, pnpm, Docker daemon reachable via `pnpm run doctor`      |
| Dependencies      | `node_modules` installed and Prisma client generated               |
| Configuration     | `.env` present and validated against the Zod boot schema           |
| Database          | Postgres 16 connectivity, migration status, and seed fixtures      |
| Integration mocks | Local event-indexer and wallet-rpc mocks configured and responsive |
| Test fixtures     | Required fixture files present and parseable                       |

The command is read-only against your database: migration and seed checks use `introspection `/ `SELECT` queries only. It never runs migrations, seeds, or writes, and it never touches production data. By default it targets the local `.env` configuration; pass `--env <path>` to check a different file.

Run it:

- After cloning and `cp .env.example .env`, before your first `dn:setup`.
- After changing anything in `.env` or the Prisma schema.
- Before opening a pull request, to confirm your local environment matches the expected stack.
- Whenever a test fails for reasons that look environmental rather than logical.

Exit code is `0` when every check passes and non-zero when any check fails, so it is safe to wire into CI or a pre-commit hook.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | /health | Liveness probe |
| POST | /actions | Create intent (requires `Idempotency-Key: <uuid>`) |
| PATCH | /actions/:id/submitted | Attach `tx_hash` after wallet broadcasts |
| POST | /actions/:id/cancel | Mark a pending intent failed |
| GET | /actions/:id | Read a single action |
| GET | /actions?wallet=G...&status=&cursor=&limit= | Paginated activity history |
| GET | /dashboard/summary?wallet=G...&stale_after_ms= | Per-wallet rollup for the dashboard (#14) |
| GET | /saved-pools?wallet=G... | Saved-pools watchlist entries |
| POST | /saved-pools | Save or update a pool watchlist entry |
| DELETE | /saved-pools/:poolId?wallet=G... | Remove a saved pool from a wallet watchlist |
| DELETE | /actions?wallet=G... | Privacy scrub (nulls payload, sets redacted_at) |
| POST | /internal/reconcile | Event indexer → ledger (requires `X-Internal-Secret`) |
| POST | /internal/imports/dry-run | Validate a bulk import without writing; report create/update/skip/duplicate/error counts and conflicts |
| POST | /internal/reconciliation/repair | Manual repair command (dry-run by default, audit output) |
| GET | /internal/cache/stale?kind=&limit= | Service-authenticated, bounded stale-cache inspection with repair recommendations |
| POST | /internal/cache/repair | Service-authenticated cache repair (dry-run by default; supports kind/key scoping) |

For the manual repair command contract, see [`docs/RECONCILIATION.md`](../docs/RECONCILIATION.md). See `docs/superpowers/specs/2026-04-23-action-ledger-design.md` for the full contract, and [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the service layout, schema, worker runtime, and migration strategy. For background drift detection, automated repair pipelines, and quarantine incident response, see [`docs/RECONCILIATION.md`](../docs/RECONCILIATION.md). For response envelopes, errors, and pagination, see [`docs/API_RESPONSES.md`](docs/API_RESPONSES.md). For how the frontend should submit, poll, and **retry** these endpoints safely, see [`docs/transaction-status-api.md`](docs/transaction-status-api.md). Indexer contributors should also follow the contract [`event schema`](../contracts/docs/EVENT_SCHEMA.md) and [`pause/recovery model`](../contracts/docs/PAUSE_RECOVERY.md). For how confirmations become quest completions and reward grants (idempotency, reorg correction, and the current payout state), see [`docs/QUEST_REWARDS.md`](../docs/QUEST_REWARDS.md).

Maintainers can preview bounded stale-index findings with `GET /api/search/repair/preview?type=vault&limit=100`; see [`SEARCH_INDEXING_AND_REPAIR.md`](../docs/SEARCH_INDEXING_AND_REPAIR.md) for recommendations, failure modes, and recovery guidance.

## Environment

For structured maintainer notes, escalation policies/inbox, replay integrity,
and read-only backup snapshots, see [Maintainer operations](../docs/MAINTAINER_OPERATIONS.md).

See `.env.example`. All values are validated at boot via Zod. Background worker settings: `WORKER_ENABLED` (default `true`) and `WORKER_POLL_INTERVAL_MS` (default `2000`); see [`docs/BACKGROUND_JOBS.md`](docs/BACKGROUND_JOBS.md).

## Errors, telemetry, jobs and the API contract

- Error codes, categories and user-safe messages: [`../docs/API.md#standard-errors`](../docs/API.md#standard-errors) (`src/errorTaxonomy.ts`).
- Metrics, structured log fields and dashboard queries: [`docs/OBSERVABILITY.md`](docs/OBSERVABILITY.md).
- Background worker, retry policy, dead-letter handling and local instructions: [`docs/BACKGROUND_JOBS.md`](docs/BACKGROUND_JOBS.md).
- The public API contract is checked by `tests/apiContract.spec.ts`; update `../docs/API.md` and `src/contracts/apiContract.ts` together with any response change.

## Bulk import dry-run

Bulk imports preview all changes and conflicts before any record is written. The dry-run endpoint is read-only: within a transaction it never commits, so no action, saved-pool, or audit row is created, updated, or redacted.

```http
POST /internal/imports/dry-run
X-Internal-Secret: <secret>
Content-Type: application/json

{
  "source": "vaultquest-csv-2026-04",
  "delemimeter": ",",
  "columns": ["wallet", "poolId", "amount", "asset", "occurredAt"],
  "rows": [
    { "wallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "poolId": "pool-1", "amount": "100.00", "asset": "USDC", "occurredAt": "2026-04-20T10:00:00Z" },
    { "wallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "poolId": "pool-1", "amount": "100.00", "asset": "USDC", "occurredAt": "2026-04-20T10:00:00Z" }
  ]
}
```

Response (200):

```json
{
  "dryRun": true,
  "source": "vaultquest-csv-2026-04",
  "totalRows": 2,
  "counts": { "create": 1, "update": 0, "skip": 0, "duplicate": 1, "error": 0 },
  "rows": [
    {
      "index": 0,
      "action": "create",
      "wallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "poolId": "pool-1"
    },
    {
      "index": 1,
      "action": "duplicate",
      "wallet": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "poolId": "pool-1",
      "duplicateOf": 0
    }
  ],
  "conflicts": [],
  "errors": []
}
```

When a row fails validation the dry run returns `200` with a `duplicate`/`error` count and actionable per-row messages. Requests that fail authentication or shape validation return the standard error envelope from [`../docs/API.md#standard-errors`](../docs/API.md#standard-errors).

### Input format

| Field       | Required | Notes                                                                                  |
| ----------- | -------- | -------------------------------------------------------------------------------------- |
| `source`    | yes      | Opaque import batch identifier, echoed back in the report                              |
| `delimiter` | no       | Only `,` or `\t`; defaults to `,`. Used when columns are declared and rows are strings |
| `columns`   | yes      | Ordered column names; must include `wallet`, `poolId`, `amount`, `asset`, `occurredAt` |
| `rows`      | yes      | Array of objects keyed by column name, or array of delimiter-separated strings         |

Validation rules (enforced by `Zod` in `src/imports/dryRun.ts`):

- `wallet` must be a Stellar address (`S[1-9]{56}`).
- `poolId` must be a non-empty string of at most 64 characters.
- `amount` must be a positive decimal string with at most 7 fractional digits.
- `asset` must be a non-empty uppercase ticker of at most 12 characters.
- `occurredAt` must be an ISO 8601 datetime not in the future.
- Duplicate rows within the payload are detected by the composite key `wallet + poolId + asset + occurredAt`.
- Rows that match an existing ledger entry are reported as `update` or `skip` depending on whether the amount differs.
- Rows that collide with a pending action for the same wallet and pool are reported as `conflicts` with a code and human-readable message.

Conflict and error entries never echo column values other than the wallet address and pool identifier, and never include tokens, secrets or signed payloads. See [`docs/API.md`](../docs/API.md) for the complete field reference and example responses.

## Tests

Tests use Testcontainers to spin up Postgres 16 per run. Docker must be available.

```bash
pnpm test
```

# Post-restore validation

After restoring a backup, run the backend db:validate-restore script with
DATABASE_URL set to the restored database. The command is read-only and runs
its checks in a repeatable-read, read-only transaction. It reports missing
core tables and counts for inconsistent confirmed actions, settlement
timestamps, reward grants, saved-pool registry references, chain-event
identifiers, and duplicate/orphan quest records. It never prints wallet
addresses, transaction hashes, payloads, or the database URL.

Exit code 0 means the checked invariants passed; 1 means the report needs
maintainer review; 2 means the database/schema could not be checked. A
reported count is a recovery lead, not permission to edit a financial record:
compare affected rows with chain history and use the normal reconciliation
workflow. Escalate unresolved payout, settlement, or chain-event mismatches to
the protocol maintainer before resuming user-facing operations. This is a
consistency check, not a replacement for the chain-aware disaster-recovery
drill.

# Privacy-preserving maintainer analytics

The authenticated internal endpoint `/internal/analytics/summary` returns a
30-day aggregate of action type/status, settlement state, reward status,
background-job status, and distinct participant count. The lookback is bounded to 1–90 days at the
service boundary. It is computed on demand in a repeatable-read, read-only
transaction; no analytics events or identifiers are persisted. Raw wallet
addresses, transaction hashes, emails, and payloads are never selected into
the response. Distinct-participant counts below five are suppressed. The
window is the retention policy: only source records created in that interval
contribute to the response. Access requires the internal service secret and
the dedicated internal analytics-read permission.
