# Dry-Run Repair Tooling with Checkpoints (#1067)

## Overview
`src/lib/dry-run-repair.mjs` provides a resumable, checkpointed repair runner across the three canonical VaultQuest repair phases (`orphaned_actions`, `stale_pending_events`, `unresolved_settlements`). It aligns with `backend/src/services/resumableRepairJob.ts`.

## Authorization
- **Dry-run (`dryRun: true`)**: Permitted for `operator` and `admin` roles (or actors with `repair:dry-run` / `repair:execute` scopes).
- **Live mutations (`dryRun: false`)**: Restricted to `admin` role or explicit `repair:execute` scope. Unprivileged actors fail fast with `RepairAuthorizationError` (`REPAIR_UNAUTHORIZED`, HTTP 403).

## Normal & Dry-Run Behavior
- **Dry-run**: Scans records in bounded batches (`batchSize` 1–500), records deterministic `plannedActions` and a SHA-256 `planDigest`, and persists checkpoints after every batch **without** calling any mutating method on `dataSource`.
- **Live apply**: Executes mutations per record, tracks `isRecordProcessed(jobId, phase:recordId)` for idempotency, and persists `cursor` and `stats` after each batch.

## Failure, Retry & Recovery / Rollback
- **Transient failures**: `runRepairJob` and `resumeRepairJob` retry retryable errors up to `maxRetries`. If retries are exhausted during a batch, the job transitions to `status: "paused"` at the last clean `cursor` and records the error in `checkpoint.errors`.
- **Resuming**: Calling `resumeRepairJob({ jobId, actor, dataSource, checkpointStore })` reloads the saved checkpoint and resumes from `currentPhase` and `cursor` without re-applying already-processed records.
- **Permanent record failures**: Non-retryable record errors are logged in `checkpoint.errors` and counted in `stats.failedCount` while allowing remaining records in the batch to proceed.
- **Rollback**: Operators should always run `dryRun: true` first to inspect `plannedActions` and `planDigest` before authorizing live execution.
