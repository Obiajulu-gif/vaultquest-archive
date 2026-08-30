# Pool capacity feature — implementation

Adds an optional per-pool cap on `total_deposited`. Unset (default) = unlimited,
matching the existing `Token` config pattern (`has(...)` + `get(...)`) already
used in this contract for #376.

All changes are to `lib.rs`. Nothing in `vault.rs` or `proxy.rs` needs to change.

---

## 1. New error variants

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ...existing variants unchanged...
    TransferFailed = 16,
    CapacityExceeded = 17, // deposit would push total_deposited past configured capacity
    InvalidCapacity = 18,  // capacity <= 0, or below current total_deposited
}
```

## 2. New storage key

```rust
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    // ...existing variants unchanged...
    Token,
    Capacity, // i128 — optional maximum total_deposited; absent = unlimited
}
```

## 3. Helpers (add alongside the other token helpers in `impl DripPool`)

```rust
// ── Capacity helpers ───────────────────────────────────────────────────

/// Whether a capacity limit is configured. Absent = unlimited (backward compatible).
fn has_capacity_configured(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Capacity)
}

/// The configured capacity, if any. `None` means unlimited.
fn get_capacity(env: &Env) -> Option<i128> {
    env.storage().instance().get(&DataKey::Capacity)
}

/// Reject a deposit that would push `total_deposited` past the configured
/// capacity. No-op when unlimited.
fn check_capacity(env: &Env, pool: &Pool, amount: i128) -> Result<(), Error> {
    if let Some(cap) = Self::get_capacity(env) {
        let projected = pool.total_deposited.saturating_add(amount);
        if projected > cap {
            return Err(Error::CapacityExceeded);
        }
    }
    Ok(())
}
```

## 4. Public entrypoints (add near `set_token` / the yield-management section)

```rust
/// Configure a maximum `total_deposited` for the pool. Signer-only (same
/// trust level as `set_token` / `add_yield` — not routed through the
/// proposal system since it doesn't move funds or change the admin set).
///
/// `capacity` must be strictly positive and must not be below the amount
/// already deposited, otherwise the pool would be configured already over
/// its own limit.
pub fn set_capacity(env: Env, caller: Address, capacity: i128) -> Result<(), Error> {
    caller.require_auth();
    Self::require_signer(&env, &caller)?;
    if capacity <= 0 {
        return Err(Error::InvalidCapacity);
    }
    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    if capacity < pool.total_deposited {
        return Err(Error::InvalidCapacity);
    }
    env.storage().instance().set(&DataKey::Capacity, &capacity);
    Self::bump_instance(&env);
    env.events()
        .publish((symbol_short!("pool"), symbol_short!("cap_set")), capacity);
    Ok(())
}

/// Remove the configured capacity, returning the pool to unlimited deposits.
/// Signer-only.
pub fn clear_capacity(env: Env, caller: Address) -> Result<(), Error> {
    caller.require_auth();
    Self::require_signer(&env, &caller)?;
    env.storage().instance().remove(&DataKey::Capacity);
    Self::bump_instance(&env);
    env.events()
        .publish((symbol_short!("pool"), symbol_short!("cap_clr")), ());
    Ok(())
}

/// View the configured capacity. `None` means unlimited — this is the
/// frontend-readable config value (acceptance criteria: "frontend can read
/// remaining capacity" is covered by `remaining_capacity` below; this is
/// the raw configured limit).
pub fn capacity(env: Env) -> Option<i128> {
    Self::get_capacity(&env)
}

