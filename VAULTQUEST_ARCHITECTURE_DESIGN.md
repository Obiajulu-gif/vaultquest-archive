# VaultQuest Prize Pool Architecture Design
## Integrated Design for Issues #378, #379, #380, #381

### Executive Summary

This document proposes an integrated architecture for the VaultQuest no-loss lottery protocol, addressing four interconnected concerns:
1. **Solvency Invariants** (#378): Formal accounting and reserve management
2. **Verifiable Randomness** (#379): Unbiased, auditable winner selection
3. **Participant Indexing** (#380): Scalable sampling and weighted snapshots
4. **State Machine** (#381): Explicit round lifecycle and transition enforcement

These features must be implemented as a cohesive system to ensure security, correctness, and auditability.

---

## Architecture Overview

### Core Components

```
┌─────────────────────────────────────────────────────────┐
│                    DripPool Contract                     │
├─────────────────────────────────────────────────────────┤
│ State Machine (Issue #381)                              │
│ ├─ Open → Locked → RandomnessPending → Drawn → Claimable
│ └─ Support Cancelled, Settled states for rollover       │
├─────────────────────────────────────────────────────────┤
│ Solvency Invariant (Issue #378)                         │
│ ├─ Principal Liabilities: sum of all deposits           │
│ ├─ Pending Withdrawals: sum of queued claims            │
│ ├─ Yield Reserve: accumulated protocol yield            │
│ ├─ Prize Reserve: next round's prize pool               │
│ └─ Invariant: balance ≥ principal + pending + yield + prize
├─────────────────────────────────────────────────────────┤
│ Participant Index (Issue #380)                          │
│ ├─ Enumerable participant registry with lifecycle       │
│ ├─ Round weight snapshot (locked at round start)        │
│ └─ Bounded, cursor-resumable iteration                  │
├─────────────────────────────────────────────────────────┤
│ Winner Selection (Issue #379)                           │
│ ├─ Randomness beacon or commit-reveal mechanism         │
│ ├─ Domain-separated random with round ID                │
│ └─ Deterministic, auditable selection from weights      │
└─────────────────────────────────────────────────────────┘
```

---

## Issue #378: Formal Solvency Invariant

### Design

**Balance Categories:**
1. **Principal Liabilities** (`principal_outstanding`): Sum of all active deposits
2. **Pending Withdrawals** (`pending_withdrawal_amount`): FIFO queue of locked withdrawal claims
3. **Yield Reserve** (`yield_reserve`): Fee-less yield accumulated by the protocol
4. **Prize Reserve** (`prize_reserve`): Next round's prize pool (locked until drawn)
5. **Protocol Fees** (`fee_reserve`): Accumulated but unclaimed fees

**Invariant:**
```
contract_balance ≥ principal_outstanding + pending_withdrawal_amount + yield_reserve + prize_reserve + fee_reserve
```

### Implementation Strategy

1. **State Tracking:**
   - Track each component as persistent storage keys
   - Update atomically with deposits, withdrawals, yield accrual, and payouts
   - Maintain event log for backend reconciliation

2. **Enforcement Points:**
   - After every deposit: check balance ≥ principal + pending
   - Before every withdrawal: deduct from pending, verify invariant holds
   - Before every fee/yield payout: reserve funds, verify invariant
   - Before every prize draw: lock prize reserve, verify invariant

3. **View Methods (for backend):**
   - `get_balance()` → current contract balance
   - `get_principal_outstanding()` → total active deposits
   - `get_pending_withdrawals()` → locked claim queue amount
   - `get_yield_reserve()` → available yield
   - `get_prize_reserve()` → next round's prize pool
   - `get_solvency_status()` → {balance, obligations, is_solvent}

4. **Failure Handling:**
   - Any operation that would violate invariant panics with clear error
   - Emergency pause mechanism if invariant is breached (circuit breaker)
   - Reconciliation view for independent verification

---

## Issue #379: Verifiable Unbiased Randomness

### Design

**Randomness Source Options** (Soroban-compatible):
1. **Stellar Ledger Randomness** (if available in Soroban): Use ledger hash seeded with round ID
2. **Commit-Reveal Protocol**: 
   - Lock phase: participants/protocol submit commitments (keccak256(secret, round_id))
   - Reveal phase: commitments are revealed, XOR'd together for final randomness
   - Fallback: if reveal fails, use latest ledger hash

**Selection Process:**
```
randomness = H(ledger_hash || round_id || reveal_commitments)
winner_index = randomness % eligible_participant_count
winner = participant_snapshot[winner_index]
```

### Implementation Strategy

1. **Round Binding:**
   - Include immutable round ID in all randomness calculations
   - Domain-separate with string "vaultquest-draw" || round_id
   - Store randomness commitment at lock time

2. **Verification:**
   - Emit event with round_id, randomness, participant_count, winner_index, winner_address
   - Public proof contains: randomness, snapshot, index → verification is deterministic
   - Backend can independently verify: H(snapshot) == snapshot_root, index → winner

3. **Timeout & Fallback:**
   - If commit-reveal phase times out (T_reveal), fall back to ledger hash
   - If still no randomness after (T_timeout), allow admin to retry or cancel
   - Retry uses later ledger hash (not admin-chosen value)

4. **Adversarial Resistance:**
   - No admin, participant, or last revealer can bias beyond the documented model
   - Commit-reveal ensures early commitments lock in randomness seed
   - Ledger-based fallback is outside any actor's control

5. **Test Coverage:**
   - Single participant round (trivial winner, but verify no crash)
   - Withheld reveals: partial commits, test fallback
   - Replay attack: verify same round_id + randomness always gives same winner
   - Round substitution: changing round_id changes randomness deterministically

---

## Issue #380: Scalable Participant Index & Weighted Snapshot

### Design

**Participant Lifecycle:**
- **Active**: participant has deposits > 0
- **Inactive**: participant has requested withdrawal or has 0 balance
- Transitions are one-way per round (state frozen at lock)

**Enumerable Index:**
- Storage: `Participants(index: u32) → Address`
- Count: `ParticipantCount → u32`
- Reverse lookup: `ParticipantIndex(address: Address) → u32`
- Active/inactive flags per round

**Round Weight Snapshot:**
- At round lock: record snapshot of all active participants
- Per participant: `RoundWeights(round_id, index: u32) → weight: i128`
- Snapshot root: `H(round_id, weights_vector)` stored for proof

### Implementation Strategy

1. **Index Management:**
   - On deposit: if new participant, append to index (atomic add if not exists)
   - On withdrawal: mark inactive (don't remove from index, preserve gaps)
   - Cursor-based pagination: iterate from index i to i+PAGE_SIZE

2. **Snapshot Construction (Resumable):**
   ```
   fn snapshot_participants(round_id, cursor: u32) -> (weights, next_cursor, finished) {
       for i in cursor..(cursor + PAGE_SIZE).min(ParticipantCount) {
           if participant[i].is_active_at(round_id) {
               weights.push(participant[i].get_balance())
           }
       }
       (weights, cursor + PAGE_SIZE, cursor + PAGE_SIZE >= ParticipantCount)
   }
   ```

3. **Weight Definition:**
   - Weight = participant's balance at lock time (in basis points of total)
   - Precision: track as i128, normalize to 10^18 scale for arithmetic
   - Cap: no single participant > N% of pool (configurable N, e.g., 10%)

4. **Zero-Balance Handling:**
   - Participants with 0 balance excluded from snapshot
   - If all deposits withdrawn before lock, pool has 0 eligible participants → cancel round

5. **Test Coverage:**
   - Join/leave churn: add/remove participants across rounds
   - Duplicate addresses: ensure each participant counted once
   - Zero balances: verify not included in snapshot
   - Maximum participants: stress test with 10k+ participants
   - Concurrent updates: deposits during snapshot construction

---

## Issue #381: Explicit Prize-Round State Machine

### Design

**Round States:**
```
Open
  ↓ (lock_timestamp reached)
Locked
  ↓ (randomness beacon ready)
RandomnessPending
  ↓ (draw called with randomness)
Drawn (winner selected)
  ↓ (claim or timeout)
Claimable
  ↓ (claim called)
Settled
  ↓ (or timeout expires)
[rollover to next Open round]

Alternatives:
- Locked → Cancelled (if insufficient participants)
- RandomnessPending → Cancelled (if randomness unavailable)
- Claimable → Settled (if timeout expires)
```

### Implementation Strategy

1. **State Tracking:**
   ```rust
   #[contracttype]
   pub enum RoundState {
       Open(u64),        // open until timestamp
       Locked(u32),      // locked, ready for randomness
       RandomnessPending(u32), // waiting for randomness
       Drawn { winner: Address, prize: i128 }, // winner announced
       Claimable { winner: Address, prize: i128 }, // winner can claim
       Settled(u32),     // prize claimed, settling fees
       Cancelled(String), // invalid participants / randomness timeout
   }
   ```

2. **Transition Validation:**
   - Only admin can initiate transitions
   - Verify pre-conditions: `can_transition(current, next)` returns bool
   - Atomically update state and side effects (emit event, lock deposits, etc.)
   - Failed transitions leave state unchanged

3. **Timestamp Boundaries:**
   - Use `env.ledger().timestamp()` consistently (not block numbers)
   - Define T_lock, T_random_pending_max, T_claim_timeout as contract parameters
   - Timeout checks happen on admin call (lazy, not periodic)

4. **Deposit/Weight Freezing:**
   - On transition to Locked: record snapshot of all active participants
   - Deposits/withdrawals after Locked fail (only claimable afterward)
   - Weights immutable for the round

5. **Prize Settlement:**
   - On transition to Settled: transfer prize to winner, accrue fees
   - If winner never claims (timeout), prize returns to yield reserve
   - Exactly one winner per round (enforced by Drawn state)

6. **Safe Rollover:**
   ```
   fn advance_round() {
       match get_round_state(round_id) {
           Settled | Cancelled => {
               round_id += 1
               state = Open(now + ROUND_DURATION)
               reset_deposits_for_new_round()
           }
           _ => panic!("Round not settled or cancelled")
       }
   }
   ```

7. **Test Coverage:**
   - Boundary ledgers: test at T-1, T, T+1 for each transition
   - Retries: calling draw twice in Drawn state should fail
   - Cancellation: verify Cancelled stops all operations
   - Pause: can pause mid-round and resume safely
   - Concurrent operations: deposits while in Locked state should fail

---

## Integration Points

### Cross-Issue Dependencies

**#381 → #378:** State machine enforces when solvency is checked
- Transition to Drawn: verify principal + pending + prize ≤ balance
- Transition to Settled: verify all reserves accounted for

**#381 + #380 → #379:** Randomness input depends on final participant snapshot
- Lock state locks snapshot
- Draw state uses snapshot to select winner from randomness

**#380 ← #378:** Participant index requires principal tracking
- Active/inactive determined by balance (from solvency model)

### Event Emissions

All state transitions emit events for backend reconstruction:
- `RoundOpened(round_id, lock_timestamp)`
- `RoundLocked(round_id, participant_count, total_weight)`
- `RoundRandomnessPending(round_id, timestamp)`
- `WinnerDrawn(round_id, winner, index, randomness)`
- `PrizeClaimed(round_id, winner, amount, fee)`
- `RoundSettled(round_id, fee_accrued)`
- `RoundCancelled(round_id, reason)`

Backend uses these events to independently verify all invariants.

---

## Security Considerations

1. **Reentrancy:** All state mutations happen before external calls (withdrawal transfers)
2. **Overflow:** All arithmetic uses i128 with saturation checks
3. **Access Control:** Only admin can advance state, only participants can deposit/claim
4. **Atomicity:** State transitions are all-or-nothing (Soroban ensures this)
5. **Randomness Bias:** Commit-reveal prevents single-actor bias; ledger hash is outside protocol control

---

## Testing Strategy

### Unit Tests
- State machine transitions (all valid and invalid paths)
- Solvency invariant after each operation
- Weight snapshot construction and pagination
- Randomness generation and winner selection

### State-Machine Tests
- Sequence 100+ random operation sequences, verify invariants hold
- Fuzz: vary participant counts, balances, timeouts
- Adversarial: participants trying to bias randomness, replay attacks

### Integration Tests
- Full round lifecycle: open → lock → draw → claim → settle
- Round rollover with unclaimed prize
- Cancellation and recovery paths
- Multi-round scenarios with changing participant sets

---

## Implementation Phases

1. **Phase 1:** Solvency (#378) + State Machine (#381)
   - Define state model, implement transitions
   - Add solvency checks at each step
   - Test: state-machine coverage, invariant tests

2. **Phase 2:** Participant Indexing (#380)
   - Add enumerable index, snapshot logic
   - Cursor-resumable iteration
   - Test: large participant sets, edge cases

3. **Phase 3:** Randomness (#379)
   - Integrate randomness source (ledger or commit-reveal)
   - Winner selection from snapshot
   - Test: adversarial scenarios, proof verification

4. **Phase 4:** Integration & Audit
   - End-to-end tests across all subsystems
   - Backend reconciliation verify
   - Security audit by external party

---

## Acceptance Criteria Checklist

### Issue #378 (Solvency)
- [ ] Invariant enforced before every payout
- [ ] No action can spend protected principal
- [ ] View methods expose all accounting for reconciliation
- [ ] State-machine tests with 1000+ sequences

### Issue #379 (Randomness)
- [ ] No single actor can bias winner beyond documented model
- [ ] Deterministic: same inputs → same winner
- [ ] Public proof for independent verification
- [ ] Adversarial tests (withheld reveals, replay, timeout)

### Issue #380 (Participant Index)
- [ ] Every eligible participant in snapshot exactly once
- [ ] Deposits/withdrawals after lock frozen for round
- [ ] Cursor-based, resumable snapshot construction
- [ ] Edge cases tested (join/leave churn, zeros, max size)

### Issue #381 (State Machine)
- [ ] Invalid transitions rejected without state change
- [ ] Deposits/weights freeze at lock
- [ ] Exactly one winner per round
- [ ] Boundary ledger tests, timeout tests, rollover tests

---

## Conclusion

These four issues form an integrated system for a secure, auditable no-loss lottery protocol. Implementation should proceed as a cohesive design, with cross-issue testing to verify the invariants hold throughout the round lifecycle.
