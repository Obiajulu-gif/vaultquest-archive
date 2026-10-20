# Observability: operation telemetry

Every core domain operation reports **one structured log event and one
Prometheus sample** through `src/services/telemetry.ts`. This is how you see
where users fail, where latency spikes, and which operations are unhealthy.

## Instrumented operations

| `operation` | Where | `actor_type` |
|---|---|---|
| `action.create` | `LedgerService.createAction` | `user` |
| `action.attach_tx` | `LedgerService.attachTxHash` | `service` |
| `action.cancel` | `LedgerService.cancelAction` | `user` |
| `action.reconcile_event` | `LedgerService.reconcileEvent` | `system` |
| `wallet.verify_challenge` | `WalletAuthService.verifyChallenge` | `user` |
| `settlement.settle_vault` | `EscrowService.settleVault` | `service` |
| `draw_proof.generate` | `DrawProofService.generateProof` | `worker` |
| `side_effect.dispatch` (`detail` = effect type) | `SideEffectDispatcher.dispatch`; one event per effect, a `duplicate` or `in_flight` skip counts as success | `worker` |
| `worker.job` (`detail` = job type or cron job name) | background jobs and every cron job (indexer, reconciler, quests, backups, …) | `worker` |

HTTP-level latency and status are covered separately by
`http_request_duration_seconds` / `http_requests_total`, and each request logs
`request_incoming` / `request_completed` with `correlation_id`.

New operations must be added to `OPERATIONS` in `telemetry.ts`; the list keeps
metric label cardinality bounded.

## Log event

Emitted at `info` on success and `warn` on failure, with exactly these fields:

```json
{
  "event": "operation",
  "operation": "action.cancel",
  "actor_type": "user",
  "result": "failure",
  "latency_ms": 12.4,
  "correlation_id": "4f0c…",
  "error_code": "NOT_FOUND",
  "error_category": "not_found"
}
```

