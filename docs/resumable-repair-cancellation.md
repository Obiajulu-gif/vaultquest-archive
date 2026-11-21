# Resumable repair cancellation (#1159)

Resumable repair jobs can now be cancelled through the existing internal service-authenticated jobs API:

`POST /internal/repair/resumable/:id/cancel`

## Semantics

Cancellation is cooperative and takes effect at the next batch boundary. The batch already in progress is allowed to finish so its mutations and cursor can be checkpointed consistently. No new batch or phase starts after cancellation is observed.

The checkpoint is persisted with status `cancelled`. A cancelled job is terminal: repeated cancellation is idempotent, and `resumeJob` returns the cancelled checkpoint rather than silently restarting destructive work. Start a new repair job if a fresh run is required.

## Failure and cleanup

A failure during the current batch follows the existing per-record failure isolation and checkpoint behavior. The cursor is advanced only after the record has been processed, so the next operator action can inspect exactly what completed. Cancellation does not roll back already committed repairs; these are durable, individually guarded updates. Review the checkpoint statistics and errors before creating a replacement job.

## Authorization and compatibility

The endpoint uses the same internal-secret guard as start, pause, resume, and checkpoint inspection. Existing job payloads and storage formats are unchanged; the new `cancelled` status is additive. Consumers that exhaustively validate repair statuses should accept this additional terminal state.

## Verification

Run `pnpm --filter backend exec vitest run tests/resumableRepairJob.spec.ts`. Tests cover cancellation at a batch boundary, preserved cursor and completed batch, terminal resume behavior, and route authorization.
