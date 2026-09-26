# Replay Determinism & the Replay-Equivalence Job (#751)

The backend derives chain-dependent state (action outcomes, parked events,
the pool registry, quarantine) from the ordered stream of Soroban contract
events. This document is the proof obligation for that claim: every input to
event processing is listed below, and a scheduled job replays the full event
log into a fresh database and diffs the result against live state.

## The event log

Every raw event the indexer fetches is appended to `chain_events` **before**
it is decoded or reconciled (`StellarIndexer.processRawEvents` →
`LedgerService.appendChainEvents`), so no event can change state without
being replayable. The primary key is the Soroban RPC event id — a 19-digit
TOID plus a 10-digit event index — whose top 32 bits are the ledger sequence,
so ordering by id is chain order ([getEvents](https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents)).
Re-fetched events are no-ops (`createMany … skipDuplicates`).

## Inputs to event processing

Audited path: `StellarIndexer.tick/processRawEvents` →
`LedgerService.reconcileEvents` / `reconcileEvent` / `quarantineEvent` /
`upsertPoolRegistryEntry`, plus the parked-event branch of
`LedgerService.attachTxHash` that completes a reconciliation later.

| Input | Origin | Deterministic under replay | Notes |
|---|---|---|---|
| `id`, `ledger`, `ledgerClosedAt`, `txHash`, `contractId`, `topicXdr`, `valueXdr`, `successful` | Event payload | Yes | Stored verbatim in `chain_events`. |
| XDR decoder (`sorobanNativeXdrDecoder`) | Code | Yes | Pure function of topic/value. Versioned by `SCHEMA_VERSIONS.INDEXER`; a decoder change is a replay-behaviour change. |
| `VAULT_FACTORY_ADDRESS` | Config | Pinned | The job reads the same env value as the indexer. |
| Action intents matched by `tx_hash` | Off-chain (`POST /actions`, `PATCH /actions/:id/submitted`) | Input | Seeded into the replay database from the same snapshot. |
| Terminal-status check on the matched row | Derived state | Yes | Depends only on earlier events in log order. |
| Operator-resolved poison events (`resolved_at`) | Off-chain | Input | The live cursor was moved past them, so replay skips them too. |
| `confirmedAt` of a reconciled action | **Was `new Date()`** | **Fixed** | Now the emitting ledger's `ledgerClosedAt`, on both the direct path and the parked-event path (`pending_events.ledger_closed_at`). |
| `received_at`, `consumed_at`, `ingested_at`, `created_at`, `updated_at`, `submitted_at` | Wall clock | Not part of state | Bookkeeping timestamps; excluded from the comparison. |
| Redis pending-event cache | External | Mirror only | Write-through copy of `pending_events`; now carries `ledgerClosedAt`. Replay runs without the cache. |
| `onActionConfirmed` → `DrawProofService.generateProof` | **Live RPC reads** (`getContractData`, `getTransaction`, `getEvents`) | **No** | Reads current contract state, not the event. Kept outside the replayed projection: the replay `LedgerService` registers no callback, and `draw_proofs` is classified off-chain (see [`DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md)). |
| `POST /internal/reconcile` | HTTP, decoded payload only | **No log entry** | Carries no raw XDR, so it cannot be logged or replayed; `ledger_closed_at` is optional there and falls back to the wall clock. Rows reconciled this way show up as divergence — the in-process indexer is the replayable path. |
| Batch boundaries | RPC pagination | Yes, with one edge | Same-kind events of one transaction converge across batches (terminal-row no-op / `skipDuplicates`). One edge remains: the intra-batch `txHash` de-dup drops a second event of a *different* kind (e.g. `fpooldep` + a pool event in one tx) only when both land in the same batch. The job detects that case if it ever occurs. |
| `Map`/`Set` iteration | Code | Yes | `seenInBatch` is membership-only, `rowByHash` lookup-only; outcomes keep input order. |
| Random values | — | None | No randomness in event processing; generated UUID primary keys are excluded from comparison keys. |

## What is compared

Inside the horizon `[first logged event id, live checkpoint cursor]`:

| Projection | Key | Compared fields |
|---|---|---|
| `action_ledger` | `id` | For `confirmed`/`reverted` rows whose event is in the horizon: `status`, `soroban_event_id`, `verified_payload`, `confirmed_at`, `error_code`. Every other row projects to "no chain outcome". |
| `pending_events` (unconsumed) | `tx_hash` | `soroban_event_id`, `event_payload`, `status_hint`, `ledger_closed_at` |
| `pool_registry` | `pool_address` | `salt`, `factory_address`, `admin`, `asset`, `wasm_hash`, `deployed_ledger` (ledgers strictly inside the horizon) |
| `poison_events` (unresolved) | `soroban_event_id` | `tx_hash`, `reason` |

The upper bound is the persisted checkpoint cursor: it is written only after
a tick commits, so every event up to it has certainly been applied; events
logged but not yet applied are ignored on both sides.

## How the job works

`startReplayEquivalenceCron` (`backend/src/cron.ts`), engine in
`backend/src/services/replayEquivalence.ts`:

1. Opens one `REPEATABLE READ` transaction on the live database, so intents,
   log, checkpoint, and state are a single consistent snapshot while the
   indexer keeps writing.
2. Truncates the scratch database, copies the live intents, and resets their
   chain-derived columns.
3. Replays the log through the unmodified `StellarIndexer` using
   `ChainEventLogSource`, which serves `chain_events` exactly as the RPC
   source serves the chain.
4. Diffs the projections with a streaming merge join (O(rows) time,
   O(page) memory), counting mismatched, missing, and extra rows.
5. Exports `replay_equivalence_divergences` and
   `replay_equivalence_last_run_timestamp_seconds`, and logs
   `replay_equivalence.divergence` (error) or `replay_equivalence.ok`.

Configuration: `REPLAY_DATABASE_URL` (dedicated scratch database, migrations
applied, truncated every run — the server refuses to start if it points at
the live database) and `REPLAY_SCHEDULE` (default `30 3 * * *`). The job
holds the `replay-equivalence` job lease, so only one replica runs it.

Detection is proven in CI by `backend/tests/replayEquivalence.spec.ts`, which
runs the job against a Testcontainers snapshot and must catch two
deliberately introduced bugs: a decoder that adds a random value outside the
payload, and the pre-#751 wall-clock `confirmedAt`.

## When `ReplayDivergence` fires

1. Read the `replay_equivalence.divergence` log line: `report.tables[].samples`
   lists up to 20 `mismatch:` / `missing:` / `extra:` keys per table.
2. For an `action_ledger` key, trace its transaction
   (`GET /internal/trace/:txHash`, see [`ARCHITECTURE.md`](./ARCHITECTURE.md)) and
   check whether it was reconciled through `POST /internal/reconcile`
   (expected divergence — not replayable) or by the indexer (a real
   determinism bug).
3. Diff the row in both databases; the scratch database keeps the replayed
   state until the next run.
4. A real divergence means a rebuilt read model would differ from production:
   do not rely on replay-based recovery ([`DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md))
   until the non-deterministic input is removed and the job is green again.

`ReplayEquivalenceStale` (no completed run in 26 hours) means the job is
failing or unscheduled; check the `replay-equivalence: failed` log line.
