# Ledger Reconciliation Engine & Repair Pipeline (`docs/RECONCILIATION.md`)

**Source Code Reference:** `backend/src/services/reconciler.ts`  
**Related Services:** `backend/src/services/ledger.ts`, `backend/src/services/leaseService.ts`, `backend/src/cron.ts`

---

## 1. System Overview

The **VaultQuest Reconciliation Engine** is an operationally critical background service responsible for detecting, auditing, and repairing state drift across four key components of the backend:

1. **`ActionLedger`**: State machine tracking user intent and broadcast status (`pending`, `submitted`, `confirmed`, `reverted`, `orphaned`).
2. **`VaultSettlement`**: Settlement state machine tracking vault fund distribution (`Unresolved`, `Resolving`, `Settled`, `Failed`).
3. **`PendingEvent`**: Indexer ingest buffer storing unconsumed Soroban contract events received from the Stellar network.
4. **On-Chain Evidence**: Canonical ledger state from Stellar RPC / Horizon.

Reconciliation runs periodically via cron (`sweepOrphans`) and can be executed ad-hoc via `reconcileAll(prisma, { dryRun: boolean })`. It includes strict idempotency guards, quarantine safety gates for dangerous discrepancies, and a dual-controlled proposal workflow (`createRepairProposal`) for high-value operations.

---

## 2. The 9 Drift Types Explained

The reconciler identifies 9 distinct categories of drift (`DriftType`). Below is a plain-language explanation and concrete incident scenario for each type:

### 1. `missing_event`
* **Definition:** An action in `ActionLedger` is marked `submitted` with a non-null `tx_hash`, but no matching `PendingEvent` has arrived from the indexer and no `soroban_event_id` is linked.
* **Concrete Example:** A user submits a deposit transaction. The wallet signs and broadcasts `0xabc...` to the Stellar network. The transaction is submitted by the backend, but Stellar RPC experiences temporary event indexing lag. The backend holds `tx_hash: 0xabc...` in `submitted` state while `PendingEvent` contains no record of `0xabc...`.

### 2. `missing_action`
* **Definition:** A `PendingEvent` exists in the database with `consumedAt == null`, but no corresponding row in `ActionLedger` shares its `tx_hash`.
* **Concrete Example:** A user interacts directly with a VaultQuest Soroban contract via the Stellar Laboratory or CLI without using the standard VaultQuest web app. The indexer ingests the contract event into `PendingEvent`, but no matching user intent was ever registered in `ActionLedger`.

### 3. `duplicate_tx_hash`
* **Definition:** Multiple `ActionLedger` records claim the exact same transaction hash (`tx_hash`).
* **Concrete Example:** A client network retry bug causes a user's browser to send two intent creation requests in parallel. If the unique constraint on `tx_hash` is bypassed or modified during migration, two `ActionLedger` rows end up sharing `txHash: 0x123...`.

### 4. `stale_orphan`
* **Definition:** An `ActionLedger` row has been in `orphaned` status for longer than 7 days (`updatedAt < NOW() - 7 days`) with no manual or automated resolution.
* **Concrete Example:** A user's withdrawal transaction timed out during network congestion 8 days ago and was promoted to `orphaned`. The user never retried the transaction, leaving an abandoned orphan record.

### 5. `contradiction`
* **Definition:** An `ActionLedger` row is marked `confirmed` or `reverted`, but the matching `PendingEvent.statusHint` indicates the opposite state.
* **Concrete Example:** Database corruption or an indexer edge case marks `ActionLedger.status = "confirmed"`, but the indexer's `PendingEvent` record for the same transaction carries `statusHint = "reverted"`.

### 6. `orphaned_settlement`
* **Definition:** A `VaultSettlement` record has been stuck in the `Resolving` state for longer than 1 hour (`updatedAt < NOW() - 1 hour`).
* **Concrete Example:** A background worker node picked up a vault settlement job, transitioned the settlement to `Resolving`, and then crashed or lost database connectivity mid-execution before updating the state to `Settled` or `Failed`.

### 7. `missing_settlement`
* **Definition:** An `ActionLedger` record with `status = "confirmed"` and `actionType` in `["deposit", "withdraw"]` references a `vault_id`, but no corresponding `VaultSettlement` row exists for that vault.
* **Concrete Example:** A deposit transaction completes successfully on-chain and `ActionLedger` is updated to `confirmed`, but the downstream event hook that initializes `VaultSettlement` failed to execute.

