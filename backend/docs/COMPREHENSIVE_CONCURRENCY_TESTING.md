## Comprehensive Multi-Actor Concurrency Testing Guide

## Overview

This document provides operational procedures, failure modes, and recovery steps for the multi-actor concurrency harness implemented for Issue #4.

## Test Coverage

### Race Conditions Tested

1. **Duplicate deposit submissions** - Multiple actors with same idempotency key
2. **Concurrent quest completions** - Race to grant reward
3. **Concurrent withdrawals** - Stale version conflicts
4. **Retry storms** - Exponential backoff under load
5. **Transaction hash attachment** - Exactly-once attachment
6. **Settlement resolution** - Single resolver wins
7. **Job lease acquisition** - Distributed locking
8. **Fenced writes** - Stale worker detection

## Concurrency Guards

### Unique Constraints

#### Purpose
Database-level guarantee that records exist at most once

#### Implementation
```sql
CREATE UNIQUE INDEX action_ledger_idempotency_key ON action_ledger(idempotency_key);
CREATE UNIQUE INDEX reward_grant_idempotency_key ON reward_grants(idempotency_key);
CREATE UNIQUE INDEX pending_events_tx_hash ON pending_events(tx_hash);
```

#### Failure Mode
Unique constraint violation (Prisma P2002)

#### Recovery
Automatic - application treats as successful no-op, returns existing record

#### Verification
```bash
psql -c "SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('action_ledger', 'reward_grants', 'pending_events') AND indexdef LIKE '%UNIQUE%';"
```

### Compare-and-Swap (CAS)

#### Purpose
Atomic state transitions based on current value

#### Implementation
```typescript
const result = await prisma.actionLedger.updateMany({
  where: {
    idempotencyKey,
    status: "pending", // CAS condition
  },
  data: {
    status: "submitted",
    txHash,
    submittedAt: new Date(),
  },
});

if (result.count === 0) {
  throw new AppError(ERROR_CODES.CONFLICT, "State transition conflict");
}
```

#### Failure Mode
Zero rows affected, concurrent state change detected

#### Recovery
1. Re-read current state
2. Evaluate if operation still needed
3. Retry with fresh condition or abort

#### Verification
```bash
# Check CAS failures in logs
grep "State transition conflict" /var/log/vaultquest/app.log | wc -l
```

### Fencing Tokens

#### Purpose
Prevent stale workers from writing after lease expires

#### Implementation
```typescript
const lease = await prisma.jobLease.findUnique({ where: { jobName } });

if (lease.fencingToken !== myToken) {
  throw new AppError(ERROR_CODES.LEASE_EXPIRED, "Stale fencing token");
}

// Guarded write with token check
await prisma.actionLedger.updateMany({
  where: {
    status: "pending",
    // Additional filter by lease scope
  },
  data: { /* ... */ },
});
```

#### Failure Mode
Worker resumes after lease takeover, attempts write with stale token

#### Recovery
Automatic - stale worker abandons write, new lease holder proceeds

#### Verification
```bash
psql -c "SELECT job_name, worker_id, fencing_token, acquired_at FROM job_leases ORDER BY acquired_at DESC;"
```

### Optimistic Concurrency Control (OCC)

#### Purpose
Version-based conflict detection without locking

#### Implementation
```typescript
const record = await prisma.backgroundJob.findUnique({ where: { id } });
const currentVersion = record.payload.version;

const updated = await prisma.backgroundJob.updateMany({
  where: {
    id,
    payload: { path: ["version"], equals: currentVersion },
  },
  data: {
    payload: { ...record.payload, version: currentVersion + 1 },
  },
});

if (updated.count === 0) {
  throw new AppError(ERROR_CODES.VERSION_CONFLICT, "Concurrent modification");
}
```

#### Failure Mode
Version mismatch, another actor updated record first

#### Recovery
1. Re-read current version
2. Retry with new version
3. Max 3 retries, then fail

#### Verification
```bash
psql -c "SELECT id, payload->'version' as version, updated_at FROM background_jobs WHERE payload ? 'version' ORDER BY updated_at DESC LIMIT 10;"
```

## Operational Edge Cases

### Thundering Herd

#### Symptom
Sudden spike in concurrent operations, high conflict rate

#### Detection
- Conflict rate > 20%
- P95 latency > 500ms
- Database connection pool saturation

#### Recovery
1. **Exponential backoff with jitter**: Randomize retry timing
2. **Circuit breaker**: Stop accepting new operations
3. **Rate limiting**: Throttle per-wallet operations
4. **Horizontal scaling**: Add read replicas

#### Rollback
None required - operations either succeed or retry

#### Verification
```bash
# Check conflict rate
psql -c "SELECT COUNT(*) FILTER (WHERE error_code = 'CONFLICT') * 100.0 / COUNT(*) AS conflict_pct FROM action_ledger WHERE created_at > NOW() - INTERVAL '1 hour';"
```