/// View remaining deposit headroom. `None` means unlimited.
pub fn remaining_capacity(env: Env) -> Result<Option<i128>, Error> {
    let cap = match Self::get_capacity(&env) {
        Some(c) => c,
        None => return Ok(None),
    };
    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    Ok(Some(cap.saturating_sub(pool.total_deposited)))
}
```

## 5. Enforce the cap at deposit time

Capacity is checked **before** the token transfer, so an over-cap deposit
reverts without moving any tokens.

### `deposit`

```rust
pub fn deposit(env: Env, who: Address, amount: i128) -> Result<(), Error> {
    who.require_auth();
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let old_participant: Option<Participant> = {
        let key = DataKey::Participant(who.clone());
        env.storage().persistent().get(&key)
    };
    let old_pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    // Enforce configured capacity, if any (new)
    Self::check_capacity(&env, &old_pool, amount)?;

    // Transfer tokens from caller to this contract (#376)
    let contract_addr = env.current_contract_address();
    Self::transfer_tokens(&env, &who, &contract_addr, &amount)?;

    // ...rest of function unchanged...
}
```

### `deposit_with_duration`

```rust
pub fn deposit_with_duration(
    env: Env,
    who: Address,
    amount: i128,
    lockup_days: u32,
) -> Result<(), Error> {
    who.require_auth();
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    // Enforce configured capacity, if any (new)
    Self::check_capacity(&env, &pool, amount)?;

    // Transfer tokens from caller to this contract (#376)
    let contract_addr = env.current_contract_address();
    Self::transfer_tokens(&env, &who, &contract_addr, &amount)?;

    vault::apply_time_locked_deposit(&env, &who, amount, lockup_days)?;

    let mut pool = pool;
    pool.total_drips += 1;
    pool.total_deposited += amount;
    env.storage().instance().set(&DataKey::Pool, &pool);
    Self::bump_instance(&env);
    Ok(())
}
```

(Note: this replaces the original `!env.storage().instance().has(&DataKey::Pool)`
existence check with a direct `get(...).ok_or(...)`, since the pool value is
needed anyway for the capacity check — behavior for the "not initialized"
case is identical.)

`drip` calls `deposit` internally, so it's covered automatically.
`withdraw` / `withdraw_locked` don't need changes — they only reduce
`total_deposited`, so freeing headroom is automatic and requires no explicit
"capacity freed" event; `remaining_capacity` reflects it on next read.

## 6. Tests (add to `test.rs`, using the existing test-setup helpers)

```rust
#[test]
fn test_capacity_unlimited_by_default() {
    let (env, client, admin) = setup(); // existing helper: create() + one admin
    let user = Address::generate(&env);
    client.join(&user);

    assert_eq!(client.capacity(), None);
    assert_eq!(client.remaining_capacity(), None);

    client.deposit(&user, &1_000_000i128);
    assert_eq!(client.pool().total_deposited, 1_000_000i128);
    assert_eq!(client.remaining_capacity(), None); // still unlimited
}

#[test]
fn test_capacity_exact_fill_succeeds() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);

    client.set_capacity(&admin, &1_000i128);
    client.deposit(&user, &1_000i128); // exact fill, must succeed

    assert_eq!(client.pool().total_deposited, 1_000i128);
    assert_eq!(client.remaining_capacity(), Some(0i128));
}

#[test]
fn test_capacity_overflow_rejected() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);

    client.set_capacity(&admin, &1_000i128);
    client.deposit(&user, &900i128);

    // 900 + 200 > 1000 → must revert, and must not partially apply
    let result = client.try_deposit(&user, &200i128);
    assert_eq!(result, Err(Ok(Error::CapacityExceeded)));
    assert_eq!(client.pool().total_deposited, 900i128); // unchanged

    // headroom (100) still fits
    client.deposit(&user, &100i128);
    assert_eq!(client.pool().total_deposited, 1_000i128);
}

#[test]
fn test_capacity_freed_by_withdrawal() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user); // locked_until = now + LOCKUP_LEDGERS

    client.set_capacity(&admin, &1_000i128);
    client.deposit(&user, &1_000i128);

    // Would exceed cap while still locked
    assert_eq!(
        client.try_deposit(&user, &1i128),
        Err(Ok(Error::CapacityExceeded))
    );

    // Advance past the lockup and withdraw principal
    env.ledger().with_mut(|li| li.sequence_number += LOCKUP_LEDGERS + 1);
    let withdrawn = client.withdraw(&user);
    assert_eq!(withdrawn, 1_000i128);
    assert_eq!(client.remaining_capacity(), Some(1_000i128));

    // Headroom is available again
    client.deposit(&user, &1_000i128);
    assert_eq!(client.pool().total_deposited, 1_000i128);
}

#[test]
fn test_set_capacity_below_current_deposits_rejected() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);
    client.deposit(&user, &500i128);

    let result = client.try_set_capacity(&admin, &400i128);
    assert_eq!(result, Err(Ok(Error::InvalidCapacity)));
}

