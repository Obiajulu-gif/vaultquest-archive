# Synthetic Journey Monitor

## Overview
The synthetic journey monitor exercises the critical happy path (wallet deposit intent → attach tx → indexer reconciliation → dashboard confirmation) on a schedule or on demand, and reports per-step latency, failures, and which dependency is to blame. It runs through the real HTTP surface via `app.inject`, so middleware (CSRF, rate limiting, validation, error envelope) is part of what is verified.

## Journey Steps
1. **create_intent** - `POST /actions` with idempotency key; creates a pending action.
2. **attach_tx** - `PATCH /actions/:id/submitted` with `tx_hash`; marks action submitted.
3. **indexer_reconcile** - `POST /internal/reconcile` with internal secret; the indexer processes the tx and updates the action status.
4. **dashboard_confirmation** - `GET /dashboard/summary?wallet=...`; the dashboard reflects confirmed status and pending tx hashes.
5. **cleanup** - `DELETE /actions?wallet=...`; privacy-scrub the synthetic wallet's payload.

## Client IP Bucket
The monitor uses its own dedicated rate-limit bucket (`10.255.255.10` by default), so its traffic cannot starve or be starved by user traffic hitting the shared 10 requests/15min sensitive bucket. The recommended minimum schedule is every **5 minutes** (2 POSTs per run → 10 per 15min ≈ 5 runs/15min).

## Failure Classification (`classifyBlame`)
| Status Code | Blame |
|---|---|
| 429 | `rate_limit` |
| 401 | `auth_config` |
| 403 + CSRF error | `middleware_csrf` |
| 403 (other) | `auth_config` |
| Network / timeout | `network` |
| Other | step's default dependency (`ledger_api`, `indexer`, `ledger_read`) |

## Latency Budget
A configurable `latencyBudgetMs` (default 5000). If the total journey duration exceeds this, the run status becomes `degraded` (not `fail`). `budgetExceeded` flag is always present in the result.

## Result Schema
```
{
  run_id: string;
  status: "pass" | "degraded" | "fail";
  wallet: string;               // deterministic Stellar-shaped, unique per runId
  tx_hash: string;
  started_at: string;
  finished_at: string;
  total_duration_ms: number;
  budget_ms: number;
  budget_exceeded: boolean;
  slowest_step: { name, duration_ms } | null;
  steps: JourneyStepResult[];
  blame: string | null;         // first failing step's dependency, null when pass
  summary: string;
}
```

## Entry Points
- `POST /internal/synthetic-monitor/run` - executes one journey now (service-auth protected).
- `GET /internal/synthetic-monitor/status` - returns the last run result (or `{ status: "never_run" }`).
- `pnpm monitor:synthetic` - CLI script that builds the app, runs the journey, prints JSON to stdout. Exit codes: `0` for `pass` and `degraded`, `1` for `fail`, `2` when the run crashes or the runner is not attached to the app.

## Operational Edge Cases and Recovery
- **Degraded is not a failure.** A run over the latency budget exits `0`. Alert on `status === "fail"` or on a non-zero exit code, and track `budget_exceeded` separately.
- **Cleanup always runs.** A failed journey still attempts cleanup for the run's synthetic wallet. If cleanup itself fails, the failure is recorded in `steps` and the original `blame` is kept.
- **Leftover synthetic data.** If cleanup fails and rows remain, the wallet is `syntheticWalletFor(run_id)`, which is deterministic. Repeat the cleanup step by calling `DELETE /actions?wallet=<wallet>`, the same request the monitor's cleanup step sends. Re-running the journey uses a new run id and wallet, so it does not clean up old rows.
- **Status before the first run.** `GET /internal/synthetic-monitor/status` returns `never_run` until a run completes in the current process. The value is in memory, so a restart resets it.
- **Monitor traffic isolation.** The monitor uses its own rate-limit bucket. If it starts returning `429`, check `blame` for `rate_limit` before assuming the journey is broken.
- **Rollback.** The monitor writes only to the synthetic wallet and does not change schema. To stop it, stop calling the CLI and the run endpoint. Reverting the code leaves no migration state to undo.

## Scheduled Runner
Configured via `SYNTHETIC_MONITOR_SCHEDULE` (cron expression, default `*/15 * * * *`). The runner reuses the same `SyntheticMonitorRunner` instance so the `status` field always reflects the most recent run.

## Test Cases (synthetic-monitor.spec.ts)
- Happy path: all steps ok, `status === "pass"`; ledger row reaches `confirmed`; cleanup privacy-scrubs (sets `redactedAt`).
- Failure blame: reconciliation fails → `blame === "indexer"`; dashboard + cleanup steps are `skipped` (after create-intent failure) or run (when preceding steps pass); cleanup still executes on failure.
- Latency budget exceeded → `status === "degraded"`; `budget_exceeded === true`; `blame === null`.
- 429 → `blame === "rate_limit"`; 401 → `blame === "auth_config"`; 403 + CSRF error → `blame === "middleware_csrf"`.
- Network throw → `blame === "network"`.
- Deterministic wallet: `syntheticWalletFor("run-a") === syntheticWalletFor("run-a")`; matches `^G[A-Z2-7]{55}$`.
- Cleanup runs even when earlier steps fail; a cleanup failure is recorded but does not overwrite the original blame.

## Files
- `backend/src/services/syntheticMonitor.ts` - core logic, `SyntheticMonitor`, `SyntheticMonitorRunner`, `createAppJourneyClient`
- `backend/src/routes/monitor.ts` - `POST /internal/synthetic-monitor/run`, `GET /internal/synthetic-monitor/status`
- `backend/scripts/synthetic-monitor.ts` - CLI entry point (`tsx scripts/synthetic-monitor.ts`)
- `backend/src/cron.ts` - `startSyntheticMonitorCron()` factory
- `backend/tests/synthetic-monitor.spec.ts` - integration + unit tests
- `docs/SYNTHETIC_MONITOR.md` - this document