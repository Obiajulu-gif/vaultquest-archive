# Bounded Queue Backpressure

## Overview
VaultQuest background workers execute asynchronous tasks including draw-proof generation, settlement, on-chain reconciliation, indexer backfills, and cache repair. Under high load or during network stalls, background queues could grow unboundedly, leading to memory exhaustion, database connection starvation, and delayed high-priority processing.

The bounded queue backpressure mechanism (`QueueBackpressureManager`) introduces explicit admission control, concurrency throttling, and hysteresis-driven load shedding.

---

## Architecture & Policy

### 1. Queue Depth & Watermark Hysteresis
- **Max Queue Depth (`maxQueueDepth`)**: Configurable threshold (default `500`) of total queued + running jobs. Beyond this, admission throws `QueueBackpressureError` (HTTP 429).
- **High Watermark (`highWatermarkRatio = 0.8`)**: When total depth reaches 80% capacity, backpressure mode engages.
- **Low Watermark (`lowWatermarkRatio = 0.5`)**: Backpressure mode remains active until depth drains to below 50% capacity. This prevents rapid toggling/flapping under bursty traffic.

### 2. Expensive Job Bounded Limit
Jobs classified as resource-expensive (`settlement`, `payout`, `round_close`, `indexer_backfill`, `reconciliation`, `batch_export`, `recheck_orphans`) have a dedicated strict limit (`maxExpensiveDepth = 50`). Even if the general queue has available capacity, expensive jobs are throttled independently to protect RPC and database resources.

### 3. Worker Concurrency & In-Flight Saturation
- **`maxInFlight` (default `25`)**: Limits maximum concurrent executing jobs.
- When running jobs reach capacity, incoming standard-priority jobs receive HTTP 429 with `Retry-After`. High-priority and critical administrative tasks can bypass in-flight limits.

### 4. Load Shedding & Priority Tiers
Incoming enqueue requests specify priority:
- `critical`: Unconditional admission bypass.
- `high`: Admits unless total queue capacity is completely saturated.
- `normal`: Standard backpressure evaluation.
- `low`: Dropped/shed when in backpressure warning mode to protect queue bandwidth.

---

## Error Contract & Client Remediation
When backpressure is asserted, an HTTP 429 `QUEUE_BACKPRESSURE` error is returned:
```json
{
  "error": {
    "code": "QUEUE_BACKPRESSURE",
    "category": "rate_limit",
    "message": "The background job queue is currently under heavy load.",
    "retryable": true,
    "recovery": "Wait a moment (see the Retry-After header) before submitting further background jobs.",
    "status_code": 429,
    "details": {
      "retry_after_ms": 5000,
      "current_depth": 50,
      "max_capacity": 50
    }
  }
}
```
Clients must honor the standard `Retry-After: <seconds>` HTTP header before retrying submission.

---

## Observability & Inspection
Operators can monitor real-time queue pressure via the authenticated endpoint:
`GET /internal/jobs/pressure`

Response:
```json
{
  "data": {
    "enabled": true,
    "metrics": {
      "totalDepth": 42,
      "queuedCount": 35,
      "runningCount": 7,
      "expensiveDepth": 12,
      "maxCapacity": 500,
      "utilization": 0.084,
      "state": "normal",
      "activeShedding": false,
      "admittedTotal": 1420,
      "rejectedTotal": 4,
      "droppedTotal": 1,
      "lastRejectedAt": "2026-10-16T12:00:00.000Z"
    }
  }
}
```
