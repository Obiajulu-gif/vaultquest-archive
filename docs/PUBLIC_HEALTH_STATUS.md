# Dependency-aware public health status (#1164)

`src/lib/public-health-status.mjs` provides a reusable, dependency-aware health
aggregator. It is additive: existing `/health`, `/health/status`, and
`/health/dependencies` routes and their response contracts are unchanged.

## Model

Each component declares `requiredForMutations`, `requiredForReads`, and
`dependsOn`. `registerProbe(name, fn)` attaches an async probe returning either
`"healthy" | "degraded" | "unavailable" | "unconfigured"` or
`{ status, detail?, latencyMs? }`.

`getStatus({ actor, forceRefresh, operationType })` returns:

```
{
  status, checkedAt, operationType,
  components: { [name]: { status, effectiveStatus, requiredForMutations,
                          requiredForReads, dependsOn, latencyMs, detail?, stale?, overridden? } },
  dependencies: [{ name, status, effectiveStatus, ... }],
  blockingDependencies: [name, ...],
  retryAfterSeconds: number | null,
  cached: boolean, cacheExpiresAt: ISO8601
}
```

- **Normal**: all effective statuses healthy → `200`-style `healthy`.
- **Failure**: an unavailable component that is required for the requested
  operation type blocks the aggregate (`status: "unavailable"`,
  `blockingDependencies`, and `retryAfterSeconds`). Non-required failures
  produce `degraded`. `unconfigured` components are reported but excluded from
  the roll-up.
- **Dependency awareness**: a dependent component is degraded when one of its
  dependencies is degraded/unavailable. Dependency links must point to a
  component declared in the same document; missing links are ignored rather
  than crashing the probe.
- **Retry**: each probe is called at most `maxRetries + 1` times. If all
  attempts fail and a fresh last-known-good result exists, the component is
  reported `degraded` with `stale: true`; otherwise it is `unavailable`.
- **Authorization**: public cached reads need no actor. `forceRefresh`,
  `overrideComponentStatus`, and `clearOverride` require `admin`, `operator`,
  or the `health:override` scope, otherwise `PUBLIC_HEALTH_UNAUTHORIZED` (403).

## Edge cases and sanitization

- Raw probe errors (stack traces, connection strings, URLs, tokens) are never
  returned: failures use the dependency's `userSafeMessage`, and operator/
  probe-supplied detail text is passed through `sanitizeHealthDetail()`.
- Probes may supply their own `latencyMs`; otherwise the service measures the
  call. `AbortSignal.timeout` is passed when the runtime supports it.
- Cached snapshots are deep-cloned, so mutating a response cannot corrupt the
  next one. A forced refresh bypasses the cache and re-probes every component.
- Oversized detail strings are truncated; no filesystem, network, or database
  handle is opened by the aggregator itself.

## Recovery and rollback

Operator overrides are reversible policy state only — they never change the
underlying service. `clearOverride(name, actor)` removes the override and
invalidates the cache, so the next request reflects real probe results.
`service.clearCache()` can be used after a deployment or configuration change.
No schema, environment variable, or persisted contract is required.

## Verification

`tests/backend/public-health-status.test.mjs` covers normal aggregation and
caching, failure and secret redaction, dependency propagation, bounded retry,
stale fallback, override rollback, and authorization paths.
