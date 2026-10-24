# Drip-Pool Proxy Upgrade Rollback Runbook (Issue #554)

## Overview & Architecture

The `VaultProxy` transparent proxy (`contracts/drip-pool/src/proxy.rs`) routes execution to a logic contract address while delegating governance to the canonical `DripPool` contract (`contracts/drip-pool/src/lib.rs`). 

When an upgrade introduces a regression or breaking flaw (e.g. state corruption or failed `withdraw`/`claim` executions), operators must initiate a **rollback procedure**. On Soroban, a rollback is structurally an upgrade proposal targeted back to a known-good previous logic contract address (`current_logic_snapshot`).

---

## 1. Anomaly Detection & Incident Response

### Anomaly Indicators
Operators and indexers should monitor for:
* **Contract Execution Reverts**: Sudden spikes in RPC errors on core methods (`withdraw`, `drip`, `claim`, `join`).
* **State & View Queries**: Inconsistent values returned by `logic_contract()`, `pending_upgrade()`, or pool view functions.
* **Indexer Discrepancies**: Missing or malformed Soroban contract events (`proxy upgraded`, `drip`, `withdraw`).

### Immediate Mitigation (Timelock Interim)
Because proxy upgrades enforce a mandatory timelock delay (`HIGH_RISK_DELAY_LEDGERS` = 17,280 ledgers, ~24 hours), the rollback cannot execute instantly.
* **Action**: Immediately invoke emergency pause mode or halt non-essential pool interactions on the pool contract to protect user principal while the rollback timelock elapses.
* **Single-Signer Cancellation**: Any single current pool signer can instantly call `cancel_upgrade(caller, upgrade_id)` to cancel a bad or malicious pending upgrade before it executes.

---

## 2. Governance & Authority

* **Signer Set**: Governance authority strictly tracks the live signer set returned by `DripPoolClient::admins()`.
* **Threshold**: Requires `DripPoolClient::threshold()` signatures.
* **Staleness Guard**: Proposals snapshot `approver_snapshot`, `threshold_snapshot`, `epoch_snapshot`, and `logic_generation_snapshot`. If pool governance or logic generation changes before execution, the proposal is safely invalidated.

---

## 3. Rollback Step-by-Step Procedure

### Step 1: Identify Previous Good Logic Contract
Retrieve the target `PREVIOUS_LOGIC_ADDRESS` from deployment manifests, indexer checkpoints, or previous `UpgradeProposal` snapshots (`current_logic_snapshot`).

### Step 2: Register Migration (If Breaking Transition)
If returning from a breaking upgrade, a migration pair `(CURRENT_LOGIC -> PREVIOUS_LOGIC)` must be registered by a pool signer:
```bash
stellar contract invoke \
  --id <PROXY_CONTRACT_ID> \
  --source-account <ADMIN_SECRET_OR_IDENTITY> \
  --network <NETWORK> \
  -- \
  register_migration \
  --caller <ADMIN_ADDRESS> \
  --from <CURRENT_LOGIC_ADDRESS> \
  --to <PREVIOUS_LOGIC_ADDRESS>
```

### Step 3: Propose Rollback Upgrade
Submit a proposal targeting the previous logic contract. Returns `UPGRADE_ID` (u32 nonce):
```bash
stellar contract invoke \
  --id <PROXY_CONTRACT_ID> \
  --source-account <PROPOSER_IDENTITY> \
  --network <NETWORK> \
  -- \
  propose_upgrade \
  --caller <PROPOSER_ADDRESS> \
  --new_logic <PREVIOUS_LOGIC_ADDRESS> \
  --breaking <true|false>
```

### Step 4: Collect Multisig Approvals
Each co-signer in `approver_snapshot` approves the proposal until `threshold` is met:
```bash
stellar contract invoke \
  --id <PROXY_CONTRACT_ID> \
  --source-account <APPROVER_IDENTITY> \
  --network <NETWORK> \
  -- \
  approve_upgrade \
  --caller <APPROVER_ADDRESS> \
  --upgrade_id <UPGRADE_ID>
```

### Step 5: Wait for Timelock Elapse
The proposal must remain pending for `HIGH_RISK_DELAY_LEDGERS` (~17,280 ledgers / ~24 hours). Query proposal status:
```bash
stellar contract invoke \
  --id <PROXY_CONTRACT_ID> \
  --network <NETWORK> \
  -- \
  pending_upgrade \
  --upgrade_id <UPGRADE_ID>
```

### Step 6: Execute Rollback
Once `ready_at` ledger is reached and threshold signatures are recorded, any current pool signer executes the rollback:
```bash
stellar contract invoke \
  --id <PROXY_CONTRACT_ID> \
  --source-account <EXECUTOR_IDENTITY> \
  --network <NETWORK> \
  -- \
  execute_upgrade \
  --caller <EXECUTOR_ADDRESS> \
  --upgrade_id <UPGRADE_ID>
```

---

## 4. Helper Script Reference

Use [`contracts/scripts/rollback_upgrade.sh`](file:///c:/Users/PAB-NETWORK/Downloads/vaultquest-archive/contracts/scripts/rollback_upgrade.sh) to generate the exact CLI command sequence for any target pool proxy:

```bash
./contracts/scripts/rollback_upgrade.sh <PROXY_CONTRACT_ID> <PREVIOUS_LOGIC_ADDRESS> testnet
```
