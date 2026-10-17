# Side-effect dispatcher (#923)

The job queue is at-least-once: a retried job, a reclaimed job and a job
requeued from the dead-letter state all run their handler again. That is safe
for idempotent database work. It is not safe for a **user-visible side effect**
(an email, a notification, a webhook call): replaying "notify the winner" twice
sends it twice.

`SideEffectDispatcher` (`src/worker/sideEffectDispatcher.ts`) wraps an effect so
that running it again for the same key does the real work once. A ledger
(`src/worker/effectLedger.ts`, Postgres table `side_effect_ledger`) records
which effects already happened.

## Usage

```ts
const dispatcher = new SideEffectDispatcher({ ledger: new PrismaEffectLedger(prisma), logger });

// Inside a job handler. One job can dispatch several effects; give each its own key.
await dispatcher.dispatch({ key: `email:${job.idempotencyKey}`, type: "email" }, () => sendEmail(...));
await dispatcher.dispatch({ key: `webhook:${job.idempotencyKey}`, type: "webhook" }, () => callWebhook(...));
```

or, for a job that performs exactly one effect:

```ts
handlers["notify.winner"] = sideEffectHandler(dispatcher, { type: "email", run: (job) => sendEmail(job.payload) });
```

Key by `job.idempotencyKey`, not by anything generated per run: it is stable
across retries and dead-letter requeues, so every replay maps to the same
effect. `type` is a short constant (`email`, `webhook`) used for grouping and as
the telemetry `detail`.

## Outcomes

| Result | Meaning | What the job does |
|---|---|---|
| `executed` | This call ran the effect and recorded it | continues |
| `duplicate` | The effect already completed (its stored `result` is returned) | continues, nothing is repeated |
| `in_flight` | Another worker holds a live claim | `sideEffectHandler` throws `SideEffectInFlightError`; the job retries with backoff |

A failing effect records `failed` plus its stable error **code** (never the
message, which may carry wallet addresses or tx hashes), releases the claim and
rethrows the original error. The queue's retry and dead-letter handling is
unchanged.

## Replay and recovery

Requeue a dead job as usual (`POST /internal/jobs/<id>/retry`, see
[BACKGROUND_JOBS.md](BACKGROUND_JOBS.md)). On the re-run, effects that
`completed` come back as `duplicate`; effects that `failed` are re-run. A job
whose email succeeded and whose webhook was down therefore redelivers only the
webhook.

## Observability

- Each dispatch emits one `side_effect.dispatch` operation event and metric
  sample (see [OBSERVABILITY.md](OBSERVABILITY.md)), with the effect type as
  `detail`. `duplicate` and `in_flight` skips count as successes.
- `summarizeEffectLedger(await ledger.list(), { now })` reports counts by status
  and type, `awaitingReplay` (failed effects) and `staleInProgress` (claims past
  their lease). A non-zero `staleInProgress` means a worker crashed or an effect
  is hanging.

## Edge cases

- **Crash between the effect and the ledger write.** If a worker dies after the
  effect succeeded but before it was recorded, the claim expires after `leaseMs`
  (default 5 minutes) and the effect runs again. This window cannot be closed
  from inside the ledger. Where the provider supports idempotency keys, pass the
  effect key through to it.
- **Lost claim.** `complete` and `fail` are fenced by the claiming owner. If the
  lease expired mid-effect and another worker took over, the late worker's
  outcome is discarded and a warning is logged; the new owner's result stands.
- **Lease length.** Set `leaseMs` longer than the slowest legitimate effect.
  Too short and a slow effect is run twice; too long and a crashed worker's
  effect waits that long to be retried.
- **Result size.** The returned value is stored as JSON for `duplicate`
  responses. Return a small identifier, not a payload.
- **Invalid key.** An empty key, an empty type or a key over 200 characters is a
  non-retryable error and dead-letters immediately.
- **No retention yet.** Completed rows are kept. Prune old `completed` rows once
  the longest possible replay window has passed; deleting a row makes a later
  replay of that job repeat the effect.

## Compatibility

Existing handlers, APIs and the job queue are unchanged. No existing side effect
(notification, webhook, email delivery) is routed through the dispatcher by this
change; each call site opts in by wrapping its effect as above.

## Rollout and rollback

Apply migration `20261017000000_add_side_effect_ledger`
(`pnpm --filter backend prisma:deploy`). It only creates a new table. To roll
back, stop using the dispatcher and `DROP TABLE "side_effect_ledger"`; nothing
else references it. After a drop, replaying jobs may repeat effects whose
providers do not deduplicate.

## Tests

[`tests/side-effect-dispatcher.spec.ts`](../tests/side-effect-dispatcher.spec.ts)
covers execute-once, failure and replay, concurrent and in-flight claims, lease
expiry and fencing, the dead-letter requeue scenario end to end through the real
queue and worker, the summary, and `PrismaEffectLedger` against a fake delegate.
