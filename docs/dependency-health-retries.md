# Dependency-aware health probe retries (#1164)

The existing `GET /health/status` response and its healthy/degraded/unavailable contract remain unchanged. Each configured dependency probe now retries transient thrown failures before it is classified as unavailable.

## Retry policy

- Default: one retry (two total attempts).
- Deployments may configure `retries` from zero through three, `retryDelayMs`, and an injectable sleep function for deterministic tests.
- A failed probe retries independently; one dependency's retry does not block the other probes.
- RPC endpoints continue to be checked as a bounded failover set. A partial endpoint outage remains degraded if at least one endpoint is healthy.
- Invalid configuration remains misconfigured and is never returned with raw endpoint details.

## Recovery and rollback

A successful retry returns the dependency to healthy for that check. Exhausting the retry budget preserves the existing unavailable/degraded roll-up and safe remediation message. The retry count can be set to zero to restore single-attempt behavior; no schema or response migration is required.

## Authorization

The public status endpoint remains public and contains only its existing sanitized status contract. Internal credentials and raw probe errors are not added to responses.

## Verification

Run `pnpm --filter backend exec vitest run tests/healthStatus.spec.ts`. Tests cover transient recovery, exhausted retries, and redaction of failure details.
