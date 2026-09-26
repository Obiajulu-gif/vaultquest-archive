# Operator Runbook: On-Chain vs. Ledger Drift Alerts (#727)

## 1. Overview & Objectives

VaultQuest's automated drift detection service (`OnChainDriftDetector`) runs on a continuous background schedule to compare authoritative on-chain contract state (Soroban smart contracts on Stellar) against off-chain ledger materialized views in PostgreSQL.

When discrepancies arise due to network partitions, missed RPC events, reorgs, or ingestion crashes, the drift detector emits structured alerts without automatically mutating financial records unsafely.

This runbook guides operators through triage, investigation, and safe remediation.

---

## 2. Alert Severity Taxonomy

| Severity | Definition & Impact | Examples | SLA / Urgency |
|---|---|---|---|
| **CRITICAL** | Direct financial, solvency, or integrity discrepancy. On-chain funds lower than ledger liabilities, winner mismatch, or missing contract. | `total_deposited` on-chain < ledger deposits; missing winner on-chain; contract address not found. | **Immediate (P0 - < 15 mins)** |
| **WARNING** | Delayed resolution, yield discrepancy, or stuck pending settlement. | Settlement stuck in `Resolving` > 30 mins; un-reconciled yield dust. | **High (P1 - < 2 hours)** |
| **INFO** | Benign timing variance due to in-flight transaction ingestion lag. | In-flight submitted transaction pending indexer tick; watermark lag < 5 ledgers. | **Monitor (No immediate action)** |

---

## 3. Triage & Investigation Flowchart

```text
               ┌───────────────────────────────┐
               │    Drift Alert Received       │
               └──────────────┬────────────────┘
                              │
               ┌──────────────▼────────────────┐
               │ Check Ingestion Watermark vs  │
               │ Chain Tip (Indexer Lag?)      │
               └──────────────┬────────────────┘
                     /                 \
        (Lag > 0 & In-Flight)     (Watermark at Tip)
                   /                     \
       ┌──────────▼──────────┐   ┌────────▼──────────┐
       │ Benign In-Flight    │   │ Genuine State     │
       │ (INFO) - Wait 1 Min │   │ Discrepancy       │
       └─────────────────────┘   └────────┬──────────┘
                                          │
                                 ┌────────▼──────────┐
                                 │ Check Chain Events│
                                 │ via Stellar RPC   │
                                 └────────┬──────────┘
                                          │
                                 ┌────────▼──────────┐
                                 │ Run Remediation   │
                                 │ Playbook          │
                                 └───────────────────┘
```

---

## 4. Step-by-Step Operator Remediation Playbook

### Step 1: Verify Indexer Health & Watermark Lag
Check if the indexer is lagging behind the Stellar ledger sequence:
```bash
# Query current indexer checkpoint vs Horizon tip
curl -s http://localhost:3000/health
```
- If `latestLedger` in `IndexerCheckpoint` is behind Horizon tip by > 10 ledgers, check indexer logs for RPC timeouts or rate-limiting:
  ```bash
  grep -E "indexer|RPC" /var/log/vaultquest/backend.log
  ```

### Step 2: Replay Ingestion Range (`replayRange`)
If events were dropped during a network outage or RPC restart, execute an indexer replay over the affected ledger interval:
```bash
# Execute replay for ledgers [startLedger, endLedger]
curl -X POST http://localhost:3000/internal/replay \
  -H "Authorization: Bearer $ADMIN_INTERNAL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"startLedger": 123450, "endLedger": 123500}'
```

### Step 3: Propose a Dual-Controlled Repair Plan (`RepairProposal`)
If a manual database adjustment is required to repair a confirmed divergence:
1. Generate the repair plan in dry-run mode using `POST /internal/repair/dry-run`.
2. Propose the repair proposal via `POST /internal/repair/propose`.
3. Require a second independent operator/admin to review and approve via `POST /internal/repair/approve`.
4. Execute the approved proposal with full cryptographic provenance.

---

## 5. Prevention & Monitoring

- Prometheus Metrics:
  - `vaultquest_drift_discrepancies_total{severity="CRITICAL"}`: Alert threshold > 0.
  - `vaultquest_indexer_lag_ledgers`: Alert threshold > 20 ledgers.
- Daily drift detection audit logs persist in `protocol_audits` and `repair_audits`.
