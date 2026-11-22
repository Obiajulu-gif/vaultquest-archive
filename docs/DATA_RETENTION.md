# Data Retention Policy

This document defines VaultQuest's data retention and cleanup strategy for audit, telemetry, exports, and support evidence. The policy balances regulatory compliance, operational needs, and data minimization.

## Overview

VaultQuest data is classified into three categories:

1. **Permanent (never deleted)**: Audit, compliance, and financial records required for 7+ years
2. **Operational (cleanup after retention window)**: Transient data with explicit retention periods
3. **Transient (cleanup aggressively)**: Temporary records safe to delete after short windows

Records are protected from deletion if they are:
- Linked to active disputes, investigations, or audits
- Connected to pending financial settlements
- Recently accessed or modified
- Still actively in use

## Data Classification and Retention

### Category 1: Audit & Compliance (7 Years / Never Delete)

These records are **permanently retained** for regulatory compliance and are never candidates for cleanup.

#### ACTION_LEDGER (7 years)
**Description**: Core transaction log of all user actions (deposits, withdrawals, claims)

**Retention**: 2,555 days (7 years) — regulatory minimum for financial services

**Protection rules**:
- Protected if linked to active repair/settlement (e.g., `repair_quarantine.recordId` matches)
- Protected if wallet has activity in last 90 days
- Protected if status is pending/submitted/orphaned (active)

**Why**: Every transaction must be auditable for years; disputes may surface long after execution

---

#### REPAIR_AUDIT (7 years)
**Description**: Immutable audit trail of every reconciliation repair operation

**Retention**: 2,555 days (7 years) — regulatory minimum

**Protection rules**:
- Never deleted; audit compliance requirement

**Why**: Required to prove system integrity and investigation results; cryptographic chain would break if records disappear

---

#### RECORD_CHANGE_HISTORY (7 years)
**Description**: Tamper-evident history of domain record mutations (settlements, repairs, etc.)

**Retention**: 2,555 days (7 years)

**Protection rules**:
- Never deleted; cryptographic chain integrity

**Why**: Chained by hash; deletion breaks the integrity proof

---

#### PROTOCOL_AUDIT (7 years)
**Description**: Parameter changes and governance decisions

**Retention**: 2,555 days (7 years)

**Protection rules**:
- Never deleted; governance record

**Why**: Historical decisions need to be auditable for compliance and future reference

---

#### FEATURE_FLAG_AUDIT (3 years)
**Description**: Runtime configuration changes and feature rollouts

**Retention**: 1,095 days (3 years)

**Protection rules**:
- Protected if modified within last 6 months

**Why**: Helps investigate incidents caused by flag changes; older flags are less relevant

---

#### VAULT_SETTLEMENT (7 years)
**Description**: User prize payouts and settlement records

**Retention**: 2,555 days (7 years) — never deleted

**Protection rules**:
- Never deleted; financial record

**Why**: Critical for financial audit and settlement verification

---

#### REPAIR_PROPOSAL (7 years)
**Description**: Reconciliation repair proposals and approvals

**Retention**: 2,555 days (7 years) — never deleted

**Protection rules**:
- Never deleted; governance record

**Why**: Dual-control decisions must be auditable

---

#### REPAIR_QUARANTINE (7 years)
**Description**: Detected anomalies and drift investigations

**Retention**: 2,555 days (7 years)

**Protection rules**:
- Protected if `resolvedAt` is null (actively being investigated)

**Why**: Unresolved issues may be evidence for disputes

---

#### USER (7 years)
**Description**: User accounts

**Retention**: 2,555 days (7 years) — never deleted

**Protection rules**:
- Never deleted; requires explicit account termination workflow

**Why**: Account data must be retained for compliance; deletion requires user consent

---

### Category 2: Operational Data (1 Year to 90 Days)

These records are cleaned up after their retention window, unless protected by active disputes or settlements.

#### CHAIN_EVENT (1 year)
**Description**: Raw on-chain contract events fetched from Soroban RPC