### 8. `stale_pending_event`
* **Definition:** A `PendingEvent` row remains unconsumed (`consumedAt == null`) for more than 24 hours (`receivedAt < NOW() - 24 hours`).
* **Concrete Example:** The indexer ingested an event that belonged to an un-tracked contract test or invalid user payload. The event sat in the ingest buffer unconsumed for over a day.

### 9. `insolvency_drift`
* **Definition:** Total ledger balances across internal Postgres tables do not match on-chain Soroban contract vault reserves or user asset entitlements.
* **Concrete Example:** An un-indexed contract payout or contract fee parameter update causes on-chain vault reserves to differ from internal database calculated totals.

---

## 3. Repair Decision Tree & Safety Reasoning (`buildRepairPlan`)

When `buildRepairPlan` processes detected drifts, it separates actions into **Automatic Repair Steps** and **Quarantine Isolations**:

```
                         ┌────────────────────────┐
                         │   Drift Detected       │
                         └───────────┬────────────┘
                                     │
         ┌───────────────────────────┴───────────────────────────┐
         │                                                       │
  Automatic Repair                                      Quarantine / Isolation
  (Safe, Deterministic Mutate)                          (High Risk / Operator Audit)
  ├── missing_event (> 5m)  ──> orphan action              ├── contradiction       ──> Quarantine
  ├── missing_action (> 1h) ──> delete pending_event       ├── duplicate_tx_hash   ──> Quarantine
  ├── orphaned_settlement   ──> reset to Unresolved        ├── insolvency_drift    ──> Quarantine
  └── stale_pending_event   ──> delete pending_event       └── missing_settlement  ──> Log / Manual
```

### Automatic Repair Actions & Safety Rationale

1. **`missing_event` (> 5 minutes):**
   - **Action:** Updates `ActionLedger.status` to `orphaned`, sets `errorCode = ORPHAN_TTL_EXPIRED`.
   - **Safety Rationale:** Broadcast intents cannot be allowed to hang in `submitted` state indefinitely. Waiting 5 minutes gives ample buffer for network propagation and indexer polling lag.
2. **`missing_action` (> 1 hour):**
   - **Action:** Deletes `PendingEvent` row.
   - **Safety Rationale:** Unmatched indexer events older than 1 hour represent un-tracked on-chain operations or stale buffer noise. Deleting them keeps the ingest table lean.
3. **`orphaned_settlement` (> 1 hour):**
   - **Action:** Updates `VaultSettlement.state` to `Unresolved`, sets `errorCode = SETTLEMENT_RETRIES_EXHAUSTED`.
   - **Safety Rationale:** Settlements stuck in `Resolving` block subsequent batch processing. Resetting to `Unresolved` allows worker retry loops to safely re-claim the settlement lease.
4. **`stale_pending_event` (> 24 hours):**
   - **Action:** Deletes `PendingEvent` row.
   - **Safety Rationale:** Buffer events unconsumed after 24 hours will never match an active intent and are safely pruned.

### Quarantined Drifts (`RepairQuarantine` Table)

Drifts that pose financial or data-loss risks are **never automatically mutated**. Instead, they are routed to the `RepairQuarantine` table:

- **`duplicate_tx_hash`:** Automatically deleting or modifying one of two duplicate actions risks invalidating legitimate user activity history or corrupting financial balances.
- **`contradiction`:** Conflicting status between on-chain event hints and database records indicates possible data corruption, indexer malfunction, or chain re-organization. Modifying either record automatically risks writing bad state. Human verification against Stellar RPC is required.
- **`insolvency_drift`:** Financial balance discrepancies require manual audit of transaction logs and contract storage before applying manual adjustment ledger entries.

---

## 4. Idempotency Guarantees (`applyRepairPlan` & Provenance)

To ensure that executing or retrying a repair plan never results in double-mutations, the engine implements a multi-layer idempotency mechanism:

### 1. Step Provenance Tracking
Every proposed `RepairStep` is assigned a canonical provenance string:
```typescript
provenance: `drift:${driftType}:${recordId}`
```

### 2. Pre-Execution Audit Check
Before applying any mutation, `applyRepairPlan` queries the `RepairAudit` table:
```typescript
const existingAudit = await prisma.repairAudit.findFirst({
  where: {
    planJson: { path: ["provenance"], equals: step.provenance }
  }
});
if (existingAudit) continue; // Skip step — already applied
```

