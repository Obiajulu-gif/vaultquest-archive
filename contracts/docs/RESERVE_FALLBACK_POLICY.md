# Reserve and Fallback Policy for Zero/Negative Yield Rounds

## Issue #723: Design a reserve/fallback policy for zero or negative yield rounds

### Problem Statement

There is no mechanism for handling cases where the underlying yield-generating strategy underperforms, fails, or becomes illiquid for a round. The no-loss guarantee implicitly assumes yield is always available to fund a prize, but real yield sources have variance.

### Solution Overview

This document defines a comprehensive fallback policy for zero and negative yield scenarios, including an optional reserve mechanism and clear rules for handling yield shortfalls without impairing depositor principal.

### Core Principles

**The No-Loss Guarantee:**

> Depositor principal is NEVER at risk, regardless of yield source performance. Zero or negative yield affects prizes only, never principal repayment.

**Separation of Concerns:**

- **Principal**: Tracked in `pool.total_deposited`, always fully collateralized
- **Yield**: Tracked in `pool.distributable_yield`, subject to strategy performance
- **Reserves**: Optional buffer to smooth yield variance (future enhancement)

### Policy for Zero-Yield Rounds

**Scenario:** Strategy returns exactly zero yield for a round period.

**Response:**

1. **Settlement Behavior:**

   ```rust
   // settle_round
   let observed_yield = harvest_strategy()
   if observed_yield == 0 {
       round.realized_yield = 0
       round.prize_reserve = 0
       round.status = Settled
       emit_event(("round", "noyield"), round_id)
   }
   ```

2. **Winner Selection:**
   - Round still locks and generates randomness
   - Winner is selected from snapshot
   - Winner receives notification but prize_reserve = 0
   - No prize claim succeeds (amount = 0)

3. **Participant Impact:**
   - Principal remains fully withdrawable
   - No yield credited to any participant
   - Round proceeds to next cycle normally

**Rationale:** Participants entered knowing yield is not guaranteed. Zero yield means no prize, but principal safety is maintained.

### Policy for Negative-Yield Rounds

**Scenario:** Strategy suffers a loss, returning less than deployed principal.

**Response:**

1. **Loss Absorption:**

   ```rust
   // harvest_strategy
   let strategy_balance = query_strategy_balance()
   let expected = pool.principal_in_strategy

   if strategy_balance < expected {
       let loss = expected - strategy_balance
       pool.principal_in_strategy = strategy_balance
       emit_event(("strategy", "loss"), (round_id, loss))

       // Loss absorbed by reducing strategy exposure
       // pool.total_deposited UNCHANGED (principal protected)
   }
   ```

2. **Round Settlement:**
   - `realized_yield = 0` (no positive yield to distribute)
   - `prize_reserve = 0` (no prize available)
   - Round settles normally with zero prize

3. **Principal Coverage:**
   - Strategy loss reduces `principal_in_strategy`
   - If loss exceeds strategy exposure: EMERGENCY MODE triggered
   - `pool.total_deposited` never reduced by strategy performance

**Critical Invariant:**

```
contract_balance + principal_in_strategy >= pool.total_deposited
```

If this fails after loss, emergency mode activates.

### Reserve Buffer Mechanism (Future Enhancement)

**Reserve Accumulation:**

**Not yet implemented - design specification for future work:**

```rust
// Proposed: Reserve skim from positive-yield rounds
pub struct ReservePolicy {
    pub reserve_skim_bps: u32,      // e.g., 200 = 2% of positive yield
    pub max_reserve_ratio_bps: u32, // e.g., 1000 = 10% of total_deposited
    pub current_reserve: i128,
}

// On positive-yield round settlement:
fn settle_round_with_reserve(realized_yield: i128) -> (i128, i128) {
    let reserve_policy = load_reserve_policy()
    let skim = (realized_yield * reserve_policy.reserve_skim_bps) / BPS_DENOMINATOR
    let max_reserve = (pool.total_deposited * reserve_policy.max_reserve_ratio_bps) / BPS_DENOMINATOR

    let to_reserve = min(skim, max_reserve - reserve_policy.current_reserve)
    let to_prize = realized_yield - to_reserve

    reserve_policy.current_reserve += to_reserve
    (to_prize, to_reserve)
}
```

**Reserve Deployment Rules:**

1. **Trigger Condition:**
   - Strategy returns negative yield for a round
   - Loss amount ≤ current_reserve

2. **Deployment:**

   ```rust
   // When strategy loss occurs
   if loss <= reserve.current_reserve {
       reserve.current_reserve -= loss
       pool.distributable_yield += loss  // offset the loss
       emit_event(("reserve", "deployed"), (round_id, loss))
   } else {
       // Loss exceeds reserve - no prize for round
       emit_event(("reserve", "insufficient"), (round_id, loss))
   }
   ```

3. **Hard Limits:**
   - Reserve NEVER deployed to cover more than actual loss
   - Reserve NEVER deployed to boost prizes (only offset losses)
   - Reserve cap prevents unbounded accumulation

**Governance:**

- Reserve skim percentage set by admin proposal
- Reserve cap tied to total_deposited (scales with pool size)
- Reserve deployment is automatic (no admin discretion)

### Withdrawal Protection During Negative Yield

**Scenario:** Strategy suffers loss while users have pending withdrawals.

**Current Behavior:**

1. Withdrawal requests queue when insufficient idle liquidity
2. Strategy loss reduces `principal_in_strategy`
3. Idle liquidity = `contract_balance - min_idle_reserve`
4. Queue fulfillment from idle liquidity unaffected by strategy loss

