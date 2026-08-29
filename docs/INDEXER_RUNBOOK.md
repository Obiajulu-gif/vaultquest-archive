# Indexer Operations Runbook

This document details the operational procedures, metrics, alarm thresholds, and manual recovery steps for the VaultQuest Event Indexer.

---

## 1. System Overview

The Event Indexer is a background service that polls the Stellar/Soroban ledger for contract events emitted by VaultQuest pool contracts. These events are parsed and dispatched to the VaultQuest backend via the protected internal reconciliation endpoint (`POST /internal/reconcile`), which resolves transaction statuses in the database. (For background drift detection, automated/dual-controlled repair plans, and quarantine incident response, see [`RECONCILIATION.md`](RECONCILIATION.md)).

To keep track of sync progress and diagnose processing delays, the indexer periodically reports its checkpoint to:
* **Endpoint:** `POST /internal/checkpoint`
* **Authorization:** Secure service-to-service header token (`X-Service-Auth`).

The backend stores this in the `indexer_checkpoints` database table. A public health interface is available at `GET /health/indexer` to calculate sync lag dynamically.

---

## 2. Sync Lag Metrics & Alerts

Sync lag is calculated dynamically by checking the last successful sync time and comparing the current ledger sequence with the indexer's processed sequence.

### Health Status Definitions

| Status | Threshold / Condition | User & Ops Impact | Action Required |
|---|---|---|---|
| **Healthy** | Success sync < 5m ago, zero errors. | Real-time txn updates. | None. Normal operation. |
| **Lagging** | Last successful sync > 5m ago, but no reported hard errors. | Updates delayed by a few minutes. | Low priority. Monitor. |
| **Degraded** | Hard error reported (`last_error` is not null) or sync lag exceeds critical limits. | User-facing deposits/claims block. | Immediate investigation required. |

### Alarm Thresholds

* **Warning (Soft Lag):** Sync lag sequence > 100 ledgers (~8.3 minutes on Stellar).
* **Critical (Hard Lag):** Sync lag sequence > 500 ledgers (~41.6 minutes) OR `status == "degraded"` (persistent error reported).

---

## 3. Stale Orphan Alert

### What triggers it

The background reconciliation engine (`reconciler.ts`) flags actions stuck in `orphaned` status for more than **7 days** as `stale_orphan` drifts. Each detected drift emits a structured log line (`event: "reconciliation.stale_orphan"`) and updates two Prometheus metrics (see `backend/PROMETHEUS_SETUP.md`):

* `stale_orphans_current{bucket="7d"|"30d"}` — current count per age bucket, as of the last reconciliation run.
* `stale_orphans_total{bucket=...}` — cumulative drifts produced.

| Alert | Condition | Severity |
|---|---|---|
| `StaleOrphansPresent` | `stale_orphans_current{bucket="7d"} > 0` for 30m | Warning |
| `StaleOrphansEscalated` | `stale_orphans_current{bucket="30d"} > 0` for 10m | Page (operator intervention) |

### Recommended response

1. **Confirm the drift.** Query the log for the offending `recordId`/`txHash`:
   ```bash
   kubectl logs -l app=vaultquest-backend | grep stale_orphan
   ```
2. **Investigate the orphaned action.** The action is a deposit/withdraw whose on-chain evidence never resolved. Check the tx on Stellar Expert / Horizon using the `txHash` from the log line.
3. **Resolve or quarantine.** If the chain evidence exists but the DB row is stale, reconcile the action status manually (`POST /internal/reconcile` or the reconciliation admin route). If the action is unrecoverable, quarantine it (see `RECONCILIATION.md`) so it stops re-appearing in every run.
4. **Escalated (30d+) orphans** indicate a systemic gap (e.g. indexer down, RPC outages, fee-bump exhaustion) — treat as an incident and check the indexer health endpoint (`/health/indexer`) and sync-lag section above before resolving individual rows.
5. **Confirm recovery.** After resolution, the next reconciliation run should drop `stale_orphans_current` to `0` for that bucket.

---

## 4. Troubleshooting & Recovery Procedures

If the indexer reports a `lagging` or `degraded` state, follow these diagnostic steps sequentially:

### Step A: Inspect the Indexer Health Status
Run a query against the health endpoint to gather current statistics:
```bash
curl -X GET https://api.vaultquest.io/health/indexer
```
Example Degraded Output:
```json
{
  "data": {
    "status": "degraded",
    "latest_ledger": 1492023,
    "last_sync_time": "2026-05-30T03:00:00.000Z",
    "last_success_sync_time": "2026-05-30T02:45:00.000Z",
    "last_error": "Horizon RPC rate limit exceeded (HTTP 429)",
    "sync_lag": 180,
    "message": "Indexer reported error: Horizon RPC rate limit exceeded (HTTP 429)"
  }
}
```

### Step B: Common Failure Modes & Solutions

#### 1. Horizon RPC Rate Limiting (429)
* **Diagnosis:** `last_error` contains `rate limit` or `429`.
* **Resolution:** 
  1. Inspect the Horizon API keys or RPC endpoint settings in the indexer environment (`.env`).
  2. If using a public RPC node, switch to a dedicated premium node provider.
  3. Adjust the indexer polling delay configuration to reduce request frequencies.

#### 2. Re-entrancy or Out-of-Sequence Event Parse Failures
* **Diagnosis:** Indexer fails repeatedly on a specific ledger block due to bad payload serialization.
* **Resolution:**
  1. Note the ledger number (`latest_ledger`) where the indexer is stuck.
  2. Inspect the indexer container logs for parsing errors.
  3. If safe, perform a manual skip or rewind by updating the checkpoint sequence (see Manual Ledger Rewind below).

#### 3. Database Connection Pool Exhaustion
* **Diagnosis:** Indexer logs show `PrismaClientInitializationError: Can't reach database`.
* **Resolution:**
  1. Check database server load and active connection count.
  2. Increase connection pool size parameters in `DATABASE_URL` (e.g., `&connection_limit=20`).
  3. Restart the backend Fastify server to clear stale connections.

---

## 5. Operational Commands (Manual Interventions)

### View Current Checkpoint in Database
Connect to the database via `psql` or Prisma Studio and query the database directly:
```sql
SELECT * FROM indexer_checkpoints WHERE id = 'singleton';
```

### Manual Ledger Rewind / Reset
If the indexer needs to re-process transactions from a past block due to missing/dropped events or database state sync issues:

1. Pause the event indexer service process.
2. Update the `latest_ledger` to the desired past block sequence:
   ```sql
   UPDATE indexer_checkpoints
   SET latest_ledger = 1490000, 
       last_error = NULL, 
       last_success_sync_time = NOW()
   WHERE id = 'singleton';
   ```
3. Restart the event indexer service. It will resume processing events starting from ledger `1490001`.

---

## 6. Security & Access Control

* The `/internal/checkpoint` and `/internal/reconcile` routes MUST always be guarded by a secure service auth key.
* Ensure that the `X-Service-Auth` token configured in the indexer matches `INTERNAL_SECRET` in the backend environment. Never expose this key in client-side bundles.