#[test]
fn test_set_capacity_non_signer_rejected() {
    let (env, client, _admin) = setup();
    let impostor = Address::generate(&env);

    let result = client.try_set_capacity(&impostor, &1_000i128);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_clear_capacity_restores_unlimited() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);

    client.set_capacity(&admin, &100i128);
    assert_eq!(
        client.try_deposit(&user, &200i128),
        Err(Ok(Error::CapacityExceeded))
    );

    client.clear_capacity(&admin);
    assert_eq!(client.capacity(), None);
    client.deposit(&user, &200i128); // now succeeds, unlimited again
    assert_eq!(client.pool().total_deposited, 200i128);
}
```

If `test.rs` doesn't already export a `setup()` helper returning
`(Env, DripPoolClient, Address)` with `mock_all_auths()` + `create()` called,
mirror the pattern used in `proxy.rs`'s test module (`Env::default()`,
`env.mock_all_auths()`, `env.register(DripPool, ())`, then `client.create(&admin)`).

## Notes on the acceptance criteria

- **"Pool deposits never exceed configured capacity"** — enforced in both
  `deposit` and `deposit_with_duration` (and transitively `drip`), checked
  _before_ the token transfer so a rejected deposit moves no funds and
  leaves no partial state.
- **"Unlimited-capacity pools remain supported"** — default state (no
  `Capacity` key set) is unlimited; `clear_capacity` lets an admin remove a
  previously set cap.
- **"Frontend can read remaining capacity"** — `remaining_capacity()` view,
  plus `capacity()` for the raw configured limit.
- **Events** — `cap_set` (with the new capacity value) and `cap_clr` follow
  the existing `(symbol_short!("pool"), symbol_short!(<action>))` event
  convention used elsewhere in the contract (`token_set`, `deposit`, etc.).
- Capacity mutation is a single-signer call (like `set_token`/`add_yield`),
  not a multisig proposal — it doesn't move funds or alter the admin/threshold
  set, matching the trust level of the other direct admin setters already in
  this file. If you'd rather route it through the proposal system instead
  (e.g. treat capacity changes as governance-sensitive), it can be added as
  a new `ProposalAction::SetCapacity(i128)` variant with the same validation
  — say the word and I'll wire that version instead.

# Pool capacity feature — implementation

Adds an optional per-pool cap on `total_deposited`. Unset (default) = unlimited,
matching the existing `Token` config pattern (`has(...)` + `get(...)`) already
used in this contract for #376.

All changes are to `lib.rs`. Nothing in `vault.rs` or `proxy.rs` needs to change.

---

## 1. New error variants

```rust
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    // ...existing variants unchanged...
    TransferFailed = 16,
    CapacityExceeded = 17, // deposit would push total_deposited past configured capacity
    InvalidCapacity = 18,  // capacity <= 0, or below current total_deposited
}
```

## 2. New storage key

```rust
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    // ...existing variants unchanged...
    Token,
    Capacity, // i128 — optional maximum total_deposited; absent = unlimited
}
```

## 3. Helpers (add alongside the other token helpers in `impl DripPool`)

```rust
// ── Capacity helpers ───────────────────────────────────────────────────

/// Whether a capacity limit is configured. Absent = unlimited (backward compatible).
fn has_capacity_configured(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Capacity)
}

/// The configured capacity, if any. `None` means unlimited.
fn get_capacity(env: &Env) -> Option<i128> {
    env.storage().instance().get(&DataKey::Capacity)
}

/// Reject a deposit that would push `total_deposited` past the configured
/// capacity. No-op when unlimited.
fn check_capacity(env: &Env, pool: &Pool, amount: i128) -> Result<(), Error> {
    if let Some(cap) = Self::get_capacity(env) {
        let projected = pool.total_deposited.saturating_add(amount);
        if projected > cap {
            return Err(Error::CapacityExceeded);
        }
    }
    Ok(())
}
```

## 4. Public entrypoints (add near `set_token` / the yield-management section)

```rust
/// Configure a maximum `total_deposited` for the pool. Signer-only (same
/// trust level as `set_token` / `add_yield` — not routed through the
/// proposal system since it doesn't move funds or change the admin set).
///
/// `capacity` must be strictly positive and must not be below the amount
/// already deposited, otherwise the pool would be configured already over
/// its own limit.
pub fn set_capacity(env: Env, caller: Address, capacity: i128) -> Result<(), Error> {
    caller.require_auth();
    Self::require_signer(&env, &caller)?;
    if capacity <= 0 {
        return Err(Error::InvalidCapacity);
    }
    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    if capacity < pool.total_deposited {
        return Err(Error::InvalidCapacity);
    }
    env.storage().instance().set(&DataKey::Capacity, &capacity);
    Self::bump_instance(&env);
    env.events()
        .publish((symbol_short!("pool"), symbol_short!("cap_set")), capacity);
    Ok(())
}

