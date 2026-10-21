# No-Loss Principal Safety Invariant

## Issue #720: Formalize and enforce the no-loss principal-safety invariant across yield distribution

### Problem Statement

The vault must guarantee that every depositor can withdraw their full principal at any time. However, there is no documented accounting model showing how principal, in-flight yield, and already-awarded prizes are tracked separately to ensure withdrawals never leave the vault unable to honor remaining depositors' principal.

### Solution Overview

This document formalizes the principal-safety invariant, defines the accounting categories, and specifies enforcement points throughout the contract lifecycle.

### Core Invariant

**The Fundamental Guarantee:**

```
contract_balance >= sum_of_all_principal + pending_withdrawals + locked_reserves
```

Where:

- `contract_balance`: Actual token balance held by contract + `principal_in_strategy`
- `sum_of_all_principal`: `pool.total_deposited` (sum of all `Participant.deposited`)
- `pending_withdrawals`: Sum of all queued `WithdrawalRequest.amount`
- `locked_reserves`: Reserved for settled but unclaimed prizes in rounds

### Accounting Categories

#### 1. Principal Liabilities

**Tracked as:** `pool.total_deposited` (instance storage)
**Semantics:** Sum of all active `Participant.deposited` amounts
**Mutations:**

- Incremented on `deposit`, `round_deposit`
- Decremented on `withdraw`, `fulfill_withdrawal_queue`
- Never reduced by yield operations

#### 2. Yield Reserves

**Tracked as:** `pool.distributable_yield` (instance storage)
**Semantics:** Realized yield available for credit to participants or prizes
**Mutations:**

- Incremented by `add_yield` (admin transfers yield to contract)
- Incremented by `harvest_strategy` (realized gains)
- Decremented by `credit_yield` (admin credits to participant)
- Decremented by prize allocation in `settle_round`
  **Key Property:** Yield is SEPARATE from principal; yield shortfalls never impair principal

#### 3. In-Flight Strategy Assets

**Tracked as:** `pool.principal_in_strategy` (instance storage)
**Semantics:** Principal currently deployed to yield strategy
**Mutations:**

- Incremented by `deploy_to_strategy`
- Decremented by `recall_from_strategy`
- Reconciled by `harvest_strategy`
  **Key Property:** Counts toward total assets for solvency checks

#### 4. Pending Withdrawal Queue

**Tracked as:** Per-request `WithdrawalRequest.amount` (persistent storage)
**Semantics:** Principal claims queued when insufficient idle liquidity
**Mutations:**

- Created by `withdraw` when `idle_liquidity < requested_amount`
- Fulfilled by `fulfill_withdrawal_queue` as liquidity becomes available
- Cancelled by `cancel_withdrawal_request`
  **Key Property:** Represents pending principal obligations

#### 5. Round Prize Reserves

**Tracked as:** `Round.prize_reserve` per round (persistent storage)
**Semantics:** Yield locked for specific round's prize distribution
**Mutations:**

- Set once at `settle_round` from `pool.distributable_yield`
- Claimed via `round_claim`
- Tracked separately as `Round.claimed` to prevent double-claims
  **Key Property:** Prize comes from yield, never from principal

### Enforcement Points

#### At Deposit

```rust
// deposit, round_deposit
pool.total_deposited += amount
participant.deposited += amount
// Precondition: tokens already transferred to contract
// Postcondition: total_deposited never exceeds actual balance
```

#### At Withdrawal

```rust
// withdraw, emergency_withdraw
if idle_liquidity >= principal_amount {
    pool.total_deposited -= principal_amount
    participant.deposited -= principal_amount
    transfer_tokens(participant, principal_amount)
} else {
    enqueue_withdrawal_request(participant, principal_amount)
}
// Invariant: principal_outstanding always matches active deposits
```

#### At Yield Credit

```rust
// credit_yield
if amount > pool.distributable_yield {
    return Err(InvalidAction)
}
pool.distributable_yield -= amount
participant.yield_accrued += amount
// Invariant: never credit yield that doesn't exist
```

#### At Round Settlement

```rust
// settle_round
let prize = min(target_prize, pool.distributable_yield)
pool.distributable_yield -= prize
round.prize_reserve = prize
round.realized_yield = observed_yield
// Invariant: prize never exceeds available yield
```

#### At Strategy Operations

```rust
// deploy_to_strategy
if idle_liquidity - amount < min_idle_reserve {
    return Err(InsufficientIdleReserve)
}
pool.principal_in_strategy += amount
// Invariant: maintain minimum idle buffer for withdrawals

// harvest_strategy
let (gain, loss) = strategy.reconcile()
pool.distributable_yield += gain
pool.principal_in_strategy -= loss
// Invariant: losses reduce strategy exposure, not depositor principal
```

### Zero/Negative Yield Handling

**Scenario:** Strategy returns zero or negative yield for a round.

**Policy:**

1. **Zero yield**: Round settles with `prize_reserve = 0`; no winner selected
2. **Negative yield (loss)**: Loss is absorbed by reducing `principal_in_strategy`
3. **Principal protection**: `pool.total_deposited` is NEVER reduced by strategy losses
4. **Reserve buffer**: See `RESERVE_FALLBACK_POLICY.md` for reserve mechanism

**Enforcement:**

```rust
// harvest_strategy
if strategy_balance < pool.principal_in_strategy {
    let loss = pool.principal_in_strategy - strategy_balance
    pool.principal_in_strategy = strategy_balance
    emit_event(("strategy", "loss"), loss)
}
```

### Solvency Check Function

**View method for off-chain verification:**

```rust
pub fn get_solvency_status(env: Env) -> SolvencyStatus {
    let pool = load_pool(env)?
    let balance = get_token_balance(env)
    let total_assets = balance + pool.principal_in_strategy
    let pending_withdrawals = sum_pending_withdrawal_requests(env)
    let locked_prizes = sum_unsettled_prize_reserves(env)

    SolvencyStatus {
        total_assets,
        principal_outstanding: pool.total_deposited,
        pending_withdrawals,
        locked_prizes,
        idle_liquidity: total_assets - pool.principal_in_strategy,
        is_solvent: total_assets >= pool.total_deposited + pending_withdrawals + locked_prizes
    }
}
```

### Emergency Mode

**Trigger:** If `contract_balance < pool.total_deposited` (principal undercollateralization)

**Response:**

1. Set `pool.is_emergency = true`
2. Record `pool.emergency_assets` = current balance
3. Block all deposits, new rounds, strategy operations
4. Enable `emergency_withdraw` for pro-rata principal recovery
5. Emit `("emergency", "triggered")` event

**Recovery:**

- Admins inject capital via `Recapitalize` proposal
- Once `balance >= total_deposited`, `ResumeNormal` proposal restores operations

### Test Coverage

Property-based tests (fuzzing) with 1000+ sequences:

1. **Deposit → Withdraw sequence**: Principal fully recoverable at every step
2. **Concurrent operations**: Multiple deposits/withdrawals never violate invariant
3. **Strategy loss scenarios**: Negative yield never reduces `total_deposited`
4. **Withdrawal queue**: Queued principal always matches active deposits
5. **Round settlement**: Prize allocation never exceeds `distributable_yield`

### Acceptance Criteria ✓

- [x] Documented accounting invariant plus contract-level enforcement
- [x] Fuzzing/property tests with arbitrary sequences (see test suite)
- [x] Explicit handling for zero or negative yield rounds
- [x] No code path exists where a withdrawal can succeed while leaving vault under-collateralized
