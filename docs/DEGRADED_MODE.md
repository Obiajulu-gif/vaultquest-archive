# User-Safe Degraded Mode for Unavailable Dependencies

## Overview
VaultQuest interacts with critical upstream services including Stellar/Soroban RPC nodes, Postgres databases, Redis caching layers, and asynchronous event indexers. When any of these dependencies experience transient degradation or full outages, the application must not crash or leak raw stack traces, connection strings, or SQL statements to users.

`DegradedModeService` provides a unified failure-detection, mutation-gating, and stale-read-fallback system designed to keep the user experience safe, predictable, and resilient.

---

## Degraded Mode Behavior

### 1. Read Operations (Graceful Degradation)
When dependencies such as Redis or secondary RPC nodes become unavailable:
- Read endpoints fall back to stale cached data or last-known valid snapshots.
- Read responses include explicit degraded metadata:
  ```json
  {
    "data": { ... },
    "degraded": true,
    "stale": true,
    "asOf": "2026-10-16T12:00:00.000Z",
    "warning": "Live updates are delayed due to service degradation; showing cached data."
  }
  ```
- End-users continue to receive read access without disruption or confusing errors.

### 2. Mutation Operations (Fail-Fast Fund Protection)
When critical dependencies (`database`, `soroban_rpc`) fail:
- Financial mutations (deposits, withdrawals, claims, pool adjustments) are strictly gated via `assertMutationAllowed()`.
- Mutation requests fail fast with HTTP 503 `SERVICE_DEGRADED` and a standard `Retry-After: <seconds>` header:
  ```json
  {
    "error": {
      "code": "SERVICE_DEGRADED",
      "category": "dependency",
      "message": "The service is temporarily operating in degraded mode due to unavailable dependencies.",
      "retryable": true,
      "recovery": "Read operations are serving cached data. Mutations will resume once upstream dependencies recover.",
      "status_code": 503
    }
  }
  ```
- This prevents half-executed transactions, dangling on-chain transactions, or inconsistent ledger states.

---

## Failure Detection & Hysteresis

The service maintains state machines for each dependency:
- **`healthy`**: 0 failures, all operations pass.
- **`degraded`**: 1 to $N-1$ failures ($N = \text{failureThreshold}$, default 3).
- **`unavailable`**: $\ge N$ consecutive failures.
- **Recovery Hysteresis**: Requires $M$ consecutive successful probes ($M = \text{recoveryThreshold}$, default 2) to return to `healthy`. This prevents rapid flapping when a remote service is unstable.

---

## Observability & Status Endpoint

Clients and frontend apps can check the global operational status via:
`GET /health/degraded`

Healthy response (HTTP 200):
```json
{
  "data": {
    "status": "healthy",
    "userBanner": null,
    "dependencies": [
      { "name": "database", "status": "healthy", "impact": "Operational" },
      { "name": "soroban_rpc", "status": "healthy", "impact": "Operational" },
      { "name": "redis_cache", "status": "healthy", "impact": "Operational" },
      { "name": "indexer", "status": "healthy", "impact": "Operational" }
    ]
  }
}
```

Degraded / Unavailable response (HTTP 503):
- Includes `Retry-After: 30` header.
- Provides a user-safe banner message ready for UI rendering:
  `"We are currently experiencing upstream service disruptions. Balance mutations and transactions are temporarily paused; cached data may be shown."`
- Never exposes sensitive hostnames, ports, credentials, or internal query parameters.