/// Remove the configured capacity, returning the pool to unlimited deposits.
/// Signer-only.
pub fn clear_capacity(env: Env, caller: Address) -> Result<(), Error> {
    caller.require_auth();
    Self::require_signer(&env, &caller)?;
    env.storage().instance().remove(&DataKey::Capacity);
    Self::bump_instance(&env);
    env.events()
        .publish((symbol_short!("pool"), symbol_short!("cap_clr")), ());
    Ok(())
}

/// View the configured capacity. `None` means unlimited — this is the
/// frontend-readable config value (acceptance criteria: "frontend can read
/// remaining capacity" is covered by `remaining_capacity` below; this is
/// the raw configured limit).
pub fn capacity(env: Env) -> Option<i128> {
    Self::get_capacity(&env)
}

/// View remaining deposit headroom. `None` means unlimited.
pub fn remaining_capacity(env: Env) -> Result<Option<i128>, Error> {
    let cap = match Self::get_capacity(&env) {
        Some(c) => c,
        None => return Ok(None),
    };
    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    Ok(Some(cap.saturating_sub(pool.total_deposited)))
}
```

## 5. Enforce the cap at deposit time

Capacity is checked **before** the token transfer, so an over-cap deposit
reverts without moving any tokens.

### `deposit`

```rust
pub fn deposit(env: Env, who: Address, amount: i128) -> Result<(), Error> {
    who.require_auth();
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let old_participant: Option<Participant> = {
        let key = DataKey::Participant(who.clone());
        env.storage().persistent().get(&key)
    };
    let old_pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    // Enforce configured capacity, if any (new)
    Self::check_capacity(&env, &old_pool, amount)?;

    // Transfer tokens from caller to this contract (#376)
    let contract_addr = env.current_contract_address();
    Self::transfer_tokens(&env, &who, &contract_addr, &amount)?;

    // ...rest of function unchanged...
}
```

### `deposit_with_duration`

```rust
pub fn deposit_with_duration(
    env: Env,
    who: Address,
    amount: i128,
    lockup_days: u32,
) -> Result<(), Error> {
    who.require_auth();
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    // Enforce configured capacity, if any (new)
    Self::check_capacity(&env, &pool, amount)?;

    // Transfer tokens from caller to this contract (#376)
    let contract_addr = env.current_contract_address();
    Self::transfer_tokens(&env, &who, &contract_addr, &amount)?;

    vault::apply_time_locked_deposit(&env, &who, amount, lockup_days)?;

    let mut pool = pool;
    pool.total_drips += 1;
    pool.total_deposited += amount;
    env.storage().instance().set(&DataKey::Pool, &pool);
    Self::bump_instance(&env);
    Ok(())
}
```

(Note: this replaces the original `!env.storage().instance().has(&DataKey::Pool)`
existence check with a direct `get(...).ok_or(...)`, since the pool value is
needed anyway for the capacity check — behavior for the "not initialized"
case is identical.)

`drip` calls `deposit` internally, so it's covered automatically.
`withdraw` / `withdraw_locked` don't need changes — they only reduce
`total_deposited`, so freeing headroom is automatic and requires no explicit
"capacity freed" event; `remaining_capacity` reflects it on next read.

## 6. Tests (add to `test.rs`, using the existing test-setup helpers)

```rust
#[test]
fn test_capacity_unlimited_by_default() {
    let (env, client, admin) = setup(); // existing helper: create() + one admin
    let user = Address::generate(&env);
    client.join(&user);

    assert_eq!(client.capacity(), None);
    assert_eq!(client.remaining_capacity(), None);

    client.deposit(&user, &1_000_000i128);
    assert_eq!(client.pool().total_deposited, 1_000_000i128);
    assert_eq!(client.remaining_capacity(), None); // still unlimited
}

