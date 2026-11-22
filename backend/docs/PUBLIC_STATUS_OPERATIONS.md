# Public Status Model - Operational Guide

This document covers the safe public-status model for VaultQuest operational states (degraded, paused, maintenance). It includes failure modes, recovery procedures, and runbook examples.

## Overview

The public-status model translates internal dependency health into user-safe operational states:

| State | Cause | Impact | User Experience |
|-------|-------|--------|-----------------|
| **healthy** | All critical dependencies healthy | Full read/write | "All systems operational" |
| **degraded** | Non-critical dependency down (e.g., cache) | Reads slow, writes allowed | "Some updates delayed" |
| **paused** | Critical dependency down (DB/RPC) | No writes, reads stale | "Mutations paused temporarily" |
| **maintenance** | Scheduled operator intervention | No operations | Explicit maintenance message + ETA |

## State Transitions

```
healthy
  ├─ degraded (non-critical dep fails)
  │  ├─ healthy (dep recovers)
  │  └─ paused (critical dep also fails)
  ├─ paused (critical dep fails directly)
  │ ├─ healthy (dep recovers)
  │  └─ degraded (only critical recovered, non-critical down)
  └─ maintenance (operator schedules window)
     └─ healthy (operator clears window)
```

## Operational Edge Cases and Failure Modes

### 1. Degraded → Paused Transition

**Edge case:** Redis cache fails, then Soroban RPC becomes unavailable.

**What happens:**
- System transitions from `degraded` (cache miss, can retry) to `paused` (no mutation allowed)
- UI mutation buttons disabled immediately
- In-flight requests that passed the `canUserMutate()` check may fail with 503

**Recovery:**
1. If RPC recovers first: system stays paused until cache recovers (wait for next `recordSuccess` on cache)
2. If cache recovers first: check `GET /status` — should still show `paused` due to RPC
3. Both recover: system transitions directly to `healthy`

**Mitigation:**
- Cache failures rarely block mutations (marked `requiredForMutations: false`)
- Critical deps (DB, RPC) should have active monitoring + PagerDuty alerts
- See "Runbook: Cache Failure" below

### 2. Stale Data During Pause

**Edge case:** User is shown a cached portfolio balance while paused. They might try to deposit based on stale balance.

**What happens:**
- `GET /status` returns `views: true` (affected) with guidance: "Real-time data unavailable"
- UI should render visual indicator: "⚠ Cached data from X minutes ago"
- Deposit button disabled anyway (due to `affectedFeatures.deposits: true`)

**Recovery:**
1. Wait for critical dependency to recover
2. UI re-fetches portfolio; fresh data loads
3. User can safely proceed

**Mitigation:**
- Always show staleness indicator when `status.affectedFeatures.views === true`
- Never let a fresh balance refresh hide the warning
- See frontend tests: `components/PortfolioView.test.tsx`

### 3. Maintenance Window Expiration

**Edge case:** Operator scheduled 5-minute maintenance, but actual work takes 12 minutes. Maintenance window expires mid-work.

**What happens:**
- At `maintenanceUntil` timestamp, `getPublicStatus()` exits maintenance state
- System falls back to degradation checks (if any deps are down)
- Users see "All systems operational" but ops are still broken

**Recovery:**
1. Operator must extend maintenance: call `POST /status/maintenance` again
2. Recommended: schedule windows with 20% buffer (6-minute window for 5-minute work)
3. Set reminder to extend if work overruns

**Mitigation:**
- Runbooks should include: "If work overruns, extend window immediately"
- Monitor `GET /status` during maintenance to catch early expiration
- Automated checks: send alert if maintenance expires while some deps are down

### 4. Pause Duration Expires Too Early

**Edge case:** Incident response: admin paused for 5 minutes, but issue identified at 6 minutes. Pause expires automatically before resume.

**What happens:**
- At `pauseUntil` timestamp, system transitions back to healthy/degraded
- `canUserMutate()` starts returning `true`
- Deposits resume without operator acknowledgment

**Recovery:**
1. Operator: `POST /status/resume` explicitly (idempotent, safe)
2. If pause already expired, no-op
3. Use indefinite pause for incidents: `POST /status/pause` without `durationSeconds`

**Mitigation:**
- Prefer indefinite pauses (`pauseMutations("reason")`) for incidents
- Only use timed pauses for known-duration events (e.g., "rate limit cooldown for 10s")
- Monitoring: alert if pause expires while any deps are still down

### 5. State Consistency Under High Load

**Edge case:** Concurrent requests check `canUserMutate()` while state transitions.

