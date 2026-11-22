# Concurrency Strategy

VaultQuest mutates money, ownership and history records from many
entry points at once: API requests, wallet flows, user dashboards, cron
workers and protocol reporting. This document explains how those
concurrent writes are kept from creating duplicate or inconsistent
records, and which tests prove it.

## Mutation paths and their guards

| Path | Risk | Guard | Test |
| --- | --- | --- | --- |
| Invitation acceptance | The same token accepted twice, granting two roles | State machine with a compare-and-set transition `PARTIAL -> ACCEPTED`; terminal states reject further transitions | `C1`, `C2`, `C3`, `C4` |
| Change history append | Interleaved appends breaking the hash chain or leaving gaps | Append is serialized and validates the previous hash before committing; rejected appends do not advance the chain | `C5`, `C6` |
| Ledger balance updates | Lost updates or negative balances under read-modify-write | Amount arithmetic is immutable and total; debits are guarded by a positive-balance check before application | `C7`, `C8` |
| Job lease acquisition | Two workers running the same cron job | Unique constraint on `job_leases.job_name` plus an expiry-guarded takeover that bumps the fencing token | `C9` |
| Fenced writes after takeover | A worker whose lease expired committing a stale write | `LeaseService.isFencingTokenCurrent` / token in the WHERE clause of the guarded write | `C10` |
| Multi-client saved-pool edits (#983) | Two tabs/devices editing the same saved pool; the later request silently overwriting the other | Per-field clocks + deterministic resolution (`lib/conflict-resolver.ts`), compare-and-set on `saved_pools.version` with re-resolution on a miss | `saved-pools-conflict.spec.ts`, `tests/conflict-resolver.test.ts` |

## Strategy

### 1. Unique constraints are the primary guard

Wherever a record must exist at most once (an invitation acceptance,
a reward grant, a job lease), the database carries a unique
constraint and the application treats the resulting conflict as a
domain error, not a retry. This makes correctness independent of
scheduler timing: even if two requests arrive at the exact same
instant, one insert wins and the other is rejected.

### 2. Compare-and-set transitions for state machines

State transitions are expressed as a conditional update (`UPDATE ...
WHERE status = <expected>`)`). The number of rows affected is the
signal: zero means someone else already moved the record, and the
caller must surface a conflict rather than retrying blindly. This
is the pattern used by invitation acceptance and by the lease
renewal/path.

### 3. Fencing tokens for long-running workers

A cron job can outlive its own lease. To make that safe, every
lease acquisition bumps a `fencingToken`, and every guarded write
checks the token immediately before committing. A worker that
resumes after a GC pause and finds its token stale must abandon the
tick rather than writing.

### 4. Idempotency keys for retries

Retries are unavoidable (network timeouts, crashes, backfills). Every
irreversible record carries a deterministic idempotency key derived
from the logical operation (e.g. `${walletAddress}:${questId}`). A replay
then hits the unique constraint and is a no-op instead of a
second grant.

#### 5. Transactions for cross-table invariants

When two records must agree (a reward grant and the quest row that
justifies it), the writes go in a single transaction. A crash midway
leaves neither write in place, and a retry re-does the same work with
the idempotency key still guarding the grant.

## Test harness

`backend/tests/concurrency-stress.spec.ts` drives the four race
shapes the acceptance criteria require:

- `simultaneous success` — `C1`, `C5`, `C7`, `C9`
- `conflicting requests` — `C2`, `C8`
- `duplicate retries` — `C3`, `C6`
- `timeout behavior` — `C4`, `C10`

The helpers in `backend/tests/helpers/concurrency.ts` provide a
deterministic `Barrier`, a `Latch`, a `DeterministicClock` and a
`runConcurrently` driver, so the interleavings are reproducible and
do not depend on real timers or wall-clock jitter.

## Running the tests

```
cd backend
npm test -- tests/concurrency-stress.spec.ts
```

The suite is pure-in-memory and has no external dependencies, so it
runs identically on a developer machine and in CI.

## When to update this document

Any change that adds a new mutation path, removes a unique constraint,
or changes a transition guard must come with a matching test in
`concurrency-stress.spec.ts` and an update to the table above.
Keep the two in sync.
