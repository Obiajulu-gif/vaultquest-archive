# Incident Drill Runbook

Executable verification for production recovery procedures. Each drill simulates a real incident and validates recovery steps through automated checks.

## Purpose

- Validate recovery workflows **before** incidents occur
- Maintain operator readiness for high-pressure scenarios
- Detect regressions in recovery tooling
- Provide confidence that documented procedures actually work

## Drill Catalog

| Drill | Incident Type | Recovery Time Target | Frequency |
|-------|---------------|---------------------|-----------|
| `stuck_deposit` | User deposit pending >30min | <5min | Monthly |
| `indexer_lag` | Indexer falls behind >10k ledgers | <10min | Quarterly |
| `quest_race` | Concurrent quest completion | Immediate (automated) | Quarterly |
| `settlement_timeout` | Vault settlement stuck >1hr | <15min | Monthly |
| `reconciliation_drift` | Missing events (indexer gap) | <30min | Quarterly |

---

## Drill 1: Stuck Deposit Recovery

### Scenario
User's deposit has been in `pending` status for >30 minutes. No confirmation from chain.

### Recovery Steps

```bash
# 1. Identify stale actions
npm run drill -- --type stuck_deposit --environment sandbox

# Manual equivalent:
psql $DATABASE_URL -c "
  SELECT id, wallet_address, action_type, status, 
         EXTRACT(EPOCH FROM (NOW() - updated_at))/60 AS stale_minutes
  FROM action_ledger
  WHERE status IN ('pending', 'submitted')
    AND updated_at < NOW() - INTERVAL '30 minutes'
  ORDER BY updated_at ASC
  LIMIT 100;
"

# 2. Scan for recovery cases
curl -X POST https://api.vaultquest.io/admin/recovery/scan \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"limit": 100}'

# 3. Review cases
curl https://api.vaultquest.io/admin/recovery/cases?state=retryable \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 4. Retry individual case
CASE_ID=rec_12345678
curl -X POST https://api.vaultquest.io/admin/recovery/cases/$CASE_ID/retry \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 5. Verify resolution
curl https://api.vaultquest.io/admin/recovery/cases/$CASE_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Verification Checks

- ✅ Stale actions detected (>30min old, status=pending)
- ✅ Recovery case created in `retryable` state
- ✅ Retry executes without error
- ✅ Case transitions to `resolved` or `failed`
- ✅ User sees updated status in dashboard

### Rollback
No rollback needed — recovery is non-destructive (reads action state, updates case).

### User Impact
- **During**: No visible change (action already stuck)
- **After recovery**: User sees status update (confirmed/failed)

### Escalation Path
If retry fails after 3 attempts → case transitions to `failed` → escalate to manual review.

---

## Drill 2: Indexer Lag Detection

### Scenario
Stellar indexer has fallen behind chain tip by >10,000 ledgers (RPC scan limit).

### Recovery Steps

```bash
# 1. Check indexer lag
npm run drill -- --type indexer_lag --environment sandbox

# Manual equivalent:
curl https://api.vaultquest.io/admin/indexer/status \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Expected output:
# {
#   "latestLedger": 1050000,
#   "chainLatestLedger": 1065000,
#   "lag": 15000,
#   "lastSyncTime": "2026-10-18T10:00:00Z",
#   "status": "lagging"
# }

# 2. Check recent indexer errors
psql $DATABASE_URL -c "
  SELECT last_error, last_sync_time, indexer_version
  FROM indexer_checkpoints
  WHERE id = 'singleton';
"

# 3. Resume indexer (if stuck)
# Option A: Restart indexer process
systemctl restart vaultquest-indexer

# Option B: Manual replay for specific range
curl -X POST https://api.vaultquest.io/admin/indexer/replay \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"startLedger": 1050000, "endLedger": 1065000}'

# 4. Monitor catch-up
watch -n 5 "curl -s https://api.vaultquest.io/admin/indexer/status | jq '.lag'"
```

### Verification Checks

- ✅ Lag metric reported accurately
- ✅ Indexer checkpoint exists
- ✅ Replay completes without quarantine
- ✅ Lag reduces to <100 ledgers within 10min

### Rollback
Indexer replay is append-only — no rollback needed.

### User Impact
- **During lag**: Recent deposits/withdrawals not visible yet
- **After catch-up**: All actions appear in history

### Escalation Path
If indexer stuck with same error for >1hr → check RPC connectivity, Horizon health, contract ID filter.

---

## Drill 3: Quest Reward Grant Race

### Scenario
Two workers simultaneously evaluate a wallet that just completed a quest. Must ensure exactly one reward grant.

### Recovery Steps

```bash
# 1. Simulate race condition
npm run drill -- --type quest_race --environment sandbox