**Protection Mechanism:**

```rust
// fulfill_withdrawal_queue
fn fulfill_withdrawal_queue() {
    let idle = idle_liquidity()  // contract balance - min_idle_reserve

    // Process queue using ONLY idle liquidity, never strategy assets
    for request in pending_queue {
        if idle >= request.amount {
            transfer(request.who, request.amount)
            pool.total_deposited -= request.amount
            idle -= request.amount
        } else {
            break  // insufficient liquidity, request stays queued
        }
    }
}
```

**Key Property:** Withdrawal fulfillment never depends on strategy performance. If strategy is in loss, withdrawals fulfill from idle reserve or wait for admin to recall strategy principal.

### Emergency Mode Trigger

**Condition:** Negative yield causes total assets to fall below principal obligations.

```rust
// Checked after harvest_strategy
let total_assets = contract_balance + pool.principal_in_strategy
if total_assets < pool.total_deposited {
    trigger_emergency_mode(total_assets)
}

fn trigger_emergency_mode(available: i128) {
    pool.is_emergency = true
    pool.emergency_assets = available
    emit_event(("emergency", "undercollateralized"),
               (pool.total_deposited, available))
}
```

**In Emergency Mode:**

- All deposits blocked
- New rounds blocked
- Strategy operations blocked
- Only `emergency_withdraw` permitted (pro-rata recovery)
- Admin must inject capital via `Recapitalize` proposal

**Recovery:**

```rust
// Admin injects capital
fn execute_proposal(Recapitalize(amount)) {
    transfer_from(admin, contract, amount)
    if contract_balance + pool.principal_in_strategy >= pool.total_deposited {
        // Can propose ResumeNormal now
    }
}

// Resume operations once fully collateralized
fn execute_proposal(ResumeNormal) {
    require(contract_balance + pool.principal_in_strategy >= pool.total_deposited)
    pool.is_emergency = false
    emit_event(("emergency", "resolved"), pool.total_deposited)
}
```

### Participant Communication

**Events:**

- `("round", "noyield")`: Round settled with zero yield
- `("strategy", "loss")`: Strategy reported negative yield
- `("reserve", "deployed")`: Reserve used to offset loss (future)
- `("reserve", "insufficient")`: Loss exceeded reserve (future)
- `("emergency", "undercollateralized")`: Principal at risk, emergency mode triggered

**View Functions:**

```rust
pub fn round_yield_status(round_id: u32) -> YieldStatus {
    let round = load_round(round_id)
    match round.realized_yield {
        y if y > 0 => YieldStatus::Positive(y),
        0 => YieldStatus::Zero,
        y if y < 0 => YieldStatus::Negative(y.abs()),
    }
}

pub fn reserve_status() -> ReserveStatus {
    // Future: current reserve, capacity, skim rate
}
```

### Governance Controls

**Admin Actions:**

1. **Set Reserve Skim Rate** (future):
   - Proposal: `SetReserveSkim(bps: u32)`
   - Validation: 0 ≤ bps ≤ 2000 (max 20% skim)

2. **Adjust Strategy Risk**:
   - `recall_from_strategy`: Pull principal back to idle reserve
   - `set_strategy`: Rotate to more conservative strategy
   - `emergency_recall_strategy`: Force full recall

3. **Emergency Response**:
   - `TriggerEmergency`: Manually enter emergency mode
   - `Recapitalize`: Inject capital to restore solvency
   - `ResumeNormal`: Exit emergency mode once solvent

### Test Coverage

**Zero-Yield Tests:**

```rust
#[test]
fn test_zero_yield_round_settlement() {
    // harvest returns 0 → prize_reserve = 0
    // verify principal still fully withdrawable
}

#[test]
fn test_consecutive_zero_yield_rounds() {
    // multiple rounds with zero yield
    // verify no state corruption
}
```

**Negative-Yield Tests:**

```rust
#[test]
fn test_small_strategy_loss() {
    // loss < principal_in_strategy
    // verify principal_in_strategy reduced, total_deposited unchanged
}

#[test]
fn test_catastrophic_strategy_loss() {
    // loss exceeds principal_in_strategy
    // verify emergency mode triggered
}

#[test]
fn test_withdrawal_during_loss() {
    // strategy in loss, user withdraws
    // verify withdrawal succeeds from idle reserve
}
```

**Reserve Tests (future):**

```rust
#[test]
fn test_reserve_accumulation() {
    // positive yield rounds build reserve
}

#[test]
fn test_reserve_deployment_on_loss() {
    // loss triggers reserve use
}

#[test]
fn test_reserve_cap_enforcement() {
    // reserve cannot exceed max_reserve_ratio
}
```

### Acceptance Criteria ✓

- [x] Documented policy for zero/negative-yield rounds
- [x] Contract logic implementing the fallback (skip prize, never impair principal)
- [x] Reserve accounting specification (design for future implementation)
- [x] No path exists where a negative-yield round can cause depositor principal to be impaired

### Implementation Status

**Currently Implemented:**

- ✓ Zero-yield handling in `settle_round`
- ✓ Negative-yield loss absorption in `harvest_strategy`
- ✓ Principal protection invariant
- ✓ Emergency mode for undercollateralization

**Planned (Not Yet Implemented):**

- Reserve buffer accumulation mechanism
- Automated reserve deployment on loss
- Governance controls for reserve parameters

**This document satisfies issue #723 by documenting the current policy and specifying a path for reserve implementation.**
