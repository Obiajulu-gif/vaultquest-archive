# Maintainer Dashboard: Operational Health and Unresolved Exceptions

This document describes the operational health monitoring dashboard for VaultQuest maintainers. The dashboard aggregates system-wide health indicators, unresolved failures, stale jobs, reconciliation drift, and user-impacting incidents.

## Overview

The maintainer dashboard provides:
- **Real-time health status**: Overall system state (healthy/warning/critical)
- **10 actionable health categories**: Orphaned actions, stale events, failed jobs, stuck settlements, etc.
- **Investigation links**: SQL queries and log pointers for each issue
- **Drill-down details**: Up to 50 affected records per category for investigation

All data is **server-side only**, protected by service authentication. No user PII is exposed in dashboard summaries unless necessary for diagnosis.

## Health Indicators

The dashboard monitors 10 key operational health categories:

### 1. Orphaned Actions
**What**: Actions submitted to chain but never confirmed (stuck transactions)

**Threshold**:
- 1-10 orphaned actions → **warning**
- >10 → **critical**

**Why it matters**: Users cannot proceed; their deposits/withdrawals are stranded

**Investigation**:
```sql
SELECT id, tx_hash, error_code, updated_at FROM action_ledger 
WHERE status = 'orphaned' 
ORDER BY updated_at DESC LIMIT 20;
```

**Action**: Check Stellar network status, RPC connectivity, or contract state

---

### 2. Stale Pending Events
**What**: Contract events received by indexer but not yet consumed (processing backlog)

**Threshold**:
- 1-50 stale events → **warning**
- >50 → **critical**

**Why it matters**: Users see stale balances; on-chain state and backend diverge

**Investigation**:
```sql
SELECT tx_hash, soroban_event_id, received_at FROM pending_events 
WHERE consumed_at IS NULL 
AND received_at < NOW() - INTERVAL '5 minutes'
ORDER BY received_at ASC LIMIT 20;
```

**Action**: Restart indexer daemon; check Soroban RPC latency

---

### 3. Failed Background Jobs
**What**: Draw proofs, notifications, and other async tasks failed and exhausted retries

**Threshold**:
- 1-5 failed jobs → **warning**
- >5 → **critical**

**Why it matters**: Users don't receive notifications; draw proofs not generated

**Investigation**:
```sql
SELECT id, type, status, attempts, last_error FROM background_jobs 
WHERE status = 'failed' 
ORDER BY updated_at DESC LIMIT 20;
```

**Action**: Review job logs; re-enqueue or fix configuration

---

### 4. Stale Action Leases
**What**: Worker leases expired (worker crashed or is hung)

**Threshold**:
- 1-3 stale leases → **warning**
- >3 → **critical**

**Why it matters**: Actions stuck in worker processing; may never complete

**Investigation**:
```sql
SELECT action_id, worker_id, expires_at FROM action_leases 
WHERE expires_at < NOW() 
ORDER BY expires_at ASC LIMIT 20;
```

**Action**: Restart worker pods; check worker process logs

---

### 5. Unresolved Vault Settlements
**What**: Prize payouts stuck in "Resolving" state for >1 hour

**Threshold**:
- 1-20 → **warning**
- >20 → **critical**

**Why it matters**: Users cannot claim prizes; funds are temporarily inaccessible

**Investigation**:
```sql
SELECT id, vault_id, recipient, amount, updated_at FROM vault_settlements 
WHERE state = 'Resolving' 
AND updated_at < NOW() - INTERVAL '1 hour'
ORDER BY updated_at ASC LIMIT 20;
```

**Action**: Check settlement job status; investigate contract state

---

### 6. Detected Reconciliation Drift
**What**: Action ledger state doesn't match on-chain state (anomalies quarantined)

**Threshold**:
- 1-5 drifts → **warning**
- >5 → **critical**

**Why it matters**: System has detected inconsistencies; data integrity at risk

**Investigation**:
```sql
SELECT id, record_type, record_id, drift_type, detected_at FROM repair_quarantine 
WHERE resolved_at IS NULL 
ORDER BY detected_at ASC LIMIT 20;
```

**Action**: Run reconciliation sweep; apply repair proposals after review

---

### 7. Pending Repair Proposals
**What**: Reconciliation repairs awaiting dual-control approval

**Threshold**:
- Any pending → **warning** (safety control)

**Why it matters**: Repairs are blocked; may be time-critical for user funds

**Investigation**:
```sql
SELECT id, proposer_id, step_count, value_total, created_at FROM repair_proposals 
WHERE status = 'pending' 
ORDER BY created_at ASC LIMIT 20;
```

**Action**: Review repair proposals; approve or reject via dual-control system

---

### 8. Indexer Lag
**What**: Event ingestion behind current network state

**Threshold**:
- 5-20 ledgers behind → **warning**
- >20 → **critical**

**Why it matters**: Dashboard data stale; users see delayed balances

