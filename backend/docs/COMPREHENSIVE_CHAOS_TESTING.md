# Comprehensive Chaos Testing Guide

## Overview

This document provides operational procedures, failure modes, and recovery steps for the deterministic chaos testing framework implemented for Issue #1.

## Test Coverage

### Vault Deposits
- Network timeouts during action creation
- Process restarts mid-submission  
- Stale reads with optimistic retry
- Transaction conflicts under load

### Prize Rounds
- Concurrent winner selections
- Serialization conflicts during draw
- Network failures during prize claim
- Recovery from partial prize distributions

### Quest Completion
- Duplicate reward grant prevention
- Concurrent completion evaluations
- Race conditions in progress updates
- Idempotency under backfills

### Wallet Flows
- Approval timeout recovery
- Checkpoint-based resumption
- Retry exhaustion handling
- Manual intervention workflows

### Indexer Reconciliation
- Event ingestion network failures
- Process restart idempotency
- Duplicate event handling
- Checkpoint cursor recovery

## Operational Edge Cases

### Network Failures

#### Symptom
`NETWORK_ERROR` thrown during operation, operation incomplete

#### Detection
- HTTP timeout (> 30s)
- Connection refused
- DNS resolution failure
- SSL handshake timeout

#### Recovery
1. **Automatic**: Idempotent retry with same `idempotencyKey`
2. **Exponential backoff**: 100ms, 200ms, 400ms, 800ms, 1600ms
3. **Max retries**: 5 attempts
4. **Circuit breaker**: Open after 10 consecutive failures

#### Rollback
None required - operation never committed to database

#### Verification
```bash
# Check for duplicate actions
psql -c "SELECT idempotency_key, COUNT(*) FROM action_ledger GROUP BY idempotency_key HAVING COUNT(*) > 1;"

# Should return 0 rows
```

### Process Restarts

#### Symptom
`ProcessRestartError` thrown, mid-operation crash

#### Detection
- Container restart detected
- Health check failure
- OOM kill signal
- Manual restart

#### Recovery
1. **Resume from checkpoint**: Read `recovery_checkpoint` JSON
2. **Identify last completed stage**: `intent_recorded`, `external_action_started`, `transaction_submitted`
3. **Continue from next stage**: Skip already-completed work
4. **Attach transaction hash**: If stage >= `transaction_submitted`

#### Rollback
None required - checkpoint tracks progress, idempotent resume

#### Verification
```bash
# Check recovery checkpoints
psql -c "SELECT id, recovery_checkpoint->>'stage' as stage, status FROM action_ledger WHERE recovery_checkpoint IS NOT NULL ORDER BY created_at DESC LIMIT 10;"
```

### Stale Reads

#### Symptom
CAS condition fails, zero rows updated, concurrent modification detected

#### Detection
- `updateMany` returns `count: 0`
- Expected row version mismatch
- Optimistic lock failure

#### Recovery
1. **Re-read fresh data**: Query current state
2. **Re-evaluate condition**: Check if operation still needed
3. **Retry with current version**: Use fresh data for CAS
4. **Conflict resolution**: Merge or abort based on domain logic

#### Rollback
Automatic - transaction rolled back on zero rows affected

#### Verification
```bash
# Check for CAS retry patterns in logs
grep "CAS retry" /var/log/vaultquest/app.log | wc -l
```

### Transaction Conflicts

#### Symptom
Prisma P2034 error, serialization failure

#### Detection
- PostgreSQL serialization conflict
- Deadlock detected
- Row-level lock timeout

#### Recovery
1. **Exponential backoff**: 50ms, 100ms, 200ms, 400ms, 800ms
2. **Max retries**: 5 attempts
3. **Jitter**: Add random 0-50ms to prevent thundering herd
4. **Circuit breaker**: Degrade service if > 50% conflict rate

#### Rollback
Automatic - PostgreSQL rolls back transaction

#### Verification
```bash
# Check conflict rate
psql -c "SELECT (SELECT COUNT(*) FROM pg_stat_database_conflicts WHERE datname = 'vaultquest') * 100.0 / (SELECT xact_commit FROM pg_stat_database WHERE datname = 'vaultquest') AS conflict_rate_pct;"
```

### Retry Exhaustion

#### Symptom
`NETWORK_ERROR` after max retry attempts, operation abandoned

#### Detection
- Retry count >= `maxAttempts`
- Circuit breaker open
- Upstream service unavailable

#### Recovery
1. **Dead letter queue**: Move to `BackgroundJob` with status `failed`
2. **Alert maintainers**: PagerDuty incident
3. **Manual review**: Check action state, pending events
4. **Compensating action**: Issue refund if funds locked

#### Rollback
Manual - requires maintainer investigation

#### Verification
```bash
# Check dead letter queue
psql -c "SELECT * FROM background_jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10;"
```

## Failure Modes Reference

| Mode | Detection | Auto-Recovery | Manual Steps | Data Loss Risk |
|------|-----------|---------------|--------------|----------------|
| **Network timeout** | HTTP timeout | Yes (retry) | None | None |
| **Process crash** | Container restart | Yes (checkpoint resume) | Verify txHash attached | None |
| **Stale read** | CAS 0 rows affected | Yes (fresh read + retry) | None | None |
| **Serialization failure** | Prisma P2034 | Yes (backoff + retry) | None | None |
| **Retry exhausted** | Max attempts reached | No | Manual compensating action | Possible (funds locked) |
| **Duplicate event** | Unique constraint | Yes (idempotency key) | None | None |
| **Checkpoint corruption** | JSON parse error | No | Manual checkpoint repair | Possible (replay) |
| **Circuit breaker open** | Failure rate > 50% | Yes (auto-close after cooldown) | Check upstream | None |

## Running Chaos Tests