**What happens:**
- Request A: check at t=0 → `true` (within healthy)
- State change at t=1ms: pause initiated
- Request B: check at t=1ms → `false` (pause active)
- Request A reaches database: database checks `canUserMutate()` again → `false` → returns 503

**Recovery:**
- This is expected behavior (fail-safe)
- Client receives 503 + `Retry-After` header
- Client-side: back off and retry after `Retry-After`

**Mitigation:**
- All mutation endpoints MUST re-check `canUserMutate()` immediately before commit
- Use idempotency keys so retries are safe
- Never trust a single check; gates should be checked at entry + before commit

### 6. Maintenance with Non-Zero Start Time

**Edge case:** Operator schedules maintenance for future time (e.g., "tomorrow 2am").

**What happens:**
- `GET /status` before window: returns `healthy`
- `GET /status` inside window: returns `maintenance`
- `GET /status` after window: returns `healthy` or degraded

**Behavior:**
- Users see nothing until maintenance window starts
- No advance warning in status endpoint (intentional: reduces spam)

**Recovery:**
- Option 1: Use UI announcements/banners separately (not in public-status endpoint)
- Option 2: Return a "scheduledMaintenance" field in future (design decision)

**Mitigation:**
- Send in-app notifications separately: "Maintenance scheduled for tomorrow 2am"
- Update status endpoint only when window is active or imminent (<1 hour)

## Runbooks

### Runbook: Cache Failure (Non-Critical)

**Symptom:** `GET /status` returns `degraded`, users report slow portfolio loads.

**Timeline:**
1. Monitor alert fires: Redis connection pool exhausted
2. Check: `GET /status` → `status: "degraded"`, `views: true` (affected)
3. Customers see: "Updates may be delayed" banner, still allowed to transact

**Steps:**
1. **Assess:** `ssh prod-cache-1; redis-cli ping` → timeout?
2. **Recover cache:**
   ```bash
   # Option A: Restart cache service
   systemctl restart redis
   
   # Option B: Promote read-only cache to primary (if replicated)
   redis-cli SLAVEOF NO ONE
   ```
3. **Monitor recovery:**
   ```bash
   watch "curl -s http://app:8080/status | jq .status"
   # Should show: "healthy" within 30s
   ```
4. **Verify:** Portfolio loads quickly, UI shows fresh data

**Rollback:** None needed (stateless failure). Restart cache and proceed.

### Runbook: RPC Service Down (Critical)

**Symptom:** Deposits failing with "contract invocation failed", `GET /status` returns `paused`.

**Timeline:**
1. Monitor alert: Soroban RPC latency p99 > 10s
2. `GET /status` → `status: "paused"`, all writes blocked, retrying in 30s
3. Customers see: "Transactions paused" with call-to-action

**Steps:**
1. **Assess:**
   ```bash
   curl -X POST https://rpc.stellar.org/soroban/rpc \
     -d '{"method": "getNetwork", "jsonrpc": "2.0", "id": 1}' \
     -H "Content-Type: application/json"
   # Should respond within 1s
   ```
2. **Coordinate with Stellar Foundation:** Is RPC maintenance scheduled?
3. **If RPC is down:**
   - Option A: Wait for Stellar Foundation recovery (typically <30min)
   - Option B: Failover to alternate RPC endpoint (if configured)
4. **Monitor recovery:**
   ```bash
   watch "curl -s http://app:8080/status | jq '.status, .retryAfterSeconds'"
   # Should show: "healthy" and `retryAfterSeconds: null` when recovered
   ```
5. **Notify users:** "RPC service recovered. Transactions resuming."

**Runbook: Manual Pause for Incident**

**Symptom:** Unusual transaction patterns detected (potential exploit).

**Steps:**
1. **Immediate:** Pause mutations for investigation
   ```bash
   curl -X POST http://admin:port/status/pause \
     -H "Authorization: Bearer ${ADMIN_TOKEN}" \
     -d '{"reason": "Investigating unusual transaction patterns. No action needed.", "durationSeconds": 600}'
   # Response: "paused": true, "until": "2026-10-17T15:30:00Z"
   ```
2. **Verify:** `GET /status` → `status: "paused"`, deposits blocked
3. **Investigate:** Review transaction logs, query patterns
4. **Resolution options:**
   - **Safe:** Issue was identified and mitigated → `POST /status/resume`
   - **Caution:** Issue not fully resolved → extend pause: `POST /status/pause` with later duration

**Rollback:** `curl -X POST http://admin:port/status/resume -H "Authorization: Bearer ${ADMIN_TOKEN}"`