**Retention**: 365 days (1 year)

**Protection rules**:
- Protected if related action is pending/submitted (not yet confirmed)
- Protected if action created within last 90 days

**Why**: Can be replayed from blockchain if needed; kept 1 year for incident investigation

**Cleanup**: Delete `ingestedAt < cutoff_date` where no linked pending actions

---

#### POISON_EVENT (90 days)
**Description**: Malformed contract events that couldn't be parsed

**Retention**: 90 days

**Protection rules**:
- Protected if `resolvedAt` is null (actively being investigated)

**Why**: May be evidence of contract issues or RPC bugs; old events likely won't recur

**Cleanup**: Delete `detectedAt < cutoff_date AND resolvedAt IS NOT NULL`

---

#### PENDING_EVENT (30 days)
**Description**: Contract events received but not yet consumed/matched to actions

**Retention**: 30 days

**Protection rules**:
- Protected if `consumedAt` is null (still being processed)
- Protected if `receivedAt` is recent (last 7 days)

**Why**: Older unconsumed events are likely orphaned; new events may arrive out of order

**Cleanup**: Delete `receivedAt < cutoff_date AND consumedAt IS NOT NULL`

---

#### BACKGROUND_JOB (90 days)
**Description**: Completed or failed async tasks (draw proofs, notifications, etc.)

**Retention**: 90 days

**Protection rules**:
- Protected if status is queued/in_progress (still running)
- Protected if failed recently with regulatory keywords (e.g., "settlement", "dispute")

**Why**: Completed jobs are safe to delete; failures logged in application; keep 90 days for incident review

**Cleanup**: Delete `updatedAt < cutoff_date AND status IN ('completed', 'failed')`

---

#### WALLET_SESSION (90 days)
**Description**: Authenticated user sessions

**Retention**: 90 days

**Protection rules**:
- Protected if `revokedAt` is null (still active)
- Protected if `expiresAt` is in future (not yet expired)

**Why**: Active/recent sessions needed for user access; old revoked sessions can be purged

**Cleanup**: Delete `createdAt < cutoff_date AND revokedAt IS NOT NULL AND expiresAt < now()`

---

### Category 3: Transient Data (1-7 Days / Cleanup Aggressively)

These records are temporary and safe to delete after short windows.

#### ACTION_LEASE (7 days)
**Description**: Worker coordination leases for action processing

**Retention**: 7 days

**Protection rules**:
- Protected if `expiresAt` is in future (still valid)

**Why**: Expired leases are defunct; valid leases ensure workers don't double-process

**Cleanup**: Delete `expiresAt < now()`

---

#### JOB_LEASE (7 days)
**Description**: Background job coordination leases

**Retention**: 7 days

**Protection rules**:
- Protected if `expiresAt` is in future (still valid)

**Why**: Same as action leases; keeps coordination state from cluttering database

**Cleanup**: Delete `expiresAt < now()`

---

#### WALLET_CHALLENGE (1 day)
**Description**: Authentication challenges (one-time nonces)

**Retention**: 1 day

**Protection rules**:
- Protected if `expiresAt` is in future (still valid)

**Why**: Old challenges are expired/invalid; new challenges generated on demand

**Cleanup**: Delete `expiresAt < cutoff_date`

---

## Cleanup Process

### Automated Cleanup (Weekly)

The `startDataRetentionCron()` job runs **weekly at 04:00 UTC on Sunday** (configurable).

**Process**:
1. Acquire distributed lease (prevents concurrent cleanups across replicas)
2. For each cleanup category:
   - Generate dry-run report (count eligible and protected records)
   - Log findings
   - Execute actual deletion (unless `dryRun=true`)
3. Summarize total records deleted and protected

**Configuration**:
```bash
# Enable data retention cleanup (default)
WORKER_ENABLED=true

# Custom schedule (cron format)
# Default: "0 4 * * 0" (weekly Sunday 04:00)
DATA_RETENTION_SCHEDULE="0 4 * * 0"

# Dry-run mode (test without deleting)
DATA_RETENTION_DRY_RUN=true
```