### Local Development

```bash
cd backend
npm test -- tests/chaos/comprehensive-chaos.spec.ts
```

### CI Pipeline

```bash
npm test -- tests/chaos/ --reporter=verbose --coverage
```

### Production Simulation

```bash
# Requires staging environment
NODE_ENV=staging npm test -- tests/chaos/ --run-against-live
```

## Verification Checklist

After running chaos tests, verify:

- [ ] Exactly one database row per `idempotencyKey`
- [ ] All actors observe same final state  
- [ ] Audit trail records all attempts (including failed)
- [ ] Recovery checkpoint advances monotonically
- [ ] No orphaned or inconsistent state
- [ ] Circuit breaker closes after upstream recovery
- [ ] Dead letter queue empty or reviewed

## Monitoring and Alerts

### Metrics to Track

```typescript
// Prometheus metrics
chaos_test_fault_injected_total{fault_type}
chaos_test_recovery_duration_seconds{scenario}
chaos_test_idempotency_violations_total
chaos_test_stale_read_retries_total
chaos_test_circuit_breaker_opens_total
```

### Alert Thresholds

- **Idempotency violations**: Alert if > 0 per hour
- **Retry exhaustion**: Alert if > 5 per hour
- **Circuit breaker opens**: Alert if > 3 per hour
- **Checkpoint corruption**: Page immediately

## Operational Runbooks

### Runbook: Recover from Retry Exhaustion

1. Query dead letter queue:
   ```sql
   SELECT * FROM background_jobs WHERE status = 'failed' AND type = 'action_retry' ORDER BY created_at DESC;
   ```

2. Inspect action state:
   ```sql
   SELECT * FROM action_ledger WHERE id = '<action_id>';
   ```

3. Check for pending events:
   ```sql
   SELECT * FROM pending_events WHERE tx_hash = '<tx_hash>';
   ```

4. Decide recovery path:
   - **Event exists**: Resume reconciliation manually
   - **No event**: Issue compensating refund
   - **Partial state**: Quarantine for manual review

5. Execute recovery:
   ```bash
   npm run recover:action -- --action-id=<id> --strategy=<resume|refund|quarantine>
   ```

### Runbook: Repair Corrupted Checkpoint

1. Identify corrupted actions:
   ```sql
   SELECT id, recovery_checkpoint FROM action_ledger WHERE recovery_checkpoint IS NOT NULL AND recovery_checkpoint::text !~ '^\{.+\}$';
   ```

2. Reconstruct checkpoint from audit trail:
   ```sql
   SELECT * FROM action_ledger WHERE id = '<id>';
   SELECT * FROM pending_events WHERE tx_hash = (SELECT tx_hash FROM action_ledger WHERE id = '<id>');
   ```

3. Update checkpoint:
   ```sql
   UPDATE action_ledger SET recovery_checkpoint = '{"stage": "transaction_submitted", "timestamp": "<iso_timestamp>"}' WHERE id = '<id>';
   ```

4. Verify recovery:
   ```bash
   npm run verify:checkpoint -- --action-id=<id>
   ```

## Testing Best Practices

### Writing New Chaos Scenarios

1. **Deterministic faults**: Use `atOperation` counter, not wall-clock time
2. **Idempotent workflows**: All operations safe to replay
3. **Verification callback**: Assert final state, not intermediate
4. **Audit trail**: Log every fault injection for post-mortem

### Example Scenario

```typescript
{
  name: "deposit_with_triple_timeout_then_success",
  faults: [
    { type: "network_timeout", atOperation: 2 },
    { type: "network_timeout", atOperation: 4 },
    { type: "network_timeout", atOperation: 6 },
  ],
  expectedOutcome: "success",
}
```

### Example Verification

```typescript
await runChaosTest(
  scenario,
  async (coordinator) => {
    // Workflow with coordinator.beforeOperation() calls
  },
  async (result, faults) => {
    expect(result).toBeDefined();
    expect(faults).toHaveLength(3);
    
    // Verify database state
    const actions = await prisma.actionLedger.findMany({ where: { idempotencyKey } });
    expect(actions).toHaveLength(1);
  }
);
```

## Integration with Production

### Synthetic Monitoring

Run subset of chaos scenarios against production:

```bash
# Run read-only chaos tests
npm run chaos:synthetic -- --read-only --scenario=stale_read_recovery
```

### Chaos Engineering Experiments

1. **Game Day**: Scheduled chaos injection in staging
2. **Fault Injection**: Network latency, packet loss via toxiproxy
3. **Blast Radius**: Limit to single pool or wallet
4. **Rollback Plan**: Pre-approved revert procedure

### Post-Mortem Template

```markdown
## Incident Summary
- **Date**: YYYY-MM-DD
- **Duration**: X hours
- **Affected Scenarios**: [deposit, prize, quest]
- **Root Cause**: [network, process, stale_read, conflict]

## Timeline
- HH:MM: Fault injected
- HH:MM: First error detected
- HH:MM: Auto-recovery initiated
- HH:MM: Manual intervention started
- HH:MM: Incident resolved

## Impact
- Actions affected: X
- Data loss: None / Partial / Complete
- User-facing errors: X

## Lessons Learned
- What went well: ...
- What needs improvement: ...
- Action items: ...
```

## Further Reading

- [OPERATION_RECOVERY.md](./OPERATION_RECOVERY.md) - Checkpoint-based recovery
- [IDEMPOTENT_EVENT_INGESTION.md](./IDEMPOTENT_EVENT_INGESTION.md) - Indexer idempotency
- [ERROR_TAXONOMY.md](./ERROR_TAXONOMY.md) - Error codes and remediation
- [CONCURRENCY_STRATEGY.md](./CONCURRENCY_STRATEGY.md) - Concurrent write guards
