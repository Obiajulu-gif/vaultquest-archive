# Transition Invariants (Balance, Ownership, Entitlement)

## Overview
VaultQuest manages critical cryptographic and financial state: vault deposits, participant balances, yield distribution, prize claims, and asset ownership. To guarantee state integrity and prevent exploit classes such as double-claims, unauthorized reassignments, balance inflation, or negative balances, `TransitionInvariantService` introduces deterministic pre- and post-condition assertions across all state mutations.

---

## Invariant Categories

### 1. Balance Invariants
- **Conservation of Balance (`CONSERVATION_OF_BALANCE`)**: In any ledger transfer, exchange, or disbursement, the sum of debits must strictly equal the sum of credits plus any network or protocol fees:
  $$\sum \text{debits} == \sum \text{credits} + \text{fee}$$
  Every debit, credit, and fee component must be non-negative ($>= 0$).
- **Non-Negative Balances (`NON_NEGATIVE_BALANCE`)**: Account, position, and pool balances can never drop below zero.
- **Pool Capacity Bounds (`POOL_CAP_BOUND`)**: A deposit cannot cause total pool deposits to exceed the configured maximum cap.
- **Liquidity Solvency (`LIQUIDITY_SOLVENCY`)**: Total requested withdrawals cannot exceed the currently available pool liquidity.

### 2. Ownership Invariants
- **Single Owner Principle (`SINGLE_OWNER_PRINCIPLE`)**: A vault, position, or controlled resource must have exactly one confirmed owner at any time. Ambiguous or multi-headed ownership states are prohibited.
- **Authorized Ownership Initiator (`AUTHORIZED_OWNERSHIP_INITIATOR`)**: Only the current confirmed owner (or an explicit multi-sig administrative bypass) can initiate an ownership reassignment.
- **Valid Ownership Target (`VALID_NEW_OWNER`)**: Ownership cannot transition to an empty/null address, a zero address, or an invalid Stellar public key.
- **Distinct Target (`DISTINCT_OWNERSHIP_TARGET`)**: Self-transfer loops that redundantly assign an owner to itself are rejected.

### 3. Entitlement Invariants
- **Anti-Double-Claim (`ANTI_DOUBLE_CLAIM`)**: A prize, quest reward, or yield entitlement can only be claimed once. Re-claiming an already claimed entitlement is rejected.
- **Beneficiary Match (`BENEFICIARY_MATCH`)**: Only the designated beneficiary can claim the allocated entitlement.
- **Claim Expiry (`CLAIM_DEADLINE_NOT_PASSED`)**: Claims attempted after the entitlement deadline are rejected.
- **Entitlement Bound (`ENTITLEMENT_CAP_BOUND`)**: The claimed amount must be positive and bounded by the allocated entitlement amount.
- **Lifecycle Transitions (`VALID_STATUS_TRANSITION`)**: Entitlements follow a strict one-way state machine:
  $$\text{pending} \rightarrow \text{eligible} \rightarrow \text{claimed}$$
  $$\text{pending} / \text{eligible} \rightarrow \text{expired} / \text{forfeited}$$
  Terminal states (`claimed`, `expired`, `forfeited`) cannot transition backwards.

---

## Error Contract & Failure Handling
When an invariant fails, an `InvariantViolationError` (HTTP 409 Conflict) is thrown:
```json
{
  "error": {
    "code": "BALANCE_INVARIANT_VIOLATION",
    "category": "conflict",
    "message": "Balance conservation violated: total debits (1000) does not match credits + fee (950)",
    "retryable": false,
    "recovery": "Ensure sufficient funds and that the operation preserves balance conservation.",
    "status_code": 409,
    "details": {
      "category": "balance",
      "rule": "CONSERVATION_OF_BALANCE",
      "expected": "950",
      "actual": "1000"
    }
  }
}
```
Any transaction violating an invariant is automatically rolled back, preserving cryptographic and ledger integrity.
