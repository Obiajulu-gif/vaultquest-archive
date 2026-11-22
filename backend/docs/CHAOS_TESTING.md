# Chaos Testing Guide (Issue #1)

## Overview

The chaos testing framework provides deterministic fault injection for vault operations without flaky timing assumptions. Tests verify system recovery under network failures, process restarts, stale reads, and retry storms.

## Architecture

### ChaosCoordinator

Orchestrates fault injection with deterministic sequencing:

```typescript
const coordinator = new ChaosCoordinator(scenario);
await coordinator.beforeOperation("create_action"); // Injects fault if scheduled
```

### Fault Types

- `network_timeout`: Simulates network timeout during operation
- `network_disconnect`: Simulates complete network failure
- `process_restart`: Simulates process crash/restart mid-operation
- `stale_read`: Injects stale data into read operations
- `transaction_conflict`: Simulates database serialization conflict
- `retry_exhausted`: Simulates maximum retry attempts reached

### ChaosScenario

Defines a reproducible fault sequence:

```typescript
{
  name: "deposit_with_network_timeout_then_success",
  faults: [
    { type: "network_timeout", atOperation: 2 }
  ],
  expectedOutcome: "success"
}
```

## Running Tests

```bash
npm test -- tests/chaos/deposit-chaos.spec.ts
```

## Writing Chaos Tests

1. **Define scenario** with deterministic fault sequence
2. **Wrap workflow** with `runChaosTest()`
3. **Call `beforeOperation()`** before each critical operation
4. **Verify recovery** in verification callback

Example:

```typescript
await runChaosTest(
  scenario,
  async (coordinator) => {
    await coordinator.beforeOperation("read_checkpoint");
    const existing = await ledger.getAction(idempotencyKey);
    
    await coordinator.beforeOperation("create_action");
    return await ledger.createAction({ /* ... */ });
  },
  async (result, faults) => {
    expect(result).toBeDefined();
    expect(faults).toHaveLength(1);
  }
);
```

## Standard Scenarios

### deposit_with_network_timeout_then_success

**Faults**: Network timeout on operation 2  
**Expected**: Retry succeeds, exactly one action created

### deposit_with_process_restart_mid_submission

**Faults**: Process restart on operation 3  
**Expected**: Resume from checkpoint, action reaches submitted state

### deposit_with_stale_read_then_conflict

**Faults**: Stale read on operation 1, transaction conflict on operation 4  
**Expected**: Optimistic retry with fresh read succeeds

### withdraw_with_multiple_retries

**Faults**: Network timeout (×2), transaction conflict  
**Expected**: Exponential backoff retries succeed, no duplicates

### quest_completion_with_concurrent_conflicts

**Faults**: Transaction conflict, stale read  
**Expected**: CAS logic prevents double reward grant

## Operational Edge Cases

### Network Failures

**Symptom**: `NETWORK_ERROR` thrown during operation  
**Recovery**: Idempotent retry with same idempotency key  
**Rollback**: None required (operation never committed)

### Process Restarts

**Symptom**: `ProcessRestartError` thrown  
**Recovery**: Resume from `recoveryCheckpoint` stage  
**Rollback**: None required (checkpoint tracks progress)

### Stale Reads

**Symptom**: CAS condition fails, zero rows updated  
**Recovery**: Re-read fresh data, retry with current version  
**Rollback**: Transaction automatically rolled back

### Transaction Conflicts

**Symptom**: Prisma P2034 error  
**Recovery**: Exponential backoff retry (max 5 attempts)  
**Rollback**: Automatic (serializable transaction isolation)

## Failure Modes

| Mode | Detection | Recovery Strategy |
|------|-----------|-------------------|
| Network timeout | `ERROR_CODES.NETWORK_ERROR` | Idempotent retry |
| Process crash | External monitoring | Resume from checkpoint |
| Stale read | CAS affects 0 rows | Fresh read + retry |
| Serialization failure | Prisma P2034 | Backoff + retry |
| Retry exhausted | Max attempts reached | Manual review + compensating action |

## Verification Checklist

- [ ] Exactly one database row created per idempotency key
- [ ] All actors observe same final state
- [ ] Audit trail records all attempts (including failed)
- [ ] Recovery checkpoint advances monotonically
- [ ] No orphaned or inconsistent state

## Integration with CI

Chaos tests run in CI with deterministic scenarios (no flakiness):

```bash
npm test -- --reporter=verbose tests/chaos/
```

Pass rate should be 100% (deterministic fault injection).