# Manual verification (should never be needed in production):
psql $DATABASE_URL -c "
  SELECT wallet_address, quest_id, COUNT(*)
  FROM reward_grants
  GROUP BY wallet_address, quest_id
  HAVING COUNT(*) > 1;
"
# Expected: 0 rows (no duplicates)

# 2. If duplicate detected (should not happen):
# Identify duplicate grants
psql $DATABASE_URL -c "
  SELECT id, wallet_address, quest_id, created_at, idempotency_key
  FROM reward_grants
  WHERE (wallet_address, quest_id) IN (
    SELECT wallet_address, quest_id
    FROM reward_grants
    GROUP BY wallet_address, quest_id
    HAVING COUNT(*) > 1
  )
  ORDER BY wallet_address, quest_id, created_at;
"

# 3. Manual remediation (last resort):
# Keep the earliest grant, delete duplicates
# DO NOT DO THIS WITHOUT FINANCE APPROVAL
```

### Verification Checks

- ✅ Quest progress computed correctly
- ✅ Exactly 1 reward grant created
- ✅ UserQuest has single `completedAt` timestamp
- ✅ Concurrent evaluations both succeed (one grants, one no-ops)

### Rollback
Drill auto-rollback removes test grants.

### User Impact
None (automated, instant).

### Escalation Path
Duplicate grants should be **impossible** due to:
1. Optimistic concurrency on `UserQuest.completedAt`
2. Unique constraint on `RewardGrant.idempotencyKey`

If detected → **critical bug** → freeze quest evaluation, audit ledger.

---

## Drill 4: Settlement Timeout

### Scenario
Vault settlement stuck in `Resolving` state for >1 hour. Horizon submission may have timed out.

### Recovery Steps

```bash
# 1. Detect stale settlements
npm run drill -- --type settlement_timeout --environment sandbox

# Manual equivalent:
psql $DATABASE_URL -c "
  SELECT vault_id, state, settlement_type, attempts, 
         EXTRACT(EPOCH FROM (NOW() - updated_at))/60 AS stale_minutes,
         tx_hash, error_code
  FROM vault_settlements
  WHERE state = 'Resolving'
    AND updated_at < NOW() - INTERVAL '1 hour'
  ORDER BY updated_at ASC;
"

# 2. Run reconciliation to detect drift
curl -X POST https://api.vaultquest.io/admin/reconciliation/scan \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# 3. Review proposed repairs
curl https://api.vaultquest.io/admin/reconciliation/report \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Expected drift type: "orphaned_settlement"

# 4. Retry settlement through controlled workflow
# Option A: Automated repair (if non-financial)
curl -X POST https://api.vaultquest.io/admin/reconciliation/apply \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"targets": ["orphaned_settlement"], "dryRun": false}'

# Option B: Manual retry (if automated blocked)
VAULT_ID=vault-12345
curl -X POST https://api.vaultquest.io/admin/settlements/retry \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"vaultId\": \"$VAULT_ID\"}"

# 5. Verify resolution
psql $DATABASE_URL -c "
  SELECT vault_id, state, tx_hash, result_code
  FROM vault_settlements
  WHERE vault_id = '$VAULT_ID';
"
```

### Verification Checks

- ✅ Stale settlement detected (>1hr in Resolving)
- ✅ Drift flagged as `orphaned_settlement`
- ✅ Repair plan includes retry step
- ✅ Retry succeeds or fails cleanly (no stuck state)

### Rollback
Settlements are on-chain — **cannot rollback**. If retry fails, settlement moves to `Unresolved` (manual review).

### User Impact
- **During**: Prize payout pending
- **After success**: Funds transferred to recipient
- **After failure**: Admin manually investigates Horizon/Stellar error

### Escalation Path
If retry exhausts attempts (default 3) → settlement moves to `Unresolved` → admin reviews Horizon logs, checks account balance, considers manual payout via alternate path.

---

## Drill 5: Reconciliation Drift (Missing Event)

### Scenario
`ActionLedger` has `tx_hash` but no corresponding `PendingEvent` (indexer missed the event).

### Recovery Steps

```bash
# 1. Detect drift
npm run drill -- --type reconciliation_drift --environment sandbox

# Manual equivalent:
psql $DATABASE_URL -c "
  SELECT al.id, al.tx_hash, al.status, al.wallet_address
  FROM action_ledger al
  WHERE al.tx_hash IS NOT NULL
    AND al.status IN ('submitted', 'confirmed')
    AND NOT EXISTS (
      SELECT 1 FROM pending_events pe WHERE pe.tx_hash = al.tx_hash
    )
  LIMIT 100;
"

