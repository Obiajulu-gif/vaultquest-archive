# Operator-Safe Backfill Tool

## Overview
During network partitions, RPC provider downtime, or indexer lags, transactions confirmed on the Stellar network may not immediately be ingested into the `action_ledger` table. When recovering from an outage, operators need a deterministic, safe way to backfill missing blocks and transactions without causing duplicates, data drift, or race conditions.

The VaultQuest backfill tool (`backend/src/scripts/backfill.ts` and `BackfillService`) provides:
1. **Dry-Run Diff Preview**: Previews exact creates, updates, and skips before any database modification.
2. **Resumable Checkpoints**: Persists progress in `indexer_checkpoints` so interrupted runs resume seamlessly without duplicating work.
3. **Explicit Skip & Error Reporting**: Categorizes records as `create`, `update`, `skip` (e.g., `RECORD_ALREADY_CONFIRMED`), or `error`.
4. **Consistency Verification**: Compares the checkpoint sequence against maximum observed ledger sequences in `action_ledger`.

---

## CLI Usage & Commands

```bash
# 1. Inspect status and gap to chain tip
pnpm backfill --status

# 2. Verify consistency between checkpoint and action ledger
pnpm backfill --verify

# 3. Simulate backfill with dry-run diff preview (no database writes)
pnpm backfill --from 1000000 --to 1050000 --dry-run

# 4. Execute live backfill
pnpm backfill --from 1000000 --to 1050000

# 5. Resume from last saved checkpoint automatically
pnpm backfill

# 6. Rewind/reset checkpoint to re-index a block range
pnpm backfill --reset-checkpoint 995000 --force
```

---

## Dry-Run Diff Format

When executed with `--dry-run`, the tool formats a structured preview:
```text
=======================================================
VaultQuest Backfill Report: [DRY RUN PREVIEW - NO CHANGES APPLIED]
Ledger Range: 1000000 -> 1000500
Checkpoint: 999999 -> 999999
Total Scanned: 3
Applied: 2 | Skipped: 1 | Failed: 0
Duration: 14ms
-------------------------------------------------------
+ [CREATE] tx:0x9812f8a... type:claim ledger:1000001
    New payload: {"txHash":"0x9812f8a...","walletAddress":"GABC...","actionType":"claim","status":"confirmed","observedLedger":1000001}
~ [UPDATE] tx:0x41ba3c9... type:deposit ledger:1000002
    Before: {"status":"pending","observedLedger":null}
    After:  {"txHash":"0x41ba3c9...","status":"confirmed","observedLedger":1000002}
= [SKIP]   tx:0x12c49a1... reason:RECORD_ALREADY_CONFIRMED
=======================================================
```

---

## Operational Edge Cases & Rollback / Recovery

### 1. Checkpoint Divergence
If `pnpm backfill --verify` flags divergence (`gap > 1000 ledgers`):
- Run `pnpm backfill --status` to inspect current sync times and gaps.
- If the checkpoint is ahead of the database due to a rolled-back transaction, reset the checkpoint using:
  `pnpm backfill --reset-checkpoint <targetLedger> --force`

### 2. Duplicate Deliveries & Anti-Drift
- All writes to `action_ledger` are idempotent upserts keyed by `txHash`.
- Events already present in `action_ledger` with matching `observedLedger` are skipped (`RECORD_ALREADY_CONFIRMED`) rather than re-written.
- Changes in status (e.g. `pending` -> `confirmed`) are logged as updates with before/after diff tracking.

### 3. Partial Failure in Batches
- Each batch is processed atomically.
- Records causing processing errors are captured in `errors` with exact failure details.
- The checkpoint only advances up to the highest contiguous successfully verified ledger.