### Distributed Deadlock

#### Symptom
Two workers waiting on each other, neither progresses

#### Detection
- Operation timeout > 30s
- PostgreSQL deadlock detector fires
- Worker health check fails

#### Recovery
1. **Automatic**: PostgreSQL kills one transaction
2. **Retry**: Killed transaction retries with exponential backoff
3. **Alert**: Page if deadlocks > 5 per hour

#### Rollback
Automatic - killed transaction rolled back

#### Verification
```bash
psql -c "SELECT * FROM pg_stat_database_conflicts WHERE datname = 'vaultquest';"
```

### Job Lease Expiry During Execution

#### Symptom
Worker continues execution after lease expires, new worker acquires lease

#### Detection
- Fencing token mismatch
- Duplicate execution attempts
- Overlapping timestamps in audit log

#### Recovery
1. **Stale worker**: Abandon execution on token check
2. **New worker**: Acquire lease with incremented token
3. **Guarded write**: Verify token before commit

#### Rollback
None required - stale worker's write rejected by token check

#### Verification
```bash
psql -c "SELECT job_name, COUNT(DISTINCT worker_id) as worker_count FROM job_leases GROUP BY job_name HAVING COUNT(DISTINCT worker_id) > 1;"
```

### Retry Storm with Shared Idempotency Key

#### Symptom
Many workers retry same operation, all hit unique constraint

#### Detection
- High unique constraint violation rate
- Logs show many actors with same idempotency key
- Single action with high `retry_count`

#### Recovery
1. **Automatic**: Unique constraint prevents duplicates
2. **Return existing**: Query and return existing record
3. **Rate limit**: Per-key retry backoff

#### Rollback
None required - idempotency key prevents duplicates

#### Verification
```bash
psql -c "SELECT idempotency_key, retry_count FROM action_ledger WHERE retry_count > 3 ORDER BY retry_count DESC LIMIT 10;"
```

### Partial State Update

#### Symptom
Multi-step operation interrupted, some steps committed, others not

#### Detection
- Action in intermediate state
- Related records missing or inconsistent
- Orphaned pending events

#### Recovery
1. **Reconciliation sweep**: Background job completes partial state
2. **Compensating action**: Reverse partial changes
3. **Quarantine**: Flag for manual review if ambiguous

#### Rollback
Semi-automatic - reconciler attempts completion first, then compensates

#### Verification
```bash
psql -c "SELECT * FROM action_ledger WHERE status = 'pending' AND submitted_at IS NOT NULL AND tx_hash IS NULL;"
```

## Failure Modes Reference

| Mode | Detection | Auto-Recovery | Manual Steps | Duplicate Risk |
|------|-----------|---------------|--------------|----------------|
| **Unique constraint** | Prisma P2002 | Yes (return existing) | None | None |
| **CAS conflict** | 0 rows affected | Yes (retry) | None | None |
| **Version conflict** | OCC mismatch | Yes (retry with fresh version) | None | None |
| **Thundering herd** | High conflict rate | Yes (backoff + jitter) | Add capacity | None |
| **Distributed deadlock** | PostgreSQL kill | Yes (retry) | None | None |
| **Lease expiry** | Token mismatch | Yes (abandon write) | None | None |
| **Retry storm** | Many unique violations | Yes (return existing) | Rate limit | None |
| **Partial update** | Inconsistent state | Semi (reconciler) | Manual if ambiguous | Possible |

## Running Concurrency Tests

### Local Development

```bash
cd backend
npm test -- tests/concurrency/comprehensive-concurrency.spec.ts
```

### Stress Testing

```bash
# Run with higher actor counts
ACTOR_MULTIPLIER=10 npm test -- tests/concurrency/
```

### Production Load Simulation

```bash
# Requires staging environment
NODE_ENV=staging LOAD_FACTOR=1000 npm test -- tests/concurrency/ --run-against-live
```

## Verification Checklist

After running concurrency tests, verify:

- [ ] Exactly one record per unique constraint
- [ ] All state transitions atomic (CAS succeeded or aborted)
- [ ] No orphaned records (all foreign keys valid)
- [ ] Fencing tokens monotonically increasing
- [ ] Version numbers monotonically increasing
- [ ] No deadlocks detected
- [ ] All actors observed same final state

## Monitoring and Alerts

### Metrics to Track

```typescript
// Prometheus metrics
concurrency_cas_conflicts_total{operation}
concurrency_unique_constraint_violations_total{table}
concurrency_version_conflicts_total{record_type}
concurrency_lease_takeovers_total{job_name}
concurrency_fencing_token_mismatches_total{job_name}
concurrency_operation_duration_seconds{operation,outcome}
```

### Alert Thresholds

- **CAS conflicts**: Alert if > 100 per hour
- **Unique violations**: Alert if > 50 per hour (indicates retry storm)
- **Version conflicts**: Alert if > 20 per hour
- **Lease takeovers**: Alert if > 10 per hour (indicates worker instability)
- **Fencing mismatches**: Page immediately (stale worker writing)

