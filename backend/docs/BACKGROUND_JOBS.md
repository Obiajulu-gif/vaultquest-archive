# Background jobs

Delayed and retryable work runs on a small durable job queue instead of inside
request handlers. Today one operation uses it: **draw-proof generation** after
a `select_winner` action is confirmed (previously a fire-and-forget promise
whose failures were only logged).

## Model

A job is a row in `background_jobs`:

| Field | Meaning |
|---|---|
| `type` | Handler name, e.g. `draw_proof.generate`. |
| `payload` | JSON input, validated by the handler. |
| `idempotency_key` | Unique. Enqueueing the same key twice yields one job (`draw_proof.generate:<actionId>`). |
| `status` | `queued` → `running` → `succeeded`, or `dead` (dead-letter). |
| `attempts` / `max_attempts` | Attempts are counted when a job is claimed. Default max is 5. |
| `run_at` | Earliest run time; doubles as the retry schedule. |
| `correlation_id` | Ties the job back to the originating request. |
| `last_error`, `failures` | Every failed attempt: `{ attempt, at, code, message, retryable }`. Messages are length-limited and wallet addresses / tx hashes are redacted. |

Delivery is **at-least-once**, so handlers must be idempotent. The draw-proof
handler is: it checks for an existing proof before inserting.

## Retry policy

* Exponential backoff: `base 1s × 2^(attempt-1)`, capped at 5 minutes, with
  jitter in the 50–100% range (`src/worker/retryPolicy.ts`).
* Retried until `max_attempts`, then the job becomes `dead`.
* **Not retried** (dead immediately): `NonRetryableJobError`, an unknown job
  type, an invalid payload, or an `AppError` whose taxonomy entry is
  `retryable: false`.

## Dead-letter behaviour

A dead job stays in the table with its payload, correlation id and full
failure history, and is never picked up again automatically. After fixing the
cause, requeue it with a fresh attempt budget:

```bash
curl -s -H "x-internal-secret: $INTERNAL_SERVICE_SECRET" \
  "http://localhost:3001/internal/jobs?status=dead"
curl -s -X POST -H "x-internal-secret: $INTERNAL_SERVICE_SECRET" \
  "http://localhost:3001/internal/jobs/<id>/retry"
```

Endpoints are documented in [`docs/API.md`](../../docs/API.md#internal-background-jobs).

## Crash safety

A worker claims a job by compare-and-swap and stamps `locked_by` / `locked_at`.
If it dies mid-run, the job is reclaimed once `locked_at` is older than the
visibility timeout (5 minutes) and runs again. Results are **fenced** by
`locked_by`: a worker that lost its lock cannot mark the job succeeded or
failed, so it cannot overwrite the new owner's outcome.

## Running workers locally

The worker runs inside the API process.

```bash
pnpm --filter backend db:setup          # applies the background_jobs migration
pnpm --filter backend dev               # API + worker
```

| Variable | Default | Effect |
|---|---|---|
| `WORKER_ENABLED` | `true` | `false` makes this instance enqueue-only (jobs are processed by other replicas). |
| `WORKER_POLL_INTERVAL_MS` | `2000` | How often to poll for due jobs. |

Watch it work: log lines `job succeeded`, `job failed; will retry`, and
`job moved to dead-letter` carry `job_id`, `job_type`, and `correlation_id`;
`worker.job` telemetry is described in [`OBSERVABILITY.md`](./OBSERVABILITY.md).

To process one batch from a script or test without timers:

```ts
const worker = new JobWorker({ queue, handlers });
await worker.runOnce(); // { claimed, succeeded, retried, dead }
```

## Adding a job type

1. Add a handler in `src/worker/handlers.ts`, validate the payload with zod,
   throw `NonRetryableJobError` for bad input, and make it idempotent.
2. Enqueue with a deterministic `idempotencyKey`:
   `queue.enqueue({ type, payload, idempotencyKey })`.
3. Add tests using `InMemoryJobStore` (see `tests/worker.spec.ts`).

## Deployment

Apply migration `20260926000000_add_background_jobs` before rolling out
(`pnpm --filter backend prisma:deploy`). It only creates a new table. With
`WORKER_ENABLED=false` on every instance, jobs queue up but nothing runs them.
