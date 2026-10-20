# Runbook: Retention cleanup preview

Before any retention cleanup **deletes, archives, or redacts** records, run it in
**preview mode** and review the output. Preview is deterministic and performs no
destructive change — it classifies each candidate record and explains why.

See also [`DATA_RETENTION.md`](../DATA_RETENTION.md) for the retention policies
themselves.

## What preview does

`DataRetentionService.previewCleanup(categoryKey, opts?)` classifies every
candidate record for one retention category into exactly one outcome:

| Outcome | Meaning | Deleted on apply? |
|---|---|---|
| `eligible` | Past the retention window, unprotected, not held | **Yes** |
| `skipped` | Retained by a policy protection rule (active/recent/unresolved/still-running/still-valid) | No |
| `held` | Under an explicit hold (legal hold, open dispute, audit freeze) | **Never** |
| `failed` | Classification raised an error — retained to be safe | **Never** |

`counts.eligible + counts.skipped + counts.held + counts.failed` always equals
`records.length`. Every record carries a human-readable `reason`.

Only categories with an operational cleanup path can be previewed
(`CHAIN_EVENT`, `POISON_EVENT`, `PENDING_EVENT`, `BACKGROUND_JOB`,
`WALLET_CHALLENGE`, `WALLET_SESSION`, `ACTION_LEASE`, `JOB_LEASE`). Permanently
retained categories (audits, users, settlements, the action ledger) throw
`"… not subject to cleanup preview"`.

## How to review the output

```ts
const preview = await retention.previewCleanup("BACKGROUND_JOB", {
  holds,                 // optional RetentionHoldProvider (see below)
  limit: 1000,           // max candidates classified per call
  actor: "ops@vaultquest",
});
```

1. **Confirm `mode` is `"preview"` and `applied` is `0`.** Preview never
   deletes; if `applied > 0` you were in apply mode.
2. **Read `counts`.** A sudden jump in `eligible`, or `skipped`/`held` dropping
   to zero, means a policy or hold source changed — investigate before applying.
3. **Spot-check `records[].reason`.** Every `skipped`/`held` record says why it
   was retained; every `eligible` record says why it qualifies.
4. **Investigate `failed` and `errors`.** A `failed` record could not be
   classified (e.g. the hold source was unreachable) and is retained, never
   deleted. Resolve the cause and re-run before applying.
5. **Apply only after review:** re-run with `{ apply: true }`. Apply deletes
   **only** the `eligible` set (by primary key); `skipped`, `held`, and `failed`
   records are never touched. `applied` reports how many rows were deleted.

## Explicit holds

Legal holds / open disputes / audit freezes are supplied through a
`RetentionHoldProvider` — kept outside this service so holds can live in a table,
config, or an external system without a schema migration here:

```ts
const holds: RetentionHoldProvider = {
  heldReason(table, recordId) {
    // return a human reason to hold this record, or null to let policy decide
    return legalHolds.reasonFor(table, recordId) ?? null;
  },
};
```

A held record is reported as `held` with that reason and is never deleted, even
in apply mode.

## Every-run checklist

- [ ] Ran preview first; `mode === "preview"`, `applied === 0`.
- [ ] `counts` look sane vs. the last run; no unexpected spike in `eligible`.
- [ ] No `failed` records / `errors` (or their cause is understood and accepted).
- [ ] Held records are the expected ones (holds source is up).
- [ ] Applied with `{ apply: true }` only after the above; `applied` matches the
      reviewed `eligible` count.