| Field | Notes |
|---|---|
| `operation` | From the table above. |
| `actor_type` | `user`, `service`, `system` or `worker`. |
| `result` | `success` or `failure`. |
| `latency_ms` | Wall-clock time, 2 decimal places. |
| `correlation_id` | The request's `Correlation-Id`, carried through async calls automatically; `null` outside a request (e.g. cron). Jobs carry the id of the request that enqueued them. |
| `error_code`, `error_category` | Failures only; the stable code from the [error taxonomy](../../docs/API.md#standard-errors), or `INTERNAL`. |
| `detail` | Optional low-cardinality qualifier such as the job type. |

### Sensitive values

Telemetry accepts only the allow-listed fields above. Wallet addresses, tx
hashes, payloads and error **messages** are never recorded: failures are
reduced to their stable code. This is asserted in `tests/telemetry.spec.ts`.

## Metrics

| Metric | Type | Labels |
|---|---|---|
| `vaultquest_operations_total` | counter | `operation`, `actor_type`, `result` |
| `vaultquest_operation_duration_seconds` | histogram | `operation`, `actor_type`, `result` |
| `vaultquest_operation_failures_total` | counter | `operation`, `error_code` |

Scraped from `GET /metrics` (see `PROMETHEUS_SETUP.md`).

## High-cardinality protection (#925)

Request-derived labels and log lines are bounded in
`src/services/telemetryGuard.ts`, so abusive input cannot create unbounded
time series or flood the log. Every guard fails closed to a fixed placeholder
and never echoes the offending text.

| Protection | Behaviour |
|---|---|
| Label sanitizing | Only `A-Z a-z 0-9 _ . : / * -` is accepted, capped at 64 characters. Anything else becomes `invalid`; a value containing a wallet address or a 64-hex transaction hash becomes `redacted`. |
| Distinct-value budget | At most 100 distinct values per guarded label (`http` `route`; `operation` `operation`, `actor_type`, `error_code`). Later new values collapse into `other`; values already admitted keep their own series. |
| HTTP route label | The matched route pattern (`/api/actions/:id`), or `unmatched`, never the raw URL or query string. |
| HTTP method label | Standard methods only; anything else is `OTHER`. |
| Failure log sampling | The first 10 failure lines per (operation, error code) per minute are logged. The next line that gets through carries `suppressed_since_last_log`. Success lines are never sampled. |

Metrics and `subscribeTelemetry` listeners still see every event; only log
lines are sampled. `getPrometheusMetrics().getLabelCardinalityReport()` returns
distinct, overflowed and rejected counts per guarded label.

Operational notes:

- **A sustained `other` series is the abuse signal.** A rising `other` route or
  `error_code` means new values are being refused. Check the report for which
  label is overflowing, then look at the raw access log.
- **Legitimate growth looks the same.** If real routes or error codes exceed 100,
  raise `DEFAULT_MAX_VALUES_PER_LABEL` deliberately rather than letting the
  series grow.
- **Budgets and sampler windows reset on restart.** Each process enforces its own
  limits, so the cap applies per replica.
- **Rollback:** the change only narrows labels. Reverting `telemetryGuard.ts` and
  the three call sites restores the previous labels; existing dashboards keyed
  on raw URL routes will need the pattern form (`/api/actions/:id`) after the
  upgrade.

## Dashboard queries (PromQL)

Failure rate per operation (5m):

```promql
sum by (operation) (rate(vaultquest_operations_total{result="failure"}[5m]))
  / sum by (operation) (rate(vaultquest_operations_total[5m]))
```

p95 latency per operation:

```promql
histogram_quantile(0.95,
  sum by (operation, le) (rate(vaultquest_operation_duration_seconds_bucket[5m])))
```

Top failure causes:

```promql
topk(10, sum by (operation, error_code) (increase(vaultquest_operation_failures_total[1h])))
```

Conversion funnel (created → confirmed): `action.create` successes versus
`action.reconcile_event` successes over the same window:

```promql
sum(increase(vaultquest_operations_total{operation="action.reconcile_event",result="success"}[1d]))
  / sum(increase(vaultquest_operations_total{operation="action.create",result="success"}[1d]))
```

Unhealthy background jobs:

```promql
sum by (operation) (increase(vaultquest_operations_total{operation="worker.job",result="failure"}[15m])) > 0
```

## Log queries (JSON logs)

Everything that happened to one support case: filter on the `error_id` a user
quotes, which is the request's `correlation_id`:

```
correlation_id = "<error_id>"
```

Slow or failing operations: `event = "operation" AND (result = "failure" OR latency_ms > 1000)`.

## Operational health report

Maintainers need a concise view of **actionable failures that are still open**.,
not just a firehose of every event. The health report groups unresolved work into
categories with a severity level, aggregates recent trends, and attaches the
identifiers (stable error code, operation, correlation id) an investigator needs.

### Health categories

| Category | Source | What it means |
|---|---|---|
| `unresolved_failure` | `vaultquest_operation_failures_total` with no later success for the same operation within the window | An operation failed and was not retried to success. |
| `stuck_job` | `vaultquest_operations_total{operation="worker.job"}` with no completion in the expected interval | A background job has not reported success within its cadence. |
| `stale_record` | actions past their reconcilation deadline with no `action.reconcile_event` success | A ledger record is unresolved and needs manual intervention. |
| `user_impacting` | failures with `actor_type="user"` | A user-facing flow (wallet verification, action create/cancel) failed. |

### Severity levels

| Severity | Trigger |
|---|---|
| `critical` | `user_impacting` failures with a rising trend, correlation id present. |
| `high` | `stuck_job` or `stale_record` aged beyond the deadline. |
| `medium` | `unresolved_failure` with a flat or falling trend. |
| `low` | `unresolved_failure` with no user impact and no recent occurrence. |

### Report shape

The report is produced by `services/healthReport.ts` from the current telemetry
snapshot and the ledger records. It returns one entry per category with counts,
trend direction, and the identifiers needed to investigate:

```json
{
  "generated_at": "2024-06-01T12:00:00.000Z",
  "window": "1h",
  "categories": [
    {
      "category": "user_impacting",
      "severity": "critical",
      "count": 3,
      "trend": "rising",
      "operations": ["action.create"],
      "error_codes": ["NOT_FOUND"],
      "correlation_ids": ["4f0c…"]
    }
  ]
}
```

### Redaction

The report inherits the telemetry allow-list: it never includes wallet addresses,
tx hashes, payloads, or error messages. Only stable error codes, operation names,
and correlation ids are reported. This is asserted in
tests/healthReport.spec.ts against the fixtures.

## Validation

`pnpm --filter backend exec vitest run tests/telemetry.spec.ts` checks that at
least five core operations emit every required field on success and failure,
that no wallet address or tx hash appears in events, and that the Prometheus
series are populated.

`pnpm --filter backend exec vitest run tests/healthReport.spec.ts` checks that the
health report counts match the underlying fixture records, classifies failures into
actionable categories with severity levels, and redacts sensitive details.
