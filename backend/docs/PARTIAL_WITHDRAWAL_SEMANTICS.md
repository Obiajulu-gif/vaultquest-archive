# Partial Withdrawal Semantics for Round Ticket Weight (#725)

## Executive Summary

This document specifies the behavior of partial withdrawals during and between prize rounds, defining how withdrawals affect ticket weight for in-progress rounds versus future rounds. The design prevents ticket-weight gaming while maintaining fair pro-rata prize distribution.

## Problem Statement

The VaultQuest protocol supports:

1. **Full principal custody**: Users can withdraw deposited funds
2. **Round-based lotteries**: Deposits earn ticket weight for prize draws
3. **Time-weighted tickets**: Ticket weight decays with late deposits (#719)

**Unspecified behavior**:

- Does a mid-round partial withdrawal reduce current-round ticket weight?
- Can users repeatedly withdraw/redeposit to game ticket allocation?
- What happens to yield for partially withdrawn funds?

## Design Principles

### 1. **Snapshot Immutability**

Once a round is **Locked**, all ticket weights are frozen. No deposit, withdrawal, or balance change affects that round's draw.

**Rationale**: Draw integrity requires deterministic ticket assignment. Post-lock mutations would allow manipulation after randomness is committed.

### 2. **Pre-Lock Withdrawals Reduce Future Weight**

Withdrawals during the **Open** phase reduce the participant's cumulative round deposit for the current round, proportional to time remaining.

**Rationale**: Users who withdraw capital should lose ticket weight proportional to time-not-exposed to the round's risk.

### 3. **Yield Is Separable from Principal**

Yield accrues independently of round deposits and is claimable separately via `claim_reward`. Withdrawals only affect principal-backed ticket weight.

**Rationale**: Separating yield from principal prevents accounting confusion and ensures yield distribution is admin-controlled, not automatically distributed via withdrawals.

## Semantic Rules

### Rule 1: Round Lifecycle States

| Round State | Deposits Allowed   | Withdrawals Allowed           | Ticket Weight Mutable |
| ----------- | ------------------ | ----------------------------- | --------------------- |
| **Open**    | ✅ `round_deposit` | ✅ `withdraw`                 | ✅ Yes                |
| **Locked**  | ❌ Rejected        | ❌ Rejected                   | ❌ Frozen             |
| **Settled** | ❌ Rejected        | ✅ `withdraw` + `round_claim` | ❌ Frozen             |

### Rule 2: Pre-Lock Withdrawal Impact

**Scenario**: User deposits 100 XLM at round open (T=0), then withdraws 40 XLM mid-round at T=3 days (round duration: 7 days).

**Current Round (Open)**:

```
Initial deposit: 100 XLM at T=0 → weight = 100 × 1.0 = 100 tickets
Withdrawal: 40 XLM at T=3 days
  - Time-weighted adjustment: 40 × (4 days remaining / 7 days) ≈ -22.86 tickets
  - Net weight: 100 - 22.86 ≈ 77.14 tickets
Remaining principal: 60 XLM
```

**Next Round**:

- User's new deposits start from their current principal balance (60 XLM)
- No carryover of previous round's ticket weight

### Rule 3: Post-Lock Withdrawal Prohibition

**During Locked or Settled rounds**:

- All `withdraw` calls revert with `Error::RoundNotOpen`
- Users must wait until the round settles and is archived
- Exception: `round_claim` is allowed in Settled state to claim yield/prize

**Rationale**: Prevents withdrawal-after-randomness attacks where a user could withdraw principal after learning they did not win.

### Rule 4: Yield Claim Independence

**Yield claiming** (`claim_reward`) is independent of principal withdrawal:

- Yield is credited by admins via `credit_yield` based on realized strategy returns
- Users can claim accumulated yield without withdrawing principal
- Withdrawals do not auto-distribute yield—users must explicitly claim

**Accounting**:

```
Participant {
    deposited: i128,           // principal (affects ticket weight)
    yield_accrued: i128,       // realized yield (claimable via claim_reward)
    prize: i128,               // prize winnings (claimable via round_claim)
    claimed_reward: i128,      // cumulative claimed yield + prize
    withdrawn_principal: i128, // cumulative withdrawn principal
}
```

### Rule 5: Repeated Withdraw/Redeposit Prevention

**Attack vector**: User repeatedly cycles funds out and in to reset time-weighting.

**Mitigation**: Time-weighting is applied at the **deposit timestamp**, not cumulative balance:

```rust
// Pseudo-code for round_deposit
let elapsed = env.ledger().timestamp() - round.opened_at;
let time_factor = max(
    ROUND_MIN_TICKET_WEIGHT_BPS / 10000,
    (ROUND_TICKET_WEIGHT_WINDOW - elapsed) / ROUND_TICKET_WEIGHT_WINDOW
);
let ticket_weight = amount × time_factor;

// Add to participant's RoundDeposit
round_deposit += ticket_weight; // Cumulative, not overwritten
```

**Result**: Each redeposit receives diminished weight based on current round time, so cycling funds provides no edge.

### Rule 6: Withdrawal to Exactly Zero

**Edge case**: User withdraws entire balance during Open round.

**Behavior**:

1. Participant's `RoundDeposit(address, round_id)` is reduced to zero
2. Participant is excluded from snapshot at round lock
3. Participant's `Participant` record is **not deleted** (preserves `yield_accrued` and `prize` for future claims)
4. Future deposits create new `round_deposit` entries

**Test coverage**:

```rust
#[test]
fn test_withdraw_to_zero_then_redeposit() {
    // Deposit 100 at T=0, withdraw 100 at T=3, redeposit 50 at T=5
    // Assert: redeposit gets time-weighted at T=5, no carryover from T=0
}
```

## Current Implementation Status

### ✅ Implemented

- **Round lifecycle enforcement** (`RoundStatus::Open`, `Locked`, `Settled`)
- **Snapshot immutability** (ticket weights frozen at `lock_round`)
- **Time-weighted tickets** (`ROUND_TICKET_WEIGHT_WINDOW_SECONDS`)
- **Yield independence** (separate `yield_accrued` and `prize` fields)

### ⚠️ Partially Implemented

**Withdrawal during Open round**:

- Current `withdraw` function operates on `Participant.deposited` (global principal)
- Does NOT automatically adjust `RoundDeposit(address, current_round_id)`
- **Gap**: Mid-round withdrawals do not reduce current-round ticket weight

### ❌ Not Implemented

**Explicit withdrawal-round interaction**:

- No function to withdraw principal while preserving yield claim rights
- No test coverage for mid-round partial withdraw then redeposit

## Recommended Implementation

### Change 1: Withdraw from Round Deposit

Add a new entrypoint: `withdraw_from_round`:

```rust
pub fn withdraw_from_round(
    env: Env,
    who: Address,
    amount: i128,
) -> Result<(), Error> {
    who.require_auth();

    let mut pool = get_pool(&env)?;
    let round_id = get_active_round_id(&env)?;
    let round = get_round(&env, round_id)?;

    // Only allow withdrawals during Open rounds
    if round.status != RoundStatus::Open {
        return Err(Error::RoundNotOpen);
    }

    let mut participant = load_participant(&env, &who)?;
    let mut round_deposit = env.storage()
        .persistent()
        .get(&DataKey::RoundDeposit(who.clone(), round_id))
        .unwrap_or(0);

    // Validate amount
    if amount <= 0 || amount > participant.deposited {
        return Err(Error::InvalidAmount);
    }

    // Reduce round deposit proportionally by time remaining
    let elapsed = env.ledger().timestamp() - round.opened_at;
    let time_remaining = ROUND_TICKET_WEIGHT_WINDOW_SECONDS.saturating_sub(elapsed);
    let time_factor = time_remaining as i128 * 10000 / ROUND_TICKET_WEIGHT_WINDOW_SECONDS as i128;

    let ticket_reduction = amount * time_factor / 10000;
    round_deposit = round_deposit.saturating_sub(ticket_reduction);

    // Update participant principal
    participant.deposited = participant.deposited.saturating_sub(amount);
    participant.withdrawn_principal += amount;

    // Persist
    save_participant(&env, &who, &participant);
    env.storage().persistent().set(
        &DataKey::RoundDeposit(who.clone(), round_id),
        &round_deposit
    );

    // Transfer tokens
    transfer_tokens(&env, &who, amount)?;

    emit_event(&env, "withdraw_from_round", (who, amount, round_id, ticket_reduction));
    Ok(())
}
```

### Change 2: Document Legacy `withdraw` Behavior

The existing `withdraw` function should be documented as:

```rust
/// Withdraw principal outside of any active round.
/// Reverts if called during an Open round with non-zero RoundDeposit.
/// Use `withdraw_from_round` to withdraw mid-round.
pub fn withdraw(env: Env, who: Address, amount: i128) -> Result<(), Error>
```

### Change 3: Prevent Withdraw-Then-Win Exploit

**Attack**: User deposits early, waits until randomness is revealed, then withdraws if they didn't win.

**Mitigation**: Already prevented by `RoundStatus::Locked` check. Once locked, withdrawals are disabled until settlement.

## Test Coverage

### Unit Tests

```rust
#[test]
fn test_partial_withdraw_reduces_ticket_weight() {
    // Deposit 100 at T=0, withdraw 40 at T=3 days
    // Assert: round_deposit reduced by ≈23 tickets
}

#[test]
fn test_withdraw_during_locked_round_fails() {
    // Lock round, attempt withdraw
    // Assert: Error::RoundNotOpen
}

#[test]
fn test_withdraw_to_zero_then_redeposit() {
    // Withdraw entire balance mid-round, redeposit later
    // Assert: redeposit gets fresh time-weighting, no carryover
}

#[test]
fn test_repeated_withdraw_redeposit_no_advantage() {
    // Cycle funds 10 times within one round
    // Assert: cumulative ticket weight ≤ single full-round deposit
}

#[test]
fn test_yield_claim_independent_of_withdrawal() {
    // Withdraw 50% principal, claim yield
    // Assert: yield_accrued unaffected by withdrawal
}

#[test]
fn test_withdraw_after_round_settle() {
    // Settle round, then withdraw
    // Assert: withdrawal succeeds, round_claim still available
}
```

### Integration Tests

```rust
#[test]
fn test_full_round_lifecycle_with_withdrawals() {
    // 1. Open round, user A deposits 100
    // 2. T=3 days, user A withdraws 40
    // 3. Lock round, snapshot weights
    // 4. Settle round, user A claims prize
    // 5. User A withdraws remaining 60
    // Assert: all invariants hold
}
```

## Edge Cases

### Case 1: Withdraw During Round Transition

**Scenario**: Round N is Settled, Round N+1 is not yet opened. User withdraws.

**Behavior**:

- Withdrawal succeeds (no active Open round to affect)
- User's principal balance reduces for future rounds
- Past round's settled claims remain available

### Case 2: Withdraw from Multiple Rounds

**Scenario**: User has deposits in Round N (Locked) and Round N+1 (Open). User withdraws.

**Behavior**:

- `withdraw_from_round` targets the currently Open round (N+1)
- Round N's tickets are frozen and unaffected
- User must specify which round to withdraw from (or default to active)

### Case 3: Withdraw More Than Round Deposit

**Scenario**: User has 100 XLM principal, but only 60 XLM in current round deposit. User requests 80 XLM withdrawal.

**Behavior**:

- Withdrawal reduces round deposit by 60 XLM (max available)
- Remaining 20 XLM reduces global principal but does not affect current round
- Alternative: Revert with `Error::InsufficientRoundDeposit` to force explicit round accounting

**Recommendation**: Use explicit accounting—require users to withdraw from specific rounds or specify "withdraw from global principal only."

## Migration Path

### For Existing Contracts

If the contract is already deployed without explicit mid-round withdrawal logic:

1. **Document current behavior**: Withdrawals affect only `Participant.deposited`, not `RoundDeposit`
2. **Add new entrypoint**: `withdraw_from_round` as described above
3. **Deprecate legacy `withdraw`**: Mark as "withdraw outside of active rounds only"
4. **Frontend guidance**: Prompt users to use `withdraw_from_round` during Open rounds

### Backward Compatibility

**Old behavior (legacy `withdraw`)**:

- Withdrawals do not affect current round tickets
- Can lead to over-weighted tickets if users withdraw after depositing but before lock

**New behavior (`withdraw_from_round`)**:

- Withdrawals proportionally reduce current round tickets
- Prevents ticket-weight gaming

**Compatibility strategy**: Maintain both entrypoints, document when to use each.

## Acceptance Criteria

- [x] Documented rule for how partial withdrawals affect current-round vs. next-round ticket weight
- [x] Design prevents repeated withdraw/redeposit gaming
- [x] Edge cases specified (withdraw to zero, mid-round cycles, yield independence)
- [x] Test coverage specified for all scenarios
- [ ] Implementation of `withdraw_from_round` (pending)
- [ ] Regression test suite (pending)

---

**Document Version**: 1.0  
**Last Updated**: 2026-09-28  
**Related Issues**: #725, #719, #724  
**Implementation Status**: Specification complete, implementation pending
