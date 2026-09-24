# Chain-State Disaster Recovery Playbook (#754)

This playbook covers the backend database being **lost, corrupted, or rolled
back to an old backup** — distinct from normal drift
([`RECONCILIATION.md`](./RECONCILIATION.md)), which assumes the database is
intact. On-chain state is the source of truth for funds, so every
chain-derived row must be rebuildable from chain history; everything that
only ever existed off-chain must come from a backup.

## 1. Data classification

Source of truth: `DATA_CLASSIFICATION` in
`backend/src/services/dataClassification.ts`, keyed by `Prisma.ModelName` —
adding a model without classifying it fails the TypeScript build, and
`tests/dataClassification-unit.spec.ts` fails if a table is missing below.
Keep this table in sync in the same PR as any schema change.

| Table | Class | Recovery source | Why |
|---|---|---|---|
| `chain_events` | chain-derived | Soroban RPC / archive | Raw contract events; re-fetched by `refillEventLog`. |
| `pending_events` | chain-derived | Replay | Events awaiting an intent. |
| `pool_registry` | chain-derived | Replay | Mirror of vault-factory `fpooldep` events. |
| `indexer_checkpoints` | chain-derived | Replay | Written at the end of a rebuild. |
| `action_ledger` | **mixed** | Backup + replay | Intent (wallet, type, payload, idempotency key, `tx_hash`, `submitted_at`) is off-chain; `status`, `soroban_event_id`, `verified_payload`, `confirmed_at`, `error_code` of on-chain outcomes are replayed. |
| `poison_events` | **mixed** | Backup + replay | Quarantine is replayed; operator resolution (`resolved_at`) is off-chain. |
| `users` | off-chain | Backup | Profiles. |
| `vault_settlements` | off-chain | Backup | Admin settlement pipeline state. |
| `user_quests` | off-chain | Backup | Progress is derivable from confirmed actions, but `completed_at` (reward timing) is wall-clock. |
| `reward_grants` | off-chain | Backup | Exactly-once reward payout records. |
| `protocol_audits` | off-chain | Backup | Admin parameter audit trail. |
| `repair_audits` | off-chain | Backup | Repair audit trail. |
| `repair_proposals` | off-chain | Backup | Dual-control proposals. |
| `repair_approvals` | off-chain | Backup | Dual-control approvals. |
| `repair_quarantine` | off-chain | Backup | Drift triage. |
| `saved_pools` | off-chain | Backup | Watchlists. |
| `Product` | off-chain | Backup | Catalogue. |
| `ProductImage` | off-chain | Backup | Catalogue. |
| `categories` | off-chain | Backup | Catalogue. |
| `draw_proofs` | off-chain | Backup | Built from live contract-state RPC reads at generation time; not reproducible from events. |
| `notifications` | off-chain | Backup | Reminders and dismissals. |
| `notification_preferences` | off-chain | Backup | Preferences. |
| `transaction_metrics` | off-chain | Backup | Client-reported timing telemetry. |
| `action_leases` | ephemeral | Dropped | Worker leases, stale after restore. |
| `job_leases` | ephemeral | Dropped | Cron leases; stale ones would block jobs until expiry. |
| `wallet_challenges` | ephemeral | Dropped | Short-lived nonces. |
| `wallet_sessions` | ephemeral | Dropped | Restoring would resurrect sessions revoked after the backup; users sign in again. |

## 2. Off-chain backup strategy

