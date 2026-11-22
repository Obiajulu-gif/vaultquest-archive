# Adversarial & Malformed External Payload Fixture Corpus

This directory contains the golden fixture corpus for malformed external payloads and adversarial records in VaultQuest (#919). It establishes regression baselines and fuzzing vectors against edge-case inputs from untrusted clients, rogue RPC sources, compromised webhooks, and tampered transactions.

## Corpus Taxonomy

| Fixture File | Scenario Category | Threat Vector Protected Against |
| :--- | :--- | :--- |
| [`invalid-signatures.json`](./invalid-signatures.json) | Invalid & Forged Signatures | Ed25519 forgery, cross-account signature reuse, payload tampering after signing, and forged webhook HMAC signatures. |
| [`missing-fields.json`](./missing-fields.json) | Missing Mandatory Fields | Incomplete action intents, missing pool IDs, stripped transaction hashes, and incomplete webhook deliveries. |
| [`oversized-values.json`](./oversized-values.json) | Arithmetic & Payload Overflow | Int128/Uint128 overflow attempts, negative minor-unit values, memory exhaustion strings (DoS), and deep recursive JSON bombs. |
| [`replays.json`](./replays.json) | Replays & Stale Payloads | Expired SEP-0010 wallet challenges, replayed webhook calls exceeding the 300s clock-skew tolerance, conflicting idempotency key mutations, and duplicate on-chain event deliveries. |
| [`schema-drift.json`](./schema-drift.json) | Versioning & Schema Drift | Deprecated field lifecycle handling, unsupported ancient schema versions (`<0.9.0`), forward-incompatible versions (`>=2.0.0`), prototype pollution attacks, and unauthorized enum variants. |

## Provenance & Threat Context

1. **Stellar Wallet Auth (SEP-0010)**: Signatures are verified using cryptographic Ed25519 verification over domain-separated server challenges. Signatures must match the claimed public key, and challenges expire within strict TTL windows.
2. **Soroban Smart Contract Events**: Ingested events undergo strict decoding where amounts are constrained to non-negative 128-bit unsigned integers. Floating-point representations and exponential notation are rejected at the edge.
3. **Action Ledger Idempotency**: Identical idempotency keys with identical payloads return the stable pre-existing record without side effects. Reusing an idempotency key with an altered payload or destination fails authoritatively.
4. **Data Versioning Compatibility**: Persisted domain entities enforce bidirectional compatibility through `recordCompatibility.ts` — deprecated fields (such as `commission`) are safely dropped on upgrade, while unknown schema versions reject before storage corruption.

## Automated Verification

Run the corpus test suite:

```bash
cd backend
pnpm test tests/adversarial-payloads.spec.ts
```

The test runner asserts that:
- Every fixture in the corpus is consumed and processed by its targeted domain validator.
- Malformed payloads fail with deterministic, user-safe, typed error codes.
- No malicious prototype property or memory bomb leaks into global or instance scope.
- Replayed and duplicate events preserve exactly-once semantics without unintended side-effects.

## Operational Edge Cases & Failure Modes

1. **Clock Skew on Webhooks & Challenges**:
   - *Failure Mode*: Legitimate client requests fail with `CHALLENGE_EXPIRED` or `WEBHOOK_TIMESTAMP_OUT_OF_RANGE` if server NTP drifts by > 300 seconds.
   - *Mitigation*: The backend logs structured warnings with measured skew milliseconds. NTP daemon synchronization is enforced in production runbooks.
2. **Replayed On-Chain Events During Chain Reorgs**:
   - *Failure Mode*: Network reorganizations re-emit identical transaction hashes at different ledger sequence numbers.
   - *Mitigation*: `LedgerService.reconcileEvent` checks existing `txHash` and terminal status; if already confirmed, the event safely no-ops without double-crediting balances.
3. **Partial Payload Deserialization**:
   - *Failure Mode*: Very large payloads or payloads with 100+ nested levels cause Node.js V8 call-stack limits or high memory usage.
   - *Mitigation*: Fastify payload limits (`bodyLimit`) and `safeContent` max-depth bounds reject deeply nested payloads before reaching business services.

## Rollback & Recovery Procedures

If malformed or adversarial records ever bypass edge filters (e.g. via direct database corruption or operator error):
1. **Quarantine**: The reconciliation engine (`reconciler.ts`) automatically moves conflicting records to `RepairQuarantine`.
2. **Poison Event Tagging**: Events that fail parsing are logged in `PoisonEvent` with the raw payload, preventing consumer thread deadlocks.
3. **Dual-Control Repair**: Operators use `RepairProposal` and `RepairApproval` to apply audited, two-person rollback steps as documented in `docs/RECONCILIATION.md`.