**Investigation**:
```sql
SELECT latest_ledger, last_processed_event_id, last_sync_time 
FROM indexer_checkpoints 
ORDER BY last_sync_time DESC LIMIT 1;
```

**Action**: Check Soroban RPC health; investigate indexer bottlenecks

---

### 9. Poison Events
**What**: Unparseable contract events quarantined (malformed data)

**Threshold**:
- 1-10 → **warning**
- >10 → **critical**

**Why it matters**: May indicate contract deployment issue or RPC data corruption

**Investigation**:
```sql
SELECT id, soroban_event_id, reason, detected_at FROM poison_events 
WHERE resolved_at IS NULL 
ORDER BY detected_at DESC LIMIT 10;
```

**Action**: Review contract code; check RPC event serialization

---

### 10. Stale Orphans (>7 Days)
**What**: Orphaned actions unresolved for more than 7 days (likely permanent failures)

**Threshold**:
- 1-5 → **warning**
- >5 → **critical**

**Why it matters**: Old failures never resolved; user funds may be permanently lost

**Investigation**:
```sql
SELECT id, tx_hash, error_code, updated_at FROM action_ledger 
WHERE status = 'orphaned' 
AND updated_at < NOW() - INTERVAL '7 days'
ORDER BY updated_at ASC LIMIT 20;
```

**Action**: Mark as permanently failed; initiate user refund or investigation

---

## API Endpoints

All endpoints require service authentication via `INTERNAL_SERVICE_SECRET`.

### GET /internal/health/report

Returns comprehensive operational health report.

**Response**:
```json
{
  "timestamp": "2026-09-27T10:30:00Z",
  "overallStatus": "critical",
  "indicators": [
    {
      "category": "Orphaned Actions",
      "status": "critical",
      "count": 15,
      "description": "15 actions stuck in orphaned state...",
      "actionable": "Investigate drift detection and repair...",
      "investigationLink": "SELECT id, tx_hash, error_code... FROM action_ledger WHERE status = 'orphaned'..."
    },
    ...
  ],
  "summary": {
    "totalIssues": 3,
    "criticalCount": 1,
    "warningCount": 2
  }
}
```

**Use case**: Comprehensive dashboard view; background health checks

---

### GET /internal/health/report/summary

Lightweight summary for frequent polling.

**Response**:
```json
{
  "timestamp": "2026-09-27T10:30:00Z",
  "overallStatus": "warning",
  "totalIssues": 2,
  "criticalCount": 0,
  "warningCount": 2
}
```

**Use case**: UI status indicator; polling every 30-60 seconds

---

### GET /internal/health/category/:category

Drill-down into a specific category with up to 50 detailed records.

**Supported categories**:
- `Orphaned Actions`
- `Stale Pending Events`
- `Failed Background Jobs`
- `Unresolved Vault Settlements`
- `Pending Repair Proposals`
- `Poison Events`

**Response**:
```json
{
  "category": "Orphaned Actions",
  "total": 15,
  "items": [
    {
      "id": "action-123",
      "walletAddress": "GBD3...",
      "actionType": "deposit",
      "txHash": "tx-abc123",
      "errorCode": "TIMEOUT",
      "updatedAt": "2026-09-27T09:15:00Z"
    },
    ...
  ]
}
```

**Use case**: Investigation view; detailed record analysis

---

## Usage Workflow

### Daily Health Check

1. **Check summary** (fast):
   ```bash
   curl -H "Authorization: Bearer <INTERNAL_SERVICE_SECRET>" \
     http://localhost:3001/internal/health/report/summary
   ```

2. **Review status**:
   - If `overallStatus` is `critical`, investigate immediately
   - If `warning`, prioritize next
   - If `healthy`, document success

### Investigation Workflow

1. **Fetch full report**:
   ```bash
   curl -H "Authorization: Bearer <INTERNAL_SERVICE_SECRET>" \
     http://localhost:3001/internal/health/report
   ```

2. **Identify top priority issue** (usually the one with highest `status` and `count`)

3. **Drill into category**:
   ```bash
   curl -H "Authorization: Bearer <INTERNAL_SERVICE_SECRET>" \
     http://localhost:3001/internal/health/category/Orphaned%20Actions
   ```

4. **Use investigation link** (SQL query provided in indicator) to diagnose root cause

5. **Take action**:
   - Restart services (worker, indexer)
   - Apply reconciliation repairs
   - Investigate contract state
   - Manual intervention if needed

### Alert Integration

To integrate with PagerDuty, Slack, or other alerting:

1. Poll `/internal/health/report/summary` every 60 seconds
2. Trigger alert if `overallStatus` transitions to `critical`
3. Include URL to drill-down dashboard for investigation

Example Prometheus alert rule:
```yaml
alert: OperationalHealthCritical
expr: operational_health_status == 2  # critical
for: 5m
annotations:
  summary: "VaultQuest health is critical"
  dashboard: "https://maintainer-dashboard.internal/health"
```

