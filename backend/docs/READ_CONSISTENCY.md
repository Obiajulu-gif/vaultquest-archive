# Read consistency during burst ingestion (#731)

This document is the consistency model for the action-ledger read APIs the
dashboard depends on: `GET /actions`, `GET /dashboard/summary`,
`GET /portfolio/summary`, and `GET /dashboard/aggregates`. Read it before
adding a new read endpoint over `action_ledger` / `chain_events`, or before
adding a new field that's computed from more than one query.

## The problem

Ingestion (`StellarIndexer.tick()` → `LedgerService.reconcileEvents`) can
apply a burst of writes in a short window — most visibly right after a round
closes and many balance-affecting events confirm at once. A read endpoint
issuing more than one query against `action_ledger` without a shared
transaction can have a write land *between* those queries, producing an
internally torn response: e.g. status counts reflecting one moment and "most
recent activity" reflecting a later one.

## What's already atomic

- `LedgerService.reconcileEvents` applies one ingestion batch (bounded by
  the indexer's `batchSize`, default 50) as a single Prisma `$transaction`.
  A reader can never observe a *partial* batch — Postgres MVCC guarantees a
  read either sees the whole batch's effects or none of them.
- A **burst** can still span multiple batches/ticks, each its own
  transaction. Nothing prevents a multi-query read from straddling two of
  those — that's the actual torn-view risk this document is about.

## The fix: snapshot the multi-query reads, and report a watermark

1. **Snapshot isolation for multi-query reads.** Any read that combines more
   than one query into a single logical response wraps them in one
   `Serializable` Prisma transaction, so all queries see the same DB
   snapshot:
   - `DashboardAggregateService.refreshAggregates` (pre-existing, #750).
   - `LedgerService.getDashboardSummary` (#731) — status counts, pending tx
     hashes, and latest-activity are now read inside one transaction instead
     of three sequential round-trips.

   `getPortfolioSummary` and `listActions` are each already a single query,
   so they're internally consistent without an explicit transaction — a
   single `SELECT` is always one MVCC snapshot.

2. **A monotonic ingestion watermark on every read.** `IndexerCheckpoint.
   latestLedger` — the Stellar ledger sequence the indexer has fully
   processed, bumped once per completed batch — is a genuinely monotonic
   counter (unlike a wall-clock timestamp, it can't tie or skew). Every read
   endpoint listed above now reports it:

   | Endpoint | Where the watermark is read | Meaning |
   |---|---|---|
   | `GET /dashboard/summary` | inside the same snapshot transaction as the summary fields | exactly matches the data returned |
   | `GET /actions` | a separate, immediately-following read | describes "at least this fresh"; the list itself was already one atomic query |
   | `GET /portfolio/summary` | a separate, immediately-following read | same as above |
   | `GET /dashboard/aggregates` | `DashboardAggregateService`'s own `watermark` (a timestamp, `MAX(updated_at)` of the rows the aggregate was computed from) | pre-existing (#750); a different, aggregate-scoped watermark — see below |

   Response shape: `meta.watermark` (list endpoints) or a top-level
   `watermark` field (summary endpoints), each `{ latest_ledger, as_of }`.

3. **Client-side handling.** A client assembling a view from more than one of
   these endpoints (e.g. `/dashboard/aggregates` + `/actions` for the detail
   rows, as documented in `dashboardAggregates.ts`) should treat the reads as
   consistent with each other only when their watermarks agree (or the
   detail rows' `updated_at` values are all `<=` the aggregate's watermark —
   `DashboardAggregateService.verifyWatermarkAlignment` already implements
   this comparison). A mismatch means the reads straddled a burst; the UI
   should show a brief "refreshing…" state and re-fetch rather than render
   the mismatched combination as fact.

## Why two different watermark shapes exist

`dashboard_aggregates.watermark` (a timestamp) and `IndexerCheckpoint.
latestLedger` (a ledger sequence) answer different questions on purpose:

- The aggregate's timestamp watermark says *which detail rows were folded
  into this specific aggregate snapshot* — it only advances when
  `refreshAggregates` runs, not on every ingested write.
- The ingestion watermark says *how far ingestion has actually progressed
  right now* — it advances on every completed indexer batch, independent of
  whether any aggregate has been recomputed since.

Comparing a detail row's `updated_at` against the aggregate's watermark (as
`verifyWatermarkAlignment` does) answers "is this row already reflected in
the aggregate?". Comparing two reads' `latest_ledger` values answers "did
these two reads see the same ingestion generation?". Both are useful; they
are not interchangeable.