#[test]
fn test_capacity_exact_fill_succeeds() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);

    client.set_capacity(&admin, &1_000i128);
    client.deposit(&user, &1_000i128); // exact fill, must succeed

    assert_eq!(client.pool().total_deposited, 1_000i128);
    assert_eq!(client.remaining_capacity(), Some(0i128));
}

#[test]
fn test_capacity_overflow_rejected() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);

    client.set_capacity(&admin, &1_000i128);
    client.deposit(&user, &900i128);

    // 900 + 200 > 1000 → must revert, and must not partially apply
    let result = client.try_deposit(&user, &200i128);
    assert_eq!(result, Err(Ok(Error::CapacityExceeded)));
    assert_eq!(client.pool().total_deposited, 900i128); // unchanged

    // headroom (100) still fits
    client.deposit(&user, &100i128);
    assert_eq!(client.pool().total_deposited, 1_000i128);
}

#[test]
fn test_capacity_freed_by_withdrawal() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user); // locked_until = now + LOCKUP_LEDGERS

    client.set_capacity(&admin, &1_000i128);
    client.deposit(&user, &1_000i128);

    // Would exceed cap while still locked
    assert_eq!(
        client.try_deposit(&user, &1i128),
        Err(Ok(Error::CapacityExceeded))
    );

    // Advance past the lockup and withdraw principal
    env.ledger().with_mut(|li| li.sequence_number += LOCKUP_LEDGERS + 1);
    let withdrawn = client.withdraw(&user);
    assert_eq!(withdrawn, 1_000i128);
    assert_eq!(client.remaining_capacity(), Some(1_000i128));

    // Headroom is available again
    client.deposit(&user, &1_000i128);
    assert_eq!(client.pool().total_deposited, 1_000i128);
}

#[test]
fn test_set_capacity_below_current_deposits_rejected() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);
    client.deposit(&user, &500i128);

    let result = client.try_set_capacity(&admin, &400i128);
    assert_eq!(result, Err(Ok(Error::InvalidCapacity)));
}

#[test]
fn test_set_capacity_non_signer_rejected() {
    let (env, client, _admin) = setup();
    let impostor = Address::generate(&env);

    let result = client.try_set_capacity(&impostor, &1_000i128);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_clear_capacity_restores_unlimited() {
    let (env, client, admin) = setup();
    let user = Address::generate(&env);
    client.join(&user);

    client.set_capacity(&admin, &100i128);
    assert_eq!(
        client.try_deposit(&user, &200i128),
        Err(Ok(Error::CapacityExceeded))
    );

    client.clear_capacity(&admin);
    assert_eq!(client.capacity(), None);
    client.deposit(&user, &200i128); // now succeeds, unlimited again
    assert_eq!(client.pool().total_deposited, 200i128);
}
```

If `test.rs` doesn't already export a `setup()` helper returning
`(Env, DripPoolClient, Address)` with `mock_all_auths()` + `create()` called,
mirror the pattern used in `proxy.rs`'s test module (`Env::default()`,
`env.mock_all_auths()`, `env.register(DripPool, ())`, then `client.create(&admin)`).

## Notes on the acceptance criteria

- **"Pool deposits never exceed configured capacity"** — enforced in both
  `deposit` and `deposit_with_duration` (and transitively `drip`), checked
  _before_ the token transfer so a rejected deposit moves no funds and
  leaves no partial state.
- **"Unlimited-capacity pools remain supported"** — default state (no
  `Capacity` key set) is unlimited; `clear_capacity` lets an admin remove a
  previously set cap.
- **"Frontend can read remaining capacity"** — `remaining_capacity()` view,
  plus `capacity()` for the raw configured limit.
- **Events** — `cap_set` (with the new capacity value) and `cap_clr` follow
  the existing `(symbol_short!("pool"), symbol_short!(<action>))` event
  convention used elsewhere in the contract (`token_set`, `deposit`, etc.).
- Capacity mutation is a single-signer call (like `set_token`/`add_yield`),
  not a multisig proposal — it doesn't move funds or alter the admin/threshold
  set, matching the trust level of the other direct admin setters already in
  this file. If you'd rather route it through the proposal system instead
  (e.g. treat capacity changes as governance-sensitive), it can be added as
  a new `ProposalAction::SetCapacity(i128)` variant with the same validation
  — say the word and I'll wire that version instead.