---

## Sensitive Data Handling

The dashboard is designed with privacy in mind:

### Included (Necessary for Investigation)
- Wallet addresses (for identifying affected users)
- Transaction hashes (for tracing on-chain activity)
- Error codes (for diagnosis)
- Timestamps (for chronology)

### Excluded (Never Exposed)
- User names or emails
- Action payloads (contain sensitive amounts)
- Private keys or secrets
- Contract bytecode

### Redaction Rules
- All dashboard endpoints require `internal.health.read` permission
- No public API exposes health indicators
- Drill-down records limited to 50 items (no mass export)
- Investigation links are query suggestions; actual execution by maintainer

---

## Configuration

No environment variables required. Health indicators are computed on-demand via database queries.

### Database Requirements
Ensure these tables exist (created by migrations):
- `action_ledger` — core action records
- `pending_events` — contract events
- `background_jobs` — async task queue
- `action_leases` — worker coordination
- `vault_settlements` — prize payouts
- `repair_quarantine` — drift detection
- `repair_proposals` — dual-control repairs
- `indexer_checkpoints` — ingestion progress
- `poison_events` — malformed event log

---

## Performance

Health report generation:
- **Summary**: ~50ms (10 COUNT queries)
- **Full report**: ~100ms (10 COUNT + investigation link assembly)
- **Category drill-down**: ~200ms (1 COUNT + LIMIT 50 query)

Queries use indexed columns (`status`, `expiresAt`, `updatedAt`) for fast scanning.

---

## Troubleshooting

### Dashboard shows all indicators as 0 (healthy) but I know there are issues

**Cause**: Counts are correct; no active issues detected

**Verify**:
```sql
-- Check for any orphaned actions at all
SELECT COUNT(*) FROM action_ledger WHERE status = 'orphaned';

-- Manually query drill-down to see records
SELECT * FROM action_ledger WHERE status = 'orphaned' LIMIT 10;
```

### "Permission denied" when accessing health endpoints

**Cause**: Service authentication failed

**Solution**:
- Verify `INTERNAL_SERVICE_SECRET` is set correctly
- Check request includes header: `Authorization: Bearer <SECRET>`
- Verify secret matches backend configuration

### Indicators show high counts but I can't see details in drill-down

**Cause**: Drill-down limited to 50 items; more records exist

**Verify**:
- Response includes `total` (full count) vs. `items` (returned records)
- Use SQL investigation link to see all records:
  ```sql
  -- Copy the investigationLink query and adjust LIMIT as needed
  SELECT * FROM action_ledger WHERE status = 'orphaned' LIMIT 200;
  ```

---

## Examples

### Example 1: Responding to Critical Orphaned Actions

**Scenario**: Dashboard shows 15 orphaned actions (critical)

**Steps**:
1. Fetch drill-down:
   ```bash
   curl -H "Authorization: Bearer <SECRET>" \
     http://localhost:3001/internal/health/category/Orphaned%20Actions
   ```

2. Review `items` to see which actions and their error codes

3. Check Stellar network status (check if transactions confirmed):
   ```bash
   # For each tx_hash in the results
   curl https://horizon.stellar.org/transactions/<tx_hash>
   ```

4. Decide:
   - If on-chain confirmed but backend missed it → reconcile event
   - If on-chain failed → mark as failed and notify user
   - If still pending → may resolve itself after a few more minutes

---

### Example 2: Investigating Stale Pending Events

**Scenario**: Dashboard shows 75 stale pending events (critical)

**Steps**:
1. Fetch drill-down to see event IDs and receipt times
2. Check indexer health:
   ```bash
   curl -H "Authorization: Bearer <SECRET>" \
     http://localhost:3001/internal/health/report | grep "Indexer Lag"
   ```

3. If indexer is lagged, restart it:
   ```bash
   kubectl rollout restart deployment/indexer-daemon
   ```

4. Monitor progress by polling `/internal/health/report/summary`

---

### Example 3: Approving Reconciliation Repairs

**Scenario**: Dashboard shows 3 pending repair proposals (warning)

**Steps**:
1. Fetch drill-down:
   ```bash
   curl -H "Authorization: Bearer <SECRET>" \
     http://localhost:3001/internal/health/category/Pending%20Repair%20Proposals
   ```

2. Review proposal details (proposer, step count, value affected)

3. Approve high-priority repair via dual-control API:
   ```bash
   POST /internal/reconciliation/proposals/<proposal_id>/approve
   ```

4. Monitor execution; verify drift count decreases

---

## See Also

- `backend/src/services/operationalHealthService.ts` — Service implementation
- `backend/src/routes/operationalHealth.ts` — API routes
- `backend/tests/operationalHealth.spec.ts` — Test coverage
- `docs/RECONCILIATION.md` — Drift detection and repair workflow
- `docs/FEATURE_FLAGS.md` — Feature flag system for emergency rollback
