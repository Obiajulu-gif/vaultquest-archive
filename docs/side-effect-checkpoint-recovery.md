# Durable side-effect checkpoints (#1160)

The worker's existing Postgres-backed `SideEffectLedger` is the durable checkpoint for external effects. This change assigns a unique owner token to every dispatch attempt rather than reusing a worker-wide owner ID.

## Guarantees

- A completed effect is returned as a duplicate and is not dispatched again.
- A concurrent unexpired claim is reported as in-flight; the job worker can retry it later.
- A failed effect releases its claim and is eligible for a later retry.
- Each attempt has a distinct fencing token. A slow attempt cannot complete or fail a claim reclaimed by a later attempt, even on the same dispatcher instance.
- Existing database schema and serialized job contracts are unchanged.

## Failure and recovery

If a worker exits before recording an outcome, the claim becomes reclaimable after the configured lease. Operators can replay the owning job; completed effects are skipped and failed/stale effects are attempted again.

There remains an unavoidable uncertainty window if a provider accepted the request but the worker crashed before writing `completed`. Pass the stable effect key to provider APIs that support idempotency keys. Do not treat a local ledger as a distributed transaction with an external provider.

## Authorization

Dispatch remains a worker-internal operation. Administrative replay continues to use the existing service-authenticated job routes; this change does not widen those routes or introduce a new public endpoint.

## Verification

Run `pnpm --filter backend exec vitest run tests/side-effect-dispatcher.spec.ts`. The suite covers success, duplicate dispatch, failure/retry, concurrent claims, lease reclaim, fencing, and dead-letter replay.