Off-chain (and mixed) data is protected by the existing PostgreSQL backup
service (`backend/src/services/backupService.ts`, #275/#565):

- **Backup:** `pg_dump --format custom` daily (`BACKUP_SCHEDULE`, default
  `0 2 * * *`) into `BACKUP_DIR`, retention `BACKUP_RETAIN_DAYS` (default 7).
  Enabled by setting `BACKUP_DIR`. Ship `BACKUP_DIR` to storage outside the
  database host (object storage with versioning) — a backup on the lost
  host is not a backup.
- **Verify:** `pg_restore --list` integrity check on the archive.
- **Restore:** `pg_restore --no-owner` into a target, refusing the live
  database without an explicit override.
- **Tested:** `backend/tests/backup.spec.ts` (argument construction,
  retention, safety guard); every DR drill (§4) performs a real
  `pg_restore` of the latest archive.
- **Recovery point objective:** one backup interval (24h by default).
  Chain-derived data has no RPO — it is rebuilt from chain — so the loss is
  limited to off-chain rows written after the last backup: new intents,
  profiles, saved pools, admin actions. On-chain funds are never affected;
  an event whose intent was lost is rebuilt as a parked event and matched
  again as soon as the client re-attaches the transaction.

## 3. Chain history sources

| Source | Reach | Use |
|---|---|---|
| Soroban RPC `getEvents` | The node's retention window — default 120,960 ledgers (~7 days), configurable via `history-retention-window` | Default for `refillEventLog`. Each request scans at most 10,000 ledgers, which `refillEventLog` walks in windows. |
| RPC with an extended retention window | As configured | Rebuilds from further back without code changes (`SOROBAN_RPC_URL`). |
| Galexie data lake (`LedgerCloseMeta` in S3/GCS) or Hubble (BigQuery) | Full history | Beyond any RPC window. Events must be extracted from ledger metadata into `chain_events` rows (same id/ledger/tx hash/topic/value shape) before replay. RPC ≥ 23.0 with `SERVE_LEDGERS_FROM_DATASTORE = true` serves that metadata through `getLedgers` only — `getEvents` stays bound to the retention window. |

The deployment's first ledger must stay reachable through one of these, or
chain-derived history older than the RPC window can only come from the
`chain_events` rows inside the latest backup.

## 4. Runbooks

### Full recovery (database lost or corrupted)

1. **Freeze writes.** Scale the backend to zero (API, indexer, and crons share
   the process). Nothing may write to the old database.
2. **Provision** an empty PostgreSQL database for the new primary.
3. **Restore off-chain data** from the newest verified archive:
   ```bash
   pg_restore --list  "$BACKUP_DIR/backup-<ts>.sql.gz" > /dev/null   # integrity
   pg_restore --no-owner --dbname "$NEW_DATABASE_URL" "$BACKUP_DIR/backup-<ts>.sql.gz"
   ```
4. **Rebuild chain-derived state** from chain history:
   ```bash
   cd backend
   pnpm dr:drill --mode rebuild --target-url "$NEW_DATABASE_URL" --start-ledger <ledger>
   ```
   Applies migrations, drops chain-derived/ephemeral tables, re-fetches the
   event log from `<ledger>` to the chain tip, replays it, and writes the
   indexer checkpoint. Use the deployment's first ledger when it is inside the
   RPC window; otherwise the oldest reachable ledger (`getHealth` →
   `oldestLedger`) and accept that older chain-derived rows come from the
   backup as restored. `HALTED_ON_QUARANTINE` means a poison event stopped the
   replay exactly where live would stop — resolve it (INDEXER_RUNBOOK §2b)
   and rerun.
5. **Cut over.** Point `DATABASE_URL` at the new database, start the backend,
   and watch `/health/indexer` and the §2b ingestion alerts until the indexer
   is at the tip.
6. **Communicate the RPO.** Intents created after the backup are gone; affected
   users' transactions are safe on-chain and show up again once re-attached.

### Rolled back to an old backup

Same as full recovery from step 3 onward, run against the rolled-back
database: the rebuild discards its stale chain-derived state and replays
everything since `--start-ledger`, so chain outcomes are current again even
though off-chain rows remain at backup time.

### Suspected corruption of chain-derived rows only

No restore needed: run the replay-equivalence job
([`REPLAY_DETERMINISM.md`](./REPLAY_DETERMINISM.md)) to locate divergent rows,
then `--mode rebuild` against a copy to produce corrected state.

## 5. Disaster-recovery drill

Rehearses §4 on a fresh, empty environment and validates the result against
live:

```bash
cd backend
pnpm dr:drill --target-url "$DRILL_DATABASE_URL" --start-ledger <ledger>
```

It restores the latest archive from `BACKUP_DIR`, applies migrations, rebuilds
chain state from RPC, then — inside one `REPEATABLE READ` snapshot of live —
replays up to live's checkpoint and diffs every chain-derived projection. The
JSON report carries `verdict` (`PASS` = zero chain-derived mismatches),
`rpoLostIntents` (intents created after the backup), per-table counts and
sample keys, and `durationMs` (the measured rebuild time objective).

Schedule it at least monthly and after every schema change (a Kubernetes
CronJob or CI job with access to the backup bucket and a throwaway database).

### Drill log

| Date | Environment | Backup | Start ledger | Verdict | RPO lost intents | Duration | Operator |
|---|---|---|---|---|---|---|---|
| 2026-09-24 | Automated rehearsal (`tests/replayEquivalence.spec.ts`, "disaster recovery" suite): fresh, empty PostgreSQL 17 databases; backup simulated by copying intents; RPC simulated with events spanning two 10,000-ledger scan windows | Simulated | 20,000 / 5,000 | PASS — 0 mismatched, 0 missing, 0 extra | 1 (post-backup intent case: reported as `missing`, its event rebuilt as parked) | < 1 s | Automated |
| _next: staging, real backup + Soroban RPC via `pnpm dr:drill`_ | | | | | | | |