## Operational Runbooks

### Runbook: Resolve Thundering Herd

1. Detect spike:
   ```bash
   psql -c "SELECT COUNT(*) FROM action_ledger WHERE created_at > NOW() - INTERVAL '1 minute';"
   ```

2. Enable circuit breaker:
   ```bash
   curl -X POST https://api.vaultquest.io/admin/circuit-breaker -d '{"enabled": true, "reason": "thundering herd"}'
   ```

3. Scale read replicas:
   ```bash
   kubectl scale deployment postgres-replica --replicas=5
   ```

4. Monitor conflict rate:
   ```bash
   watch -n 5 'psql -c "SELECT COUNT(*) FILTER (WHERE error_code = \"CONFLICT\") * 100.0 / COUNT(*) FROM action_ledger WHERE created_at > NOW() - INTERVAL \"5 minutes\";"'
   ```

5. Re-enable when conflicts < 5%:
   ```bash
   curl -X POST https://api.vaultquest.io/admin/circuit-breaker -d '{"enabled": false}'
   ```

### Runbook: Recover from Lease Expiry

1. Identify stale worker:
   ```sql
   SELECT * FROM job_leases WHERE expires_at < NOW();
   ```

2. Check for fencing token mismatches:
   ```bash
   grep "Stale fencing token" /var/log/vaultquest/worker-*.log
   ```

3. Verify no writes from stale worker:
   ```sql
   SELECT * FROM action_ledger WHERE updated_at BETWEEN '<lease_expired_at>' AND '<lease_acquired_at_by_new_worker>' AND status = 'submitted';
   -- Should return 0 rows
   ```

4. Force lease release if stuck:
   ```sql
   DELETE FROM job_leases WHERE job_name = '<job_name>' AND expires_at < NOW();
   ```

5. Restart workers:
   ```bash
   kubectl rollout restart deployment vaultquest-worker
   ```

### Runbook: Repair Partial State

1. Identify partial updates:
   ```sql
   SELECT * FROM action_ledger WHERE status = 'pending' AND submitted_at IS NOT NULL;
   ```

2. Check for matching pending events:
   ```sql
   SELECT * FROM pending_events WHERE tx_hash IN (SELECT tx_hash FROM action_ledger WHERE id = '<action_id>');
   ```

3. Decide recovery strategy:
   - **Event exists**: Complete reconciliation
   - **No event**: Reset to `pending`, clear `submitted_at`
   - **Ambiguous**: Quarantine for manual review

4. Execute recovery:
   ```bash
   npm run reconcile:partial -- --action-id=<id> --strategy=<complete|reset|quarantine>
   ```

## Testing Best Practices

### Writing New Concurrency Scenarios

1. **Multiple actors**: Test with 3+ concurrent actors
2. **Idempotency**: All operations safe to duplicate
3. **Verification**: Assert exactly-once semantics
4. **Failure injection**: Test with stale reads, conflicts, timeouts

### Example Scenario

```typescript
{
  name: "concurrent_vault_creation",
  actorCount: 5,
  description: "Five actors attempt to create the same vault",
}
```

### Example Test

```typescript
await runConcurrentRaces(
  scenario,
  async (actorId) => {
    return await prisma.actionLedger.create({
      data: {
        idempotencyKey: "shared-key",
        walletAddress: `GACTOR${actorId}`,
        actionType: "create_vault",
        actionPayload: { name: "Shared Vault" },
        status: "pending",
      },
    });
  },
  async (results) => {
    const actions = await prisma.actionLedger.findMany({
      where: { idempotencyKey: "shared-key" },
    });
    expect(actions).toHaveLength(1);
  }
);
```

## Integration with Production

### Load Testing

Run concurrency tests under production-like load:

```bash
# Simulate 1000 concurrent users
npm run load-test -- --scenario=concurrent_deposits --users=1000 --duration=5m
```

### Chaos Engineering

Inject concurrency faults in staging:

```bash
# Inject random CAS conflicts
npm run chaos:inject -- --fault=cas_conflict --probability=0.1 --duration=1h
```

### Synthetic Monitoring

Continuously run concurrency checks:

```bash
# Run every 5 minutes via cron
*/5 * * * * /usr/local/bin/npm run concurrency:synthetic
```

## Further Reading

- [CONCURRENCY_STRATEGY.md](./CONCURRENCY_STRATEGY.md) - Concurrency guards and patterns
- [IDEMPOTENT_EVENT_INGESTION.md](./IDEMPOTENT_EVENT_INGESTION.md) - Indexer concurrency
- [CURSOR_PAGINATION.md](./CURSOR_PAGINATION.md) - Stable pagination under concurrent changes
- [CHAOS_TESTING.md](./CHAOS_TESTING.md) - Deterministic fault injection