### Manual Cleanup

Trigger cleanup for a specific category via API or CLI:

```bash
# Dry-run: see what would be deleted
curl -X POST http://localhost:3001/internal/retention/cleanup \
  -H "Authorization: Bearer <INTERNAL_SERVICE_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"category": "CHAIN_EVENT", "dryRun": true}'

# Execute: actually delete
curl -X POST http://localhost:3001/internal/retention/cleanup \
  -H "Authorization: Bearer <INTERNAL_SERVICE_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"category": "CHAIN_EVENT", "dryRun": false}'
```

**Response**:
```json
{
  "timestamp": "2026-09-27T04:00:00Z",
  "category": "Chain Events",
  "table": "chain_events",
  "eligibleForDeletion": 150000,
  "protected": 5000,
  "deleted": 145000,
  "dryRun": false,
  "errors": []
}
```

### Cleanup Report Fields

- **eligibleForDeletion**: Records older than retention window with no active protection
- **protected**: Records that were protected (not deleted) due to active disputes, settlements, or recent activity
- **deleted**: Actual count of records removed (0 in dry-run mode)
- **dryRun**: Whether this was a test run
- **errors**: Any failures encountered during cleanup

## Protection Rules

### Protection Rule Types

#### 1. `linked_dispute`
Record is protected if linked to an active dispute or investigation.

**Examples**:
- Action is referenced by an unresolved `repair_quarantine` record
- Poison event has `resolvedAt = null`
- Pending event is unconsumed

#### 2. `linked_settlement`
Record is protected if connected to a pending financial settlement.

**Examples**:
- Action is linked to an unresolved `vault_settlement`
- Settlement is in "Resolving" state

#### 3. `linked_audit`
Record is protected because it's part of an immutable audit trail.

**Examples**:
- `repair_audit` records (never deleted)
- `record_change_history` (cryptographic chain)
- `protocol_audit` (governance)

#### 4. `active_user`
Record is protected if the user has recent activity.

**Examples**:
- Wallet has a transaction in last 90 days
- Session is not yet expired
- Lease is still valid

#### 5. `recent_transaction`
Record is protected if it's part of a recent transaction.

**Examples**:
- Action created within last 90 days
- Event received within last 7 days

### How Protection Works

During cleanup analysis for each category:

1. Count records older than retention window
2. Subtract records matching any protection rule
3. Report eligible vs. protected
4. Delete only eligible records (in non-dry-run mode)

**Example**:
```
Total CHAIN_EVENT records:        500,000
Records older than 365 days:      450,000

Apply protection rules:
  - Protected (linked to pending actions):  5,000
  - Protected (action < 90 days old):       10,000

Eligible for deletion:             435,000
Actually deleted:                  435,000
Protected records not deleted:     15,000
```

## Special Cases

### Active Disputes

Records are **never deleted** while a dispute is active:

1. **Associated repair_quarantine exists**: `resolvedAt IS NULL`
   - Blocks: action_ledger, chain_event, poison_event
   
2. **Associated repair_proposal exists**: `status IN ('pending', 'in_progress')`
   - Blocks: action_ledger, repair_quarantine

3. **Associated vault_settlement exists**: `state IN ('Pending', 'Resolving')`
   - Blocks: action_ledger (deposit/withdrawal for that vault)

### Regulatory Keywords

Some records are protected if they contain keywords related to compliance:

- "settlement", "dispute", "chargeback", "claim", "appeal"
- "audit", "compliance", "investigation", "violation"
- "error", "inconsistency", "drift", "reconciliation"

These keywords trigger protection for failed background jobs and error records.

## Data Minimization

The policy follows GDPR and similar privacy regulations:

### What We Delete
- Old operational logs (chain events, poison events, background jobs)
- Expired authentication data (challenges, revoked sessions)
- Expired worker leases (no longer needed for coordination)

