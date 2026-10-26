# Operational Metadata Retention, Deletion, and Recovery

This document outlines the retention schedules, deletion procedures, failure modes, retry mechanics, and rollback behaviors for operational metadata within VaultQuest.

---

## 1. Scope & Categorization

Operational metadata includes:
- **Telemetry & Server Logs**: Request timings, route diagnostics, IP addresses, status codes.
- **Error Reports & Traces**: Stack traces, payload snapshots captured during failed actions.
- **Analytics & Cache Data**: Temporary session metrics, uncommitted state projections.
- **Audit Trails**: Signer authorizations, configuration adjustments, reconciliation outcomes.

### Retention Schedule

| Data Category | Retention Limit | Primary Action Upon Expiry | Exemption / Protection Rule |
| :--- | :--- | :--- | :--- |
| **Transient Tokens & Challenges** | 1 day | Hard Delete | Protected if active / unexpired |
| **Operational Coordination Leases** | 7 days | Hard Delete | Protected while valid lease lock is held |
| **Telemetry & Server Logs** | 14 - 30 days | Anonymize / Hard Delete | None |
| **Error Traces** | 30 - 90 days | Truncate / Expire | Retain if linked to open dispute |
| **Audit Trails** | 2555 days (7 yrs)| Immutable Retention | Regulatory hold, dispute settlement |

---

## 2. Operational Procedures

### Deletion & Retention Review Execution

Retention cleanup is managed via policy rules in `lib/dataMinimization.ts` and `DataRetentionService`:
1. **Classification & Review**: Candidate metadata records are scanned against active `MinimizationPolicy`.
2. **Preview Mode**: Runs dry-run analysis to preview counts of eligible vs protected records.
3. **Execution Mode**: Executes targeted batch deletions of eligible records.
4. **Audit Trail**: Logs maintainer actor identity, deleted record count, and execution errors.

---

## 3. Operational Edge Cases & Failure Modes

### 1. Mid-Execution Database / Connection Failures
- **Symptom**: Network disconnection or database query timeout midway through pruning operational metadata.
- **Behavior**: The retention task catches the database error, halts subsequent deletions in the batch, records the failure detail in the cleanup report, and exits without leaving corrupted pointer states.
- **Mitigation & Recovery**: Safe to re-run immediately. All retention deletions are idempotent (`deleteMany` scoped strictly by cutoff timestamps and IDs).

### 2. Forbidden Field Ingestion
- **Symptom**: Accidental logging of secrets or credentials (e.g., `privateKey`, `seedPhrase`, `password`) into operational telemetry.
- **Behavior**: Minimization policy immediately flags fields for hard deletion (`action: 'delete'`), rejecting retention deferral.
- **Rollback / Recovery**: Run automated sweep with `delete` action to purge forbidden records across cache and log stores.

### 3. Timestamp Skew & Clock Drift
- **Symptom**: Nodes writing operational logs with skewed system clocks or future timestamps.
- **Behavior**: Timestamps with future dates are treated as within retention boundaries rather than throwing errors or triggering premature purging.

---

## 4. Retries & Idempotency

- Every minimization and deletion operation is designed to be **idempotent**:
  - Re-applying deletion or anonymization on already processed records returns a consistent zero-count or empty outcome without altering data integrity.
  - Multi-pass deletion queues gracefully handle already-purged records.

---

## 5. Rollback & Disaster Recovery

- **Reversible Actions**: Redaction and anonymization masks (`[REDACTED]`) cannot be unmasked by design. Pre-minimized backups must be restored if a non-expired operational record was mistakenly anonymized.
- **Immutable Protection**: Critical audit logs and records with active retention holds (`RetentionHoldProvider`) cannot be deleted, preventing unintended compliance loss.
