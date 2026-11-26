# Feature Flags and Guarded Rollouts

This document describes the feature flag system and the **feature rollout guard** (`FeatureFlagRolloutGuard`), which provides automated monitoring, verification, and rollback for safe feature deployments.

## Overview

The feature flag system allows code to gate features on and off per scope (global, vault, or wallet). The **guarded rollout** layer adds:

- **Monitored enablement**: Outcomes (success/failure) are tracked in a sliding window.
- **Automatic rollback**: When failure rate exceeds guardrails, the flag is rolled back.
- **Verification**: After rollback, checks confirm the rollback took effect and the flag is truly disabled.
- **Emergency disablement**: Immediate kill-switch for critical incidents, bypassing verification overhead.

## Architecture

### Storage Model

Flags are stored in `feature_flags` table:

```
key: "WITHDRAWAL_SUBMISSION_ENABLED"
scope: "global" | "vault:{id}" | "wallet:{address}"
enabled: boolean
metadata: {
  rollout?: RolloutRecord  // Active, rolling_back, etc.
}
```

A `RolloutRecord` captures:
- Rollout ID, state machine (active → rolling_back → rolled_back/completed)
- Pre-rollout value (what to restore on rollback)
- Guardrails (failure threshold, sample window size)
- Start/end timestamps and actors
- Verification report (checks run after rollback)

### Feature Scope

Scopes allow granular rollouts:

- **`global`**: Flag enabled for all users/vaults
- **`vault:{vaultId}`**: Flag enabled only within one vault
- **`wallet:{walletAddress}`**: Flag enabled only for one wallet

The scope string is validated (`parseScopeString(scope)`); invalid scopes are rejected at start-time.

## Guarded Rollouts: Lifecycle

### 1. Start a Rollout

Maintainer starts a guarded rollout:

```bash
POST /admin/feature-flags/{flagKey}/rollout
{
  "scope": "global" or "vault:..." or "wallet:...",
  "reason": "canary withdrawal submissions",
  "guardrails": {
    "max_error_rate": 0.05,     # 5% failure threshold
    "min_samples": 20,           # Need 20 outcomes before trusting rate
    "window_seconds": 300        # Look at last 5 minutes
  }
}
```

**Preconditions:**
- No rollout already active for this flag + scope
- Flag must not already be enabled for this scope
- Scope must be valid (global, vault:*, wallet:*, etc.)

**Side effects:**
- Flag is enabled in the requested scope
- Rollout record created with state = `active`
- Pre-rollout value stored (so rollback knows what to restore)
- Audit entry created

### 2. Record Outcomes (Hot Path)

Code behind the guarded flag reports successes and failures:

```typescript
// In a request handler:
try {
  // Perform guarded operation
  await submitWithdrawal(wallet, vault, amount);
  await app.flagRollouts.record(flagKey, scope, "success");
} catch (err) {
  await app.flagRollouts.record(flagKey, scope, "failure");
  throw err;
}
```

**Behavior:**
- Cheap when no rollout is active (no-op).
- When active, outcome is added to a sliding window (default 5 minutes).
- Outcomes older than the window are dropped.
- After each record, health is computed: `samples`, `failures`, `errorRate`, `breached`.
- **Automatic rollback trigger**: If `samples >= minSamples && errorRate > maxErrorRate`, the guard automatically rolls back.

### 3. Automatic Rollback & Verification

When guardrails are breached, the guard:

1. **Rolls back** (transitions rollout state from `active` → `rolling_back`):
   - Flag is set to its pre-rollout value (usually `false`)
   - Local cache is invalidated
   - Audit entry created with reason "automatic: X/Y failures (Z%)"

2. **Verifies** (transitions state to `rolled_back` or `rollback_unverified`):
   - **Stored value restored**: Check database reads the correct pre-rollout value.
   - **Local cache consistent**: This process serves the rolled-back value.
   - **Replica caches expired**: Other replicas' cached values are old enough to be safe.
   - **Domain checks**: Custom checks run (e.g., "no withdrawals submitted since rollback").

