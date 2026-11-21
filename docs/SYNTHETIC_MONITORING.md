# Synthetic Monitoring for Critical Workflows

`services/syntheticMonitor.ts` runs synthetic probes of the critical vault
workflows (deposit, withdraw, claim, quest completion; see
`createHighValueJourneys`). The HTTP journey monitor in the backend is a
separate component, documented in
[backend/docs/SYNTHETIC_MONITOR.md](../backend/docs/SYNTHETIC_MONITOR.md).

## Paths

| Path | Behaviour |
|---|---|
| Normal | `executeJourney(name, auth)` runs the probe and records `healthy`, or `degraded` above `degradedThresholdMs`. |
| Failure | A throw or a timeout (`timeoutMs`) records `unhealthy`. `alert` fires once `consecutiveFailures` reaches `alertThreshold`. |
| Retry | Up to `maxRetries` attempts with backoff (`retryDelayMs` × `backoffMultiplier`). A later success records `recoveredOnRetry`. |
| Authorization | `requireAuth`, `authorizedRoles`, a journey `authorize` hook and the monitor-wide `globalAuthorizer` are checked for every caller. A denied caller gets an `unhealthy` result with `authorizationDenied: true`. |

## One run per journey at a time (#1128)

A journey never starts a second run while one is in flight. A scheduled tick or
a manual `executeJourney` call that arrives during a run gets that run's result
instead of starting a second synthetic deposit or withdraw. The authorization
check still runs for each caller before this, so a caller who is denied never
receives the in-flight run's result. A run ends at success, failure or
`timeoutMs`; see the timed-out probe edge case below.

## Edge cases

- **A run slower than `intervalMs`.** Ticks that land during the run share it, so
  only one result is recorded for it. The next tick after it ends starts a new run.
- **A timed-out probe.** The run is recorded as failed at `timeoutMs`, but the probe
  function itself is not cancelled. Probes should honour their own timeouts so a
  hung call does not keep a synthetic transaction open.
- **Timers.** The timeout timer is cleared as soon as the probe settles, so a
  finished probe leaves no pending timer behind.
- **A monitor that stopped running.** Results older than `retentionHours` (24 by
  default) are pruned. `getStatus()` then reports `unknown` rather than repeating
  the last status, and `getResults()` returns only results inside the window.

## Recovery

- **A journey stuck `unhealthy`:** fix the dependency, then call
  `executeJourney(name)` once. A success resets `consecutiveFailures` and emits
  `journey_recovered`.
- **A journey reporting `unknown`:** the scheduler is not running or nothing has
  run within `retentionHours`. Call `start()` again, or run `executeAll()`.

## Rollback

All state is in memory (results, failure counters, in-flight runs, timers).
Reverting `services/syntheticMonitor.ts` restores the previous behaviour, with
no stored data or schema to migrate. Calling `stop()` halts scheduled probes
without a deploy.

Tests: `tests/syntheticMonitor.test.ts` (run with `pnpm test`).
