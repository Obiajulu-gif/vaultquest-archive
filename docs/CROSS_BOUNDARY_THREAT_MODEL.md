# VaultQuest Cross-Boundary Threat Model

This document establishes the scenario-based threat model for cross-boundary trust decisions in VaultQuest (#917). It analyzes attack surfaces across the decentralized application, wallet interface, Soroban smart contracts, backend action ledger, and event reconciliation indexer.

---

## 1. Trust Architecture & Boundary Matrix

VaultQuest spans five interconnected trust domains:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [DOMAIN A] Untrusted Client & Web Browser                                                │
│  - User inputs, local form state, client-side timers, optimistic balances                │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                    BOUNDARY 1: Client API & Intent Registration
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [DOMAIN B] Backend Action Ledger & API Service (Fastify / Postgres / Redis)            │
│  - Intent tracking, idempotency deduplication, rate limits, audit logging               │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                    BOUNDARY 2: Wallet Signing & XDR Construction
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [DOMAIN C] Stellar Wallet Layer (@vaultquest/stellar-wallet-connect / Freighter)       │
│  - Key isolation, transaction signing, network broadcast                                │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                    BOUNDARY 3: Soroban On-Chain Execution & SAC Token Custody
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [DOMAIN D] Stellar Network & Soroban Contracts (drip-pool / vault-factory)              │
│  - Canonical balances, round state machine, verifiable randomness, multi-sig governance │
└──────────────────────────────────────────┬──────────────────────────────────────────────┘
                    BOUNDARY 4: Event Extraction & Ingestion
                                           ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ [DOMAIN E] Stellar Indexer & Reconciliation Engine                                      │
│  - RPC event stream, append-only ChainEvent log, two-way reconciliation, drift detection│
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Threat Scenarios by Subsystem

### 2.1. Vault Deposits & Balance Accounting

- **Boundary**: Client UI $\rightarrow$ Wallet Extension $\rightarrow$ Soroban Contract $\rightarrow$ Indexer $\rightarrow$ Backend DB.
- **Abuse Cases**:
  1. *Intent vs. Reality Divergence*: Attacker submits `POST /actions` declaring a deposit of 100,000 USDC (`actionPayload`), but broadcasts a transaction transferring only 1 USDC. If the backend relies on `actionPayload` for credit, attacker creates an unbacked balance.
  2. *Front-running Round Lockup*: Depositing in the final seconds before a prize round locks up to capture yield without bearing liquidity risk.
  3. *Unfinalized Ledger Reorgs*: A deposit confirmed at depth 1 is subsequently orphaned by a temporary Stellar ledger fork, leaving the backend with a ghost deposit.
- **Mitigations**:
  - **Verified Payload Separation** (`#509`): The backend action record maintains `actionPayload` (untrusted client intent) and `verifiedPayload` (decoded strictly from finalized on-chain `RawHorizonEvent`). All downstream payouts and portfolio valuations read `verifiedPayload` exclusively.
  - **Ledger Depth Finality** (`#753`): Status progresses from `provisional` $\rightarrow$ `finalized` only when `confirmationDepth >= FINALITY_POLICY.CONFIRMATION_DEPTH`.
  - **Contract-Enforced Lockup Multipliers** (`#382`): Lockup weights are snapshotted on-chain at round transition; deposits after lockup apply only to future rounds.

---

### 2.2. Prize Rounds & Verifiable Winner Selection

- **Boundary**: Scheduler / Admin $\rightarrow$ Soroban Contract $\rightarrow$ Randomness Beacon $\rightarrow$ Reconciler.
- **Abuse Cases**:
  1. *Biased Seed Commitment*: An operator or miner manipulates the randomness seed to favor a specific participant.
  2. *Unclaimed Prize Siphoning*: An admin sweeps unclaimed prizes prematurely before participants reach their claim deadline.
  3. *Double Payout on Replay*: Replaying round settlement events to trigger duplicate prize disbursements.
- **Mitigations**:
  - **Commit-Reveal Randomness & Domain Separation** (`#379`): Winner selection uses a two-phase protocol: round seed commitment is locked before round close; revelation is deterministic, salted with `round_id`, and auditable via offline verification tools (`tools/draw-verifier/verify-draw.mjs`).
  - **Public View Deadlines & Strict Enforcement** (`#440`): `claim_deadline` is strictly enforced on-chain. `sweep_unclaimed` fails if `ledger_timestamp <= claim_deadline`.
  - **Terminal State Idempotency** (`#726`): Once an action reaches `confirmed`, replaying matching events is a no-op that emits zero side-effects.

---

### 2.3. Quests & Escrow Rewards

- **Boundary**: Off-chain Task Verification $\rightarrow$ Backend Service $\rightarrow$ Escrow / Reward Contract.
- **Abuse Cases**:
  1. *Attestation Forgery*: Attacker generates fake quest completion evidence to claim escrow rewards without completing required tasks.
  2. *Pool Depletion Race Condition*: Multiple users concurrently submit claims against a nearly-exhausted reward pool, causing negative balances or unbacked liabilities.
  3. *Dispute State Manipulation*: Arbitrary transitions between `in_progress`, `disputed`, and `settled` to freeze counterparty funds.
- **Mitigations**:
  - **Dual Verification**: Off-chain evidence validation gates reward issuance, but funds release requires on-chain cryptographic authorization signed by designated grant signers.
  - **Atomic On-Chain Decrement**: The smart contract decrements remaining reward reserves atomically in the same transaction as payout release.
  - **Monotonic State Machine** (`QUEST_DISPUTE_STATE_MACHINE.md`): State transitions are guarded; once an escrow or quest enters `settled` or `refunded`, it cannot re-open.

---

### 2.4. Wallet Flows & Transaction Construction

- **Boundary**: Web dApp $\rightarrow$ `@vaultquest/stellar-wallet-connect` $\rightarrow$ Wallet Extension $\rightarrow$ Horizon RPC.
- **Abuse Cases**:
  1. *Blind Signing Exploits*: Malicious script in browser modifies transaction XDR before passing it to the wallet (e.g. changing contract destination or token recipient).
  2. *Stolen Session Tokens*: Attacker intercepts session bearer tokens to issue administrative or sensitive export actions.
  3. *Session Replay & Nonce Manipulation*: Replaying signed wallet challenge nonces to create unauthorized sessions.
- **Mitigations**:
  - **Decoded Pre-Signing Intent Verification**: The wallet module decodes XDR client-side and validates operation type, destination contract, asset, and amount against user-declared intent before user prompt.
  - **Single-Use Atomic Nonce Consumption** (`#566`): Nonces expire in 5 minutes and are consumed with atomic conditional database updates.
  - **Strict Session Isolation**: Sessions are bound to `(wallet_address, public_key, network)`. Any mismatch aborts authorization.

---

### 2.5. Indexer Reconciliation & Event Ingestion

- **Boundary**: Horizon / Soroban RPC Stream $\rightarrow$ `StellarIndexer` $\rightarrow$ `Reconciler` $\rightarrow$ DB Ledger.
- **Abuse Cases**:
  1. *Rogue Factory Pool Injection*: Attacker deploys a malicious Soroban contract emitting identical `fpooldep` (pool deployed) events to inject fraudulent pools into the application registry.
  2. *Poison Event Stream Denial of Service*: Attacker crafts an unparseable or malformed event on a monitored contract to crash indexer ingestion loops.
  3. *State Drift Divergence*: Internal database diverges from true on-chain ledger due to missing events or network partitions.
- **Mitigations**:
  - **Authoritative Factory Pinning** (`#507`): The indexer only processes `fpooldep` events emitted strictly by `VAULT_FACTORY_ADDRESS`. Events from unapproved contracts are rejected.
  - **Quarantine Isolation & Poison Table** (`#754`): Malformed events are recorded into `PoisonEvent` with error diagnostics and skipped, allowing the indexer cursor to progress uninterrupted.
  - **Continuous On-Chain Drift Detection** (`#752`): `onChainDriftDetector.ts` continuously samples on-chain contract state against database state, raising alarms upon divergence.

---

## 3. High-Risk Operational Edge Cases & Mitigations

| Failure Mode | Root Cause | Impact | Automated Mitigation / Recovery |
| :--- | :--- | :--- | :--- |
| **RPC Network Partition** | Horizon / Soroban RPC node unreachable or returns HTTP 504. | Indexer cursor pauses; actions stay in `submitted` state. | Indexer retries with exponential backoff and jitter; `sweepOrphans` flags actions older than `ORPHAN_TTL_MINUTES` for operator review without dropping state. |
| **Ledger Reorganization** | Temporary 1-2 block rollback on Stellar testnet/standalone network. | Tentative actions become invalid. | `finalityStatus` stays `provisional` until `confirmationDepth >= 2`. Reverted transactions transition to `reverted` status. |
| **Clock Skew / Drift** | Server clock drifts by > 5 minutes relative to Stellar ledger time. | Challenge nonces expire immediately; webhook verification fails. | NTP drift alerts; grace period checks in `timingSafeCompare` and `WebhookService`. |
| **Simultaneous Escrow Claims** | N workers attempt to settle the same escrow payout concurrently. | Risk of double-spend or duplicate transaction broadcast. | Leases (`ActionLease` / `JobLease`) ensure exactly one worker processes an action at a time. |

---

## 4. Rollback & Recovery Procedures

1. **Automated Quarantine**: Any event that violates schema or fails decoding is isolated in `PoisonEvent`. The indexer logs the TOID cursor and continues processing subsequent events.
2. **Reconciliation Dry-Run**: When state drift is detected, operators run `ReconciliationEngine` in dry-run mode to inspect proposed repair steps before applying changes.
3. **Dual-Control Admin Governance**: Mutating actions on live pools or ledger corrections require multi-sig approval (`RepairProposal` + `RepairApproval`), preventing rogue individual operator overrides.
4. **Deterministic Replay Re-seeding**: In disaster recovery scenarios, `resetChainDerivedState` resets mutable tables and `replayEventLog` replays the immutable `ChainEvent` log to restore verified state from the source of truth.