**Verification states:**
- `rolled_back`: All checks passed; rollback is complete and verified.
- `rollback_unverified`: Some checks are pending (replicas' caches not yet expired) or failed. Re-verify later.

### 4. Manual Rollback or Completion

Maintainer can manually intervene:

```bash
# Manual rollback (if not already triggered)
POST /admin/feature-flags/{flagKey}/rollout/rollback
{ "scope": "global", "reason": "incident" }

# Re-verify after fixes
POST /admin/feature-flags/{flagKey}/rollout/verify
{ "scope": "global" }

# Promote: flag stays on (no more guard monitoring)
POST /admin/feature-flags/{flagKey}/rollout/complete
{ "scope": "global", "reason": "healthy for 24h, promoting to permanent" }
```

## Emergency Disablement

For critical incidents (data corruption, security breach), the **emergency-disable** endpoint bypasses rollout verification:

```bash
POST /admin/feature-flags/{flagKey}/rollout/emergency-disable
{
  "scope": "global" or "vault:...",
  "reason": "data corruption detected"
}
```

### Key Properties

- **Immediate**: No verification needed; flag is disabled right now.
- **Idempotent**: Disabling an already-disabled flag is a no-op.
- **Cache reset**: All in-flight window samples and caches are cleared.
- **Audit trail**: Actor and reason are logged.
- **No rollout record**: Does not create a rollout; suitable only for immediate off-switches.

### Use Cases

- **Data corruption**: Flag is causing data integrity issues.
- **Security breach**: Code behind flag has a vulnerability.
- **Cascading failure**: Flag is causing unrecoverable downstream failures.

### Differences from Rollback

| Feature | Rollback | Emergency Disable |
|---------|----------|-------------------|
| Verification | Required; checks must pass | None; immediate |
| State machine | Recorded in `rolling_back`/`rolled_back` | No state; just sets `enabled=false` |
| Idempotency | Can rollback multiple times | Idempotent; second call is no-op |
| Use case | Guardrail breach or manual stop | Critical incidents only |

### Recovery from Emergency Disable

After emergency-disabling a flag:

1. **Understand root cause**: Review logs, run diagnostics.
2. **Fix the bug** in code behind the flag.
3. **Re-enable carefully**: Start a new rollout with tighter guardrails.
4. **Monitor closely**: Watch health until confident.

## Edge Cases and Recovery

### Stale Replicas (Cache Not Expired)

**Scenario**: Rollback completes, but other replicas still serve the old cached value.

**Detection**: Verification check `replica_caches_expired` is `pending`.

**Resolution**:
- Guard automatically re-verifies once TTL expires (if `autoReverify: true`).
- Or manually call `POST /verify` after cache TTL.

### Flag Re-enabled Behind Guard's Back

**Scenario**: A stale writer or manual SQL re-enables the flag after rollback.

**Detection**: Verification check `stored_value_restored` is `fail`.

**Resolution**:
- Guard detects the flag is wrong and re-asserts the rollback value.
- Call `POST /rollback` again; the guard re-enables the pre-rollout value.

### Process Restart During Rollout

**Scenario**: Server crashes while rollout is `active`.

**Recovery**:
- On restart, guard reads the persisted rollout state from the database.
- Pre-rollout value is in the rollout record, so guard can safely restore it.
- Calling `POST /rollback` from a fresh guard instance works identically.

### Concurrent Rollbacks

**Scenario**: Two replicas detect a breach at the same time and both attempt rollback.

**Behavior**:
- Database row lock serializes the writes.
- First replica succeeds; second sees the rollout already in `rolling_back` and returns the same record.
- Only one audit entry is created.

### Verification Check Errors

**Scenario**: A custom verification check throws (e.g., RPC unreachable).

**Behavior**:
- Check status is `fail`, detail is `"check errored: ..."`.
- Rollback stays in `rollback_unverified`.
- Maintainer can retry verification later or ignore (if failure is transient).

### Completed Rollouts

**Scenario**: Maintainer calls `POST /complete` to promote a rollout.

**Behavior**:
- Rollout state becomes `completed`; guard stops monitoring.
- Flag stays enabled; guard never rolls it back.
- Calling `POST /rollback` on a completed rollout is an error.

## Authorization

All rollout endpoints require `admin.flags.write` permission (maintainer+ role).

The `actor` field in audit entries captures `{role}:{subject}` (e.g., `maintainer:alice`).

## Contracts and Backwards Compatibility

### Database Schema

The `feature_flags` table stores:
- `key` (VARCHAR): Flag name
- `scope` (VARCHAR): Scope string
- `enabled` (BOOLEAN): Current state
- `metadata` (JSONB): Rollout record and other metadata

The `metadata` column is fully backwards compatible:
- **Without rollout**: `metadata = {}` or null
- **With rollout**: `metadata.rollout = { id, state, ... }`

Existing code reading flags via `FeatureFlagService.isEnabled(flag, scope)` sees no change.

### API Contracts

**New endpoints** (no breaking changes):
- `POST /admin/feature-flags/{key}/rollout` (start)
- `POST /admin/feature-flags/{key}/rollout/rollback` (manual rollback)
- `POST /admin/feature-flags/{key}/rollout/verify` (verification)
- `POST /admin/feature-flags/{key}/rollout/complete` (promotion)
- `POST /admin/feature-flags/{key}/rollout/emergency-disable` (emergency kill-switch)
- `GET /admin/feature-flags/{key}/rollout?scope=` (get state and health)

Existing `/admin/feature-flags/{key}` endpoints (simple enable/disable) remain unchanged.

### Code Contracts

**Usage in feature-gated code:**

```typescript
// Before: no monitoring
if (await flags.isEnabled(WITHDRAWAL_SUBMISSION_ENABLED)) {
  // ... withdrawal code ...
}

// After: with monitoring (guard records outcome)
if (await flags.isEnabled(WITHDRAWAL_SUBMISSION_ENABLED)) {
  try {
    // ... withdrawal code ...
    await app.flagRollouts.record(WITHDRAWAL_SUBMISSION_ENABLED, scope, "success");
  } catch (err) {
    await app.flagRollouts.record(WITHDRAWAL_SUBMISSION_ENABLED, scope, "failure");
    throw err;
  }
}
```

If `record()` is not called, the guard does not monitor outcomes (no automatic rollback). This is safe; the flag remains enabled until manually disabled.

## Testing

### Unit Tests

Located in `tests/featureFlagRollout.spec.ts`:

- **Scoping**: Flag enabled only in target scope; previous value preserved.
- **Monitoring**: Health computation, sliding window, minSamples threshold.
- **Automatic rollback**: Breach detection, state transitions, concurrent rollbacks.
- **Verification**: Checks (stored value, local cache, replica caches, domain).
- **Emergency disablement**: Immediate disable, idempotency, cache reset.
- **Routes**: HTTP endpoints, authorization, error cases.
- **Recovery**: Process restart, re-assertion, concurrent disables.

### Integration Testing

Recommended manual tests:

1. **Happy path**: Start rollout → feed successes → complete.
2. **Breach scenario**: Start rollout → feed failures → auto-rollback → verify.
3. **Stale replica**: Rollback, then re-enable flag manually; guard re-asserts.
4. **Emergency disable**: During live rollout, emergency-disable; flag is immediately off.
5. **Restart recovery**: Start rollout → kill server → restart → verify rollout persisted.

## Runbook: Incident Response

### Flag Is Misbehaving

1. **Check status**:
   ```bash
   curl -H "Authorization: Bearer {token}" \
     https://api.example.com/admin/feature-flags/WITHDRAWAL_SUBMISSION_ENABLED/rollout?scope=global
   ```

2. **If flag is on but causing errors**:
   ```bash
   curl -X POST -H "Authorization: Bearer {token}" \
     -d '{"scope":"global", "reason":"transaction failures"}' \
     https://api.example.com/admin/feature-flags/WITHDRAWAL_SUBMISSION_ENABLED/rollout/rollback
   ```

3. **If urgent (data corruption, security)**:
   ```bash
   curl -X POST -H "Authorization: Bearer {token}" \
     -d '{"scope":"global", "reason":"data corruption detected"}' \
     https://api.example.com/admin/feature-flags/WITHDRAWAL_SUBMISSION_ENABLED/rollout/emergency-disable
   ```

4. **Wait for verification** (or check status):
   ```bash
   # Re-verify (if stuck in rollback_unverified)
   curl -X POST -H "Authorization: Bearer {token}" \
     -d '{"scope":"global"}' \
     https://api.example.com/admin/feature-flags/WITHDRAWAL_SUBMISSION_ENABLED/rollout/verify
   ```

5. **Fix and re-enable**:
   - Deploy code fix.
   - Start a new rollout with tighter guardrails:
     ```bash
     curl -X POST -H "Authorization: Bearer {token}" \
       -d '{
         "scope":"global",
         "reason":"redeployment after fix",
         "guardrails": {"max_error_rate": 0.01, "min_samples": 50}
       }' \
       https://api.example.com/admin/feature-flags/.../rollout
     ```

## See Also

- `src/services/featureFlagService.ts`: Basic flag enable/disable
- `src/services/featureFlagRollout.ts`: Guard implementation
- `src/routes/featureFlagRollouts.ts`: HTTP routes
- `backend/tests/featureFlagRollout.spec.ts`: Tests
- `lib/capability-grants.ts`: Capability grants for other sensitive actions