### What We Keep
- User-initiated transactions (deposits, withdrawals, claims) — audit requirement
- Financial settlements — cannot be undone
- All audit trails — immutable by design
- Active disputes — until resolved

### User-Initiated Deletion

Users can request deletion of their account via `/api/users/:id/delete` (not yet implemented).

When a user deletes their account:
1. Mark `users` row as deleted (`deleted_at` set)
2. Redact sensitive `action_ledger` payloads (amounts, destinations)
3. Retain action records for 7 years (regulatory minimum)
4. Retain any associated settlements indefinitely

Example: User deletes account on 2026-09-27
- Action records stay until 2033-09-27 (7 years)
- Settlement records stay indefinitely
- `action_payload` is redacted (amounts, addresses removed)

## Monitoring and Alerting

### Metrics to Track

- **Cleanup frequency**: Verify weekly job runs successfully
- **Records deleted**: Monitor growth of operational tables
- **Protected records**: Alert if protection count is unusually high (may indicate stuck repairs)
- **Cleanup errors**: Alert on any failures

### Example Prometheus Queries

```promql
# Records deleted per category per week
rate(data_retention_records_deleted_total[1w])

# Protected records (should be small)
data_retention_protected_records

# Cleanup job success rate
rate(data_retention_cleanup_success_total[1w]) / rate(data_retention_cleanup_total[1w])
```

### Alert Rules

```yaml
- alert: DataRetentionCleanupFailed
  expr: rate(data_retention_cleanup_errors_total[1d]) > 0
  annotations:
    summary: "Data retention cleanup failed"
    
- alert: TooManyProtectedRecords
  expr: data_retention_protected_records > 100000
  annotations:
    summary: "Unusually high number of protected records"
    description: "May indicate stuck repairs or active disputes"
```

## Compliance Mapping

### GDPR
- **Right to erasure**: Users can delete accounts (triggers `deleted_at` + redaction)
- **Data minimization**: Operational data deleted after retention window
- **Audit trail**: Action_ledger kept 7 years for accountability

### SOC 2
- **Audit logs**: Repair_audit kept 7 years
- **Change tracking**: Record_change_history kept 7 years (immutable)
- **Retention policy documented**: This document

### Financial Regulations (e.g., FinCEN, OCC)
- **Transaction records**: Kept 7 years (ACTION_LEDGER)
- **Settlement records**: Kept indefinitely (VAULT_SETTLEMENT)
- **Dispute records**: Kept until resolved + 7 years

## Troubleshooting

### "Too many protected records" alert

**Cause**: Cleanup skipped many records due to protection rules

**Diagnosis**:
```sql
-- Find what's being protected
SELECT * FROM repair_quarantine WHERE resolved_at IS NULL LIMIT 5;
SELECT * FROM repair_proposal WHERE status IN ('pending', 'in_progress') LIMIT 5;
SELECT * FROM vault_settlement WHERE state IN ('Pending', 'Resolving') LIMIT 5;
```

**Resolution**:
- Resolve pending repairs via dual-control system
- Settle pending vault settlements
- Close investigations in repair_quarantine

### "Cleanup took longer than expected"

**Cause**: Large deletion on production database may lock tables

**Mitigation**:
- Run cleanup during low-traffic window (default: Sunday 04:00)
- Use `BATCH_SIZE` (not yet implemented) to delete in chunks
- Monitor database locks during cleanup

### "Error: relation 'action_ledger' does not exist"

**Cause**: Migrations not applied

**Resolution**:
```bash
npm run migrate:prod
```

## See Also

- `backend/src/services/dataRetentionService.ts` — Service implementation
- `backend/src/cron.ts` — Cleanup job scheduler
- `backend/tests/dataRetention.spec.ts` — Test coverage
- `docs/RECONCILIATION.md` — Repair and dispute resolution
- `docs/AUDIT_LOGGING.md` — Audit trail requirements (if exists)
