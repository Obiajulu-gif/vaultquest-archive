# Dependency Degradation Matrix & Fallback Behavior (#1064)

## Overview
`src/lib/dependency-degradation.mjs` provides a validated dependency matrix and `DegradedModeController` with hysteresis, fail-fast mutation gating, and stale-read fallbacks, aligning with `backend/src/schemas/dependencyMatrix.ts` and `backend/src/services/degradedModeService.ts`.

## Dependency Matrix Summary
| Dependency | Required for Mutations | Required for Reads | Fallback Behavior |
|---|---|---|---|
| `database` | Yes | Yes | Fail-closed 503 (`Retry-After: 30`) for mutations; stale snapshot reads within TTL |
| `soroban_rpc` | Yes | No | Fail-closed 503 for mutations; cached chain state for reads |
| `redis_cache` | No | No | Bypass cache and query primary store directly |
| `indexer` | No | No | Serve last indexed watermark with lag warning |

## Hysteresis & Retry Behavior
- **Failure threshold**: `failureThreshold` (default `3`) consecutive failures transition a dependency from `healthy` → `degraded` → `unavailable`.
- **Recovery threshold**: `recoveryThreshold` (default `2`) consecutive successes are required to restore `unavailable` → `healthy`, preventing flapping.
- **Retries**: Transient (`retryable: true`) errors are retried up to `maxRetries` unless the circuit opens (`unavailable`).

## Authorization & Manual Overrides
- `overrideDependencyState(actor, depName, status, reason)` requires `admin` or `operator` role (or `degradation:override` scope). Unprivileged actors are rejected with `DegradationAuthorizationError` (`DEGRADATION_UNAUTHORIZED`, HTTP 403).
