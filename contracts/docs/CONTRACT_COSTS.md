# Drip Pool — Cost Profile (#27)

Tracking doc for the optimization pass called for by issue #27.
Numbers below are recorded by `scripts/measure_costs.sh` (which invokes
`cargo test` with Soroban's `cost_estimate` reporting); see the script
for the exact invocation and parser.

## How to update this doc

```
cd contracts/
./scripts/measure_costs.sh > /tmp/costs.txt
# Compare /tmp/costs.txt against the table below; update if the delta
# is meaningful (≥ 5% on any metric) and explain the cause in
# "Recent changes" at the bottom.
```

## Baseline (`drip-pool` scaffold)

| Operation | CPU instructions | Storage writes | Storage reads | Notes |
|---|---:|---:|---:|---|
| `create(admin)` | TBD | 2 instance keys | 0 | Single instance write per pool. |
| `join(who)` | TBD | 1 persistent key | 1 | Per-participant key. |
| `drip(who, amount)` | TBD | 2 (participant + pool) | 2 | Hot path — primary optimization target. |
| `claim(who)` | TBD | 1 persistent key | 1 | Resets `claimable` to 0. |
| `withdraw(who)` | TBD | 1 delete | 1 | Frees rent on persistent key. |

Numbers replaced as the real implementation lands and
`scripts/measure_costs.sh` produces non-TBD output.

## Storage layout — known optimization opportunities

These are the levers the optimization pass should evaluate against
realistic pool sizes (see "Representative scenarios" below). Each is
listed with the trade-off the maintainer should weigh:

- **Pack `Pool` and per-participant counters into a single instance
  storage entry.** Cheaper writes; constrains the pool size to whatever
  fits under the entry size limit.
- **Switch `Participant.claimable` to `i64`.** Half the bytes per write,
  caps the per-participant claimable balance at ~9.2e18 stroops (still
  far above any realistic TrustQuest amount).
- **Use temporary storage for the hot per-participant `drip` increment
  and flush to persistent storage on `claim`.** Dramatically lower rent
  for active pools; adds a recovery path for participants who never
  call `claim` before the temporary entry expires.
- **Emit a single batched `pool_drip_summary` event per ledger instead
  of one event per `drip` call.** Cheaper in event payload bytes;
  requires the indexer (#13) to fan-out per-participant.
- **Drop the `created_at` field from `Pool`.** The ledger sequence + the
  initialising tx already pin the creation time; saves one `u64` per
  pool.

## Representative scenarios for the optimization pass

The cost numbers above are meaningless without realistic load. The
optimization pass should report deltas against these three scenarios:

1. **Small pool** — 1 admin, 5 participants, 10 drips per participant.
   Smoke-test for the API and the worst-case rent on instance storage.
2. **Mid pool** — 1 admin, 50 participants, 100 drips per participant.
   The expected steady-state for an active TrustQuest round.
3. **Wide pool** — 1 admin, 500 participants, 5 drips per participant.
   Stresses the per-participant storage layout.

Each scenario is parameterised in `tests/scenarios.rs` (TODO file —
introduced when the optimization pass starts) and run by
`scripts/measure_costs.sh`.

## Safety invariants the pass must not weaken

The optimization pass must keep these unchanged:

- A participant who has not joined cannot drip or claim.
- Double-join is rejected.
- `drip` requires a positive amount and is bounded by `i128`.
- `claim` is idempotent — second call returns 0 without erroring.

`drip-pool/src/test.rs` covers each of these. Any optimization PR must
re-run the full harness without skipped or modified assertions.

## Recent changes

| Date (UTC) | PR | Operation | Delta | Cause |
|---|---|---|---|---|
| 2026-04-26 | this PR | scaffold | n/a | Establishes baseline; no real numbers yet. |
| 2026-08-29 | #558 | `prune_round` | +1 new error variant, ~50 LOC | Adds admin entrypoint to remove `RoundDeposit` entries and `Round` storage for fully settled rounds, preventing unbounded persistent storage growth across many rounds. |