# 2. Identify ledger range to re-scan
# Get action's observed_ledger or estimate from created_at
ACTION_ID=12345678
psql $DATABASE_URL -c "
  SELECT id, tx_hash, observed_ledger, created_at
  FROM action_ledger
  WHERE id = '$ACTION_ID';
"

# 3. Replay indexer over missing range
START_LEDGER=1050000
END_LEDGER=1051000
curl -X POST https://api.vaultquest.io/admin/indexer/replay \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"startLedger\": $START_LEDGER, \"endLedger\": $END_LEDGER}"

# 4. Verify event recovered
psql $DATABASE_URL -c "
  SELECT tx_hash, soroban_event_id, status_hint, consumed_at
  FROM pending_events
  WHERE tx_hash = '<tx_hash_from_action>';
"

# 5. Re-run reconciliation to confirm drift resolved
curl -X POST https://api.vaultquest.io/admin/reconciliation/scan \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Verification Checks

- ✅ Drift detected: `missing_event`
- ✅ Action has `tx_hash`
- ✅ `PendingEvent` missing initially
- ✅ Replay fetches event from Stellar
- ✅ Event reconciled with action

### Rollback
Indexer replay is idempotent — duplicate events are skipped. No rollback needed.

### User Impact
- **During drift**: Action status may be stale
- **After recovery**: Action status reflects chain reality

### Escalation Path
If replay cannot find event on Stellar → verify `tx_hash` is correct → check if transaction was actually submitted (Stellar Explorer) → if not, mark action as `orphaned`.

---

## Running Drills

### Automated Execution

```bash
# Run single drill
npm run drill -- --type stuck_deposit --environment sandbox --auto-rollback

# Run all drills
npm run drill:all -- --environment sandbox

# Schedule monthly drill (cron)
0 3 1 * * /usr/local/bin/npm --prefix /opt/vaultquest run drill:all --environment sandbox >> /var/log/drills.log 2>&1
```

### Manual Execution

```bash
# Test environment
npm run drill -- --type quest_race --environment test

# Sandbox environment
npm run drill -- --type settlement_timeout --environment sandbox

# NEVER run in production
```

### Test Suite

```bash
# Run drill verification tests
npm test -- tests/incidentDrill.spec.ts

# Expected output:
# ✅ Stuck Deposit Drill
# ✅ Indexer Lag Drill
# ✅ Quest Race Drill
# ✅ Settlement Timeout Drill
# ✅ Reconciliation Drift Drill
```

---

## Drill Reporting

Each drill produces a JSON report:

```json
{
  "drill": "stuck_deposit",
  "scenario": "User deposit stuck in pending for >30min",
  "startedAt": "2026-10-18T12:00:00Z",
  "completedAt": "2026-10-18T12:02:30Z",
  "durationMs": 150000,
  "steps": [
    { "step": "1", "description": "Create action in pending state", "expectedOutcome": "..." },
    { "step": "2", "description": "Wait for stale threshold", "expectedOutcome": "..." }
  ],
  "verifications": [
    { "check": "Action created in pending state", "passed": true, "actual": "pending", "expected": "pending" },
    { "check": "Recovery case opened", "passed": true, "actual": "retryable", "expected": "retryable" }
  ],
  "passed": true,
  "summary": "✅ Stuck deposit recovery workflow validated",
  "rollbackPerformed": true
}
```

Store reports in `drill-results/` directory with timestamp.

---

## Failure Modes

| Failure | Symptom | Recovery |
|---------|---------|----------|
| Drill fails | `passed: false` | Review verification failures → fix bug → re-run drill |
| Drill times out | No result returned | Check test DB connectivity, increase timeout, review logs |
| Rollback incomplete | Test data persists | Manual cleanup: `DELETE FROM action_ledger WHERE idempotency_key LIKE 'drill-%'` |
| Real incident during drill | Drill interferes with production | **Never run drills in production** |

---

## Best Practices

1. **Frequency**: Run critical drills (stuck deposit, settlement timeout) monthly. Run others quarterly.
2. **Environment**: Always use `test` or `sandbox`. Production drills are **forbidden**.
3. **Automation**: Schedule drills via cron; alert on failures.
4. **Documentation**: Update this runbook when recovery procedures change.
5. **Post-Incident**: Re-run relevant drill after real incidents to validate fixes.
6. **Rotation**: Different operators should run drills to maintain team readiness.

---

## References

- Implementation: `backend/src/operations/incidentDrill.ts`
- Tests: `backend/tests/incidentDrill.spec.ts`
- Recovery service: `backend/src/services/pendingRecovery.ts`
- Reconciliation: `backend/src/services/reconciler.ts`
- Indexer: `backend/src/services/stellarIndexer.ts`