### 3. Canonical Plan Hashing (`computeDiffHash`)
For dual-controlled repair proposals (#597), the engine computes a deterministic SHA-256 hash of all step details:
```typescript
const diffHash = computeDiffHash(plan);
```
Approvals (`RepairApproval`) are cryptographically bound to `diffHash`. If a repair plan's steps are modified after creation, the hash changes, automatically invalidating any prior approvals.

---

## 5. Investigating Incident Quarantines (`RepairQuarantine`)

When investigating an incident, operators should query the `RepairQuarantine` table for active cases (`resolvedAt IS NULL`).

### Reading Quarantine Records

```sql
SELECT id, record_type, record_id, drift_type, details, created_at
FROM repair_quarantine
WHERE resolved_at IS NULL
ORDER BY created_at DESC;
```

### Incident Response Playbook

#### Scenario A: Resolving a `contradiction` Quarantine
1. Extract `txHash` from `details`.
2. Inspect the transaction on Stellar Explorer / Horizon RPC to verify its final execution status (`SUCCESS` vs `FAILED`).
3. If on-chain transaction succeeded: Update `ActionLedger` status to `confirmed`.
4. If on-chain transaction failed: Update `ActionLedger` status to `reverted`.
5. Mark quarantine resolved:
   ```sql
   UPDATE repair_quarantine
   SET resolved_at = NOW(), resolved_by = 'operator_username'
   WHERE id = 'quarantine_record_id';
   ```

#### Scenario B: Resolving a `duplicate_tx_hash` Quarantine
1. Query `ActionLedger` for all rows sharing `txHash`.
2. Identify the true action record created by the primary intent flow.
3. Redact or delete the duplicate row.
4. Mark quarantine resolved in `RepairQuarantine`.

---

## 6. Operational Guidance & Runbook

### Cron Schedule & Worker Leases
- **Schedule:** `sweepOrphans` runs every **1 minute** (`*/1 * * * *`) via `startReconcilerCron`.
- **Worker Lease:** Uses `LeaseService` job lease `reconciler-sweep` with a 5-minute TTL (`leaseTtlMs = 5 * 60 * 1000`) and a heartbeat interval running at 1/3 TTL to prevent split-brain execution across multi-replica deployments.

### Running Reconciliation Manually (Dry-Run Mode)

Operators can run reconciliation in dry-run mode via code or CLI scripts to inspect proposed repairs without mutating the database:

```typescript
import { reconcileAll } from "./services/reconciler.js";

const result = await reconcileAll(prisma, { dryRun: true });
console.log(`Drifts found: ${result.driftsFound}`);
console.log(`Steps proposed: ${result.stepsProposed}`);
console.log("Proposed Plan:", JSON.stringify(result.plan, null, 2));
```

### Dual-Control Proposal Governance (#597)

For large or high-value repair plans, automatic direct execution is gated by threshold policies (`DEFAULT_REPAIR_PROPOSAL_LIMITS`):
- **Single Approver Allowed:** Step count $\le 5$ AND estimated value $\le \$1,000$.
- **Dual Approvers Required:** Step count $> 5$ OR estimated value $> \$1,000$.
- **Hard Ceilings:** Max 50 steps per proposal, max \$100,000 total value. Proposal TTL is 30 minutes.

### High Drift Count Alert Playbook

If an operational alert fires for high drift counts (`driftsFound > 20`):

1. **Check Indexer Health:** Verify `GET /health/indexer` to see if sync lag is `lagging` or `degraded`. (Refer to `docs/INDEXER_RUNBOOK.md`).
2. **Execute Dry-Run:** Run `reconcileAll(prisma, { dryRun: true })` to inspect the breakdown of drift types.
3. **If `missing_event` Spikes:** Check Horizon RPC node connectivity and rate limits.
4. **If `orphaned_settlement` Spikes:** Check settlement worker process logs and DB pool health.
5. **Inspect Quarantines:** Query `RepairQuarantine` table to ensure no critical financial contradictions exist.

---

## 7. Related Documentation

- [`docs/INDEXER_RUNBOOK.md`](INDEXER_RUNBOOK.md) — Indexer operation, sync lag metrics, and Horizon RPC troubleshooting.
- [`backend/README.md`](../backend/README.md) — Backend service architecture, database setup, and API endpoint reference.
