# Conflict-aware offline operation queue

VaultQuest actions (deposits, prize-round claims, saved-pool edits) must not be
lost when the tab refreshes, the network drops, or a second tab edits the same
record. `lib/offline-operation-queue.ts` is a durable queue with optimistic
concurrency control; `lib/useOfflineOperationQueue.ts` binds it to React and
browser connectivity events.

## Guarantees

1. **Durable.** Every operation is persisted to storage *before* any execution
   attempt. A refresh, crash, or reconnect resumes exactly where it left off.
2. **Stale-state aware.** Each operation records the entity's version token at
   composition time. Before executing, the queue compares it with the current
   version. A mismatch parks the operation as a conflict instead of applying
   stale data.
3. **Deterministic choices.** A conflict exposes exactly two outcomes:
   `resolveConflict(id, "retry")` re-reads the authoritative version once and
   requeues, or `resolveConflict(id, "discard")` removes the operation. No
   blind retries, no ambiguous states.

## Lifecycle

```text
enqueue ──▶ queued ──flush──▶ (version ok?) ──execute──▶ removed + tombstone "completed"
                │                   │
                │                   └─ stale ──▶ conflict ──resolve "retry"──▶ queued
                │                                      └──resolve "discard"──▶ removed + tombstone
                └─ transient error ──▶ queued (backoff: 1s, 2s, 4s… capped at 60s)
                └─ permanent error / attempts exhausted ──▶ failed ──retry()──▶ queued
```

- **Sequential FIFO.** Operations are attempted oldest-first. While an
  operation for an entity is conflicted/failed in a pass, later operations for
  the *same* entity are skipped so per-entity ordering is preserved; other
  entities continue.
- **Transient vs permanent.** Anything thrown is retryable by default, with
  exponential backoff (`retryDelayMs`) and a per-operation attempt budget
  (default 5). Throw `PermanentQueueError` (e.g. server-side validation) to
  fail fast without consuming retries.
- **Version source missing.** If `getVersion` returns `null` (record deleted),
  a conflict retry marks the operation `failed` with an explicit message
  instead of looping.

## Durable format and multi-tab convergence

The queue is stored as a single versioned snapshot under
`vaultquest:offline-queue`:

```json
{
  "schema": "vaultquest.offline-queue.v1",
  "revision": 12,
  "operations": [
    {
      "id": "op-…",
      "entityType": "saved_pool",
      "entityId": "pool-1",
      "label": "Increase deposit to 250 XLM",
      "payload": { "amount": 250 },
      "expectedVersion": { "entityId": "pool-1", "entityType": "saved_pool", "version": 5 },
      "status": "queued",
      "attempts": 0,
      "maxAttempts": 5,
      "createdAt": "…",
      "updatedAt": "…",
      "nextAttemptAt": null
    }
  ],
  "tombstones": [{ "id": "op-…", "at": "…", "reason": "discarded" }]
}
```

On every read **and** write the snapshot is merged deterministically:

- operations union by id; the newest `updatedAt` wins (ties by status rank,
  then id),
- `createdAt` and `updatedAt` are strictly monotonic per queue even when the
  clock is coarse, so ordering and conflict resolution never depend on
  timestamp ties,
- a tombstone removes any operation not newer than it, so a discard or
  completion in one tab cannot be resurrected by a stale copy in another.

`mergeQueueSnapshots` is exported and unit-tested directly, so a second tab is
simulated in tests without a browser.

## React integration

```tsx
const queue = useOfflineOperationQueue({
  execute: (op) => api.applyOperation(op),     // throws PermanentQueueError for validation failures
  getVersion: (op) => api.fetchVersion(op),    // null when the record no longer exists
});

queue.enqueue({ entityType: "saved_pool", entityId: op.id, label: "…", payload,
  expectedVersion: currentVersion });
queue.conflicts;      // operations parked on stale state
queue.resolveConflict(id, "retry" | "discard");
queue.retry(id);      // requeue a failed operation with a fresh budget
queue.discard(id);
```

The hook flushes automatically on mount and on the browser `online` event, and
merges cross-tab writes on the `storage` event.

## Operational edge cases

| Edge case | Behavior |
| --- | --- |
| Storage write fails (private mode, quota) | Queue continues in memory; snapshot reports `durable: false`. Queued work does **not** survive a refresh in this state — surface a warning to the user. |
| Corrupt stored snapshot | Parses to an empty queue; individually malformed operations are dropped rather than bricking the queue. |
| Two tabs enqueue different operations | Both survive the merge; either tab can flush them (a flush re-reads storage first). |
| Two tabs queue changes for the same record | The version check catches the second one at flush time; the conflict names expected vs actual version. |
| Operation left `conflict` forever | It stays parked until an explicit `retry`/`discard` — it never auto-applies. `pendingCount` excludes it so UI badges stay honest. |
| Backoff pending but user is online | The next flush skips operations whose `nextAttemptAt` is in the future; `flush({ force: true })` bypasses backoff for an explicit user retry. |

## Failure modes and recovery

- **Conflict on every retry.** Another writer keeps advancing the version.
  Inspect `conflict.expectedVersion` vs `conflict.actualVersion` (and the
  app-wide `ConflictError` message); either discard the queued change or
  re-compose it against the current value and enqueue again.
- **Operation stuck at `failed`.** The `lastError` records the reason. Fix the
  underlying issue (e.g. insufficient balance) and call `retry(id)`; the
  attempt budget resets.
- **Queue lost after refresh.** Only possible when `durable` was `false` or the
  user cleared site data. The UI should warn while `durable` is false; there is
  no server-side copy by design (payloads stay local until executed).
- **Stale tab overwrites a newer tab.** It cannot: writes merge with the
  on-disk snapshot first, and monotonic timestamps guarantee the newer
  operation state wins.

## Rollback

Stop rendering the hook and the queue is inert: nothing runs automatically, and
the stored snapshot is ignored by code that does not construct the engine. To
clear state, delete the `vaultquest:offline-queue` storage key. Operations
already executed are unaffected — the queue only gates what has not run yet.

## Verification

```bash
pnpm exec vitest run tests/offline-operation-queue.test.ts
```
