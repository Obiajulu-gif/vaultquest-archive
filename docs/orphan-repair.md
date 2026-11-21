# Resumable Orphan-Repair Command with Checkpoints

This document describes the resumable orphan-repair engine ([lib/orphan-repair.ts](../lib/orphan-repair.ts)) and CLI command ([scripts/orphan-repair.ts](../scripts/orphan-repair.ts)).

## Overview

The orphan-repair command scans orphaned records (`deposit`, `ticket`, `reward`, `session`), repairs them in deterministic ID order in bounded batches, and persists atomic checkpoints after every batch so interrupted or partially failed runs can be safely resumed or rolled back.

## Usage

### Dry-run (read-only)

```bash
npx tsx scripts/orphan-repair.ts \
  --run-id repair-2026-11-21 \
  --input ./orphans.json \
  --checkpoint-file ./.orphan-repair-checkpoint.json \
  --actor-id auditor-1 \
  --actor-role auditor \
  --dry-run
```

### Execute repairs with checkpointing

```bash
npx tsx scripts/orphan-repair.ts \
  --run-id repair-2026-11-21 \
  --input ./orphans.json \
  --checkpoint-file ./.orphan-repair-checkpoint.json \
  --batch-size 25 \
  --max-retries 3 \
  --actor-id ops-1 \
  --actor-role operator
```

### Resume an interrupted or failed run

```bash
npx tsx scripts/orphan-repair.ts \
  --run-id repair-2026-11-21 \
  --input ./orphans.json \
  --checkpoint-file ./.orphan-repair-checkpoint.json \
  --actor-id ops-1 \
  --actor-role operator \
  --resume
```

Add `--retry-dead-lettered` when resuming if previously dead-lettered records should be retried after an upstream fix.

### Rollback a run

```bash
npx tsx scripts/orphan-repair.ts \
  --run-id repair-2026-11-21 \
  --checkpoint-file ./.orphan-repair-checkpoint.json \
  --actor-id ops-1 \
  --actor-role operator \
  --rollback
```

## Authorization Rules

| Role | `--dry-run` | Mutating repair | `--rollback` |
| --- | --- | --- | --- |
| `admin` | Allowed | Allowed | Allowed |
| `operator` | Allowed | Allowed | Allowed |
| `auditor` | Allowed | Denied (`UNAUTHORIZED`, exit code `2`) | Denied (`UNAUTHORIZED`, exit code `2`) |
| `viewer` | Denied (`UNAUTHORIZED`, exit code `2`) | Denied (`UNAUTHORIZED`, exit code `2`) | Denied (`UNAUTHORIZED`, exit code `2`) |

Explicit permission overrides (`orphan:read`, `orphan:repair`, `orphan:rollback`) are supported on `OrphanRepairActor.permissions`.

## Edge Cases & Recovery / Rollback Behavior

- **Mid-batch crash or `AbortSignal`**: Checkpoints are persisted via atomic temp-file write + rename (`FileCheckpointStore`). Completed record IDs are recorded in `completedIds` and skipped on `--resume`. Every `repairRecord` call receives a deterministic `idempotencyKey` (`orphan-repair:<runId>:<recordId>`).
- **Accidental overwrite of an in-progress run**: Starting a run with an existing non-completed checkpoint without `--resume` fails fast with `OrphanRepairCheckpointError`.
- **Corrupt or mismatched checkpoint file**: Invalid JSON, unsupported schema version, or mismatched `runId` throws `OrphanRepairCheckpointError` (exit code `1`) rather than silently overwriting state.
- **Transient vs. permanent failures**: Each record is retried up to `maxRetries`. Exhausted records are marked `deadLettered: true` in `failedRecords` and skipped on subsequent `--resume` runs unless `--retry-dead-lettered` is explicitly passed. Use `--stop-on-failure` to halt immediately in `paused` state on the first exhausted record.
- **Reverse-order idempotent rollback**: `rollbackOrphanRepair` iterates `rollbackLog` in reverse application order, persists `rolledBackAt` after each reverted entry, and skips already reverted entries if rollback itself is interrupted and retried. Dry-run executions do not append to `rollbackLog`.

## Contract Preservation

This feature is additive and preserves all existing contracts (`lib/recovery-checkpoints.ts`, existing scripts, and APIs are untouched). No schema or data migration is required.