### Runbook: Scheduled Maintenance

**Symptom:** Database schema migration scheduled for tonight 2am.

**Preparation:**
1. Schedule maintenance window:
   ```bash
   START=$(date -u -d "2026-10-18 02:00:00 UTC" +"%Y-%m-%dT%H:%M:%SZ")
   END=$(date -u -d "2026-10-18 02:15:00 UTC" +"%Y-%m-%dT%H:%M:%SZ")
   
   curl -X POST http://admin:port/status/maintenance \
     -H "Authorization: Bearer ${ADMIN_TOKEN}" \
     -d "{\"startsAt\": \"$START\", \"endsAt\": \"$END\", \"reason\": \"Database migration: adding indexes for faster queries.\"}"
   ```
2. **Verify:** `GET /status` → should still show `healthy` (window not active yet)
3. **Notify users:** In-app banner: "Maintenance scheduled for tonight 2-2:15am UTC"

**During maintenance:**
1. Monitor: `watch "curl -s http://app:8080/status | jq '.status'"`
   - Should show `maintenance` from 2:00-2:15 UTC
2. Users see: "Maintenance in progress. Service will resume at 2:15am UTC."
3. Users cannot deposit/withdraw/claim (all blocked)
4. Users CAN view (cached data)

**After maintenance:**
1. **If completed on time:** Window expires automatically at 2:15am → users see "healthy"
2. **If overrun:** Extend window:
   ```bash
   NEW_END=$(date -u -d "2026-10-18 02:25:00 UTC" +"%Y-%m-%dT%H:%M:%SZ")
   # Schedule new window (old one is not modified; overlapping windows work as expected)
   ```
3. **Rollback if needed:**
   ```bash
   curl -X POST http://admin:port/status/maintenance/clear \
     -H "Authorization: Bearer ${ADMIN_TOKEN}"
   # If migration failed, clear window; users see degraded (db might be slow) rather than maintenance
   ```

**Post-maintenance check:**
```bash
curl http://app:8080/status | jq '.status, .affectedFeatures'
# Expected: "healthy" and all features false
# If not, check which dep is down: check monitoring dashboard
```

## Integration Checkpoints

### Backend Integration
- [ ] `app.ts`: Inject `degradedMode` + `statusService` at startup
- [ ] All mutation endpoints: Check `statusService.canUserMutate()` before committing
- [ ] Route `/status`: Exposed and no-auth (public)
- [ ] Routes `/status/pause`, `/resume`, `/maintenance/*`: Require admin auth
- [ ] Dependency health updates: Call `degradedMode.recordSuccess/recordFailure` on key operations

### Frontend Integration
- [ ] Display banner when `status !== "healthy"` using `message` + `guidance`
- [ ] Gate mutation buttons: Check `GET /status/can-mutate` or cache `affectedFeatures.deposits`
- [ ] Show staleness indicator when `status.affectedFeatures.views === true`
- [ ] Render maintenance ETA if `status.maintenanceUntil` is present
- [ ] Honor `Retry-After` header on mutations (backoff before retry)

### Monitoring / Alerting
- [ ] Alert if `status === "paused"` for >5min (critical deps down)
- [ ] Alert if maintenance window expires while deps are down (operator action needed)
- [ ] Alert if pause expires while deps are still down (automatic un-pause risk)
- [ ] Log all manual pause/resume/maintenance actions (audit trail)

## FAQ

**Q: Why doesn't the status endpoint warn about future maintenance?**
A: To avoid spamming users with notices that may change. Use separate in-app notification system for advance warnings.

**Q: Can a user see "paused" but still try a transaction?**
A: Yes, due to race conditions between their check and submission. But the transaction will fail with 503 + `Retry-After`. This is safe (idempotency keys + fail-safe design).

**Q: What if the admin forgets to resume after a pause?**
A: If pause has a `durationSeconds`, it expires automatically. If indefinite, users remain paused until operator acts. Recommend: set alerts for manual pause >30min.

**Q: Can maintenance and pause happen at the same time?**
A: Maintenance takes priority. So if you pause then schedule maintenance, maintenance state wins during the overlap.

**Q: Who should have admin access to pause/resume?**
A: On-call engineers + incident commander. Recommend: 2-person approval for pauses >10min (to catch mistakes).

## See Also

- Service code: `backend/src/services/{degradedModeService,publicStatusService}.ts`
- Routes: `backend/src/routes/status.ts`
- Tests: `backend/tests/{degradedMode,public-status,status-routes}.spec.ts`
- API contract: `backend/src/contracts/apiContract.ts` (includes status schema)
