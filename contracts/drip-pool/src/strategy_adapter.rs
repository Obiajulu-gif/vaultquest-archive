#![allow(dead_code)]

//! Governed yield-strategy adapter (#496).
//!
//! Deploys idle pool principal into an external `YieldStrategy` (see
//! `vaultquest_common::strategy`), harvests realized gains into
//! `Pool.distributable_yield`, and absorbs realized losses against
//! `Pool.principal_in_strategy`.
//!
//! ## Why `withdraw`/`withdraw_locked` never call the strategy
//!
//! A malicious or broken strategy contract can panic, which aborts the whole
//! call chain that invoked it. If ordinary user withdrawals routed through
//! the strategy, a bricked strategy would strand every depositor. Instead,
//! only these governed entrypoints ever call out to the strategy; principal
//! that hasn't been explicitly `deploy_to_strategy`'d remains in the pool's
//! own SAC balance and stays withdrawable through the existing `withdraw`
//! path regardless of strategy health.

use super::*;

pub(crate) fn set_strategy(env: &Env, caller: &Address, strategy: &Address) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    // Capability/version check: refuse to bind to a strategy that doesn't
    // speak the interface version this pool was built against. A strategy
    // that panics here (e.g. doesn't implement the interface at all) simply
    // fails this call — funds are never at risk since nothing has moved yet.
    let client = YieldStrategyClient::new(env, strategy);
    if client.interface_version() != vaultquest_common::STRATEGY_INTERFACE_VERSION {
        return Err(Error::StrategyVersionUnsupported);
    }

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    pool.strategy = Some(strategy.clone());
    env.storage().instance().set(&DataKey::Pool, &pool);
    DripPool::bump_instance(env);

    env.events()
        .publish((symbol_short!("strat"), symbol_short!("set")), strategy.clone());
    Ok(())
}

/// Move `amount` of idle (not-yet-deployed) principal from the pool's own
/// balance into the configured strategy.
pub(crate) fn deploy_to_strategy(env: &Env, caller: &Address, amount: i128) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;

    let idle = pool.total_deposited - pool.principal_in_strategy;
    if amount > idle {
        return Err(Error::InsufficientReserve);
    }

    let token = DripPool::get_token_address(env)?;
    let contract_addr = env.current_contract_address();

    let client = YieldStrategyClient::new(env, &strategy);
    client.deposit(&contract_addr, &token, &amount);

    pool.principal_in_strategy += amount;
    env.storage().instance().set(&DataKey::Pool, &pool);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("deploy")),
        (strategy, amount, pool.principal_in_strategy),
    );
    Ok(())
}

/// Pull up to `amount` of principal back from the strategy. Returns the
/// amount actually recalled — the strategy may return less (partial
/// redeem / slippage / a prior loss), and the pool reconciles to that real
/// figure rather than trusting the requested amount.
pub(crate) fn recall_from_strategy(env: &Env, caller: &Address, amount: i128) -> Result<i128, Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;
    let token = DripPool::get_token_address(env)?;
    let contract_addr = env.current_contract_address();

    let client = YieldStrategyClient::new(env, &strategy);
    let recalled = client.redeem(&contract_addr, &token, &amount);

    pool.principal_in_strategy = if recalled > pool.principal_in_strategy {
        0
    } else {
        pool.principal_in_strategy - recalled
    };
    env.storage().instance().set(&DataKey::Pool, &pool);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("recall")),
        (strategy, recalled, pool.principal_in_strategy),
    );
    Ok(recalled)
}

/// Reconcile the strategy's real balance against tracked principal. Realized
/// yield is added to `Pool.distributable_yield` (the *only* thing
/// `credit_yield`/prize funding may draw from); realized loss reduces
/// `Pool.principal_in_strategy` — it is never allowed to inflate
/// distributable yield.
pub(crate) fn harvest_strategy(env: &Env, caller: &Address) -> Result<(i128, i128), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;
    let token = DripPool::get_token_address(env)?;

    let client = YieldStrategyClient::new(env, &strategy);
    let report = client.harvest(&token);

    if report.realized_yield > 0 {
        pool.distributable_yield += report.realized_yield;
    }
    if report.realized_loss > 0 {
        pool.principal_in_strategy = if report.realized_loss > pool.principal_in_strategy {
            0
        } else {
            pool.principal_in_strategy - report.realized_loss
        };
    }
    env.storage().instance().set(&DataKey::Pool, &pool);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("harvest")),
        (strategy, report.realized_yield, report.realized_loss),
    );
    Ok((report.realized_yield, report.realized_loss))
}

/// Force-recall the strategy's *entire* real balance back into the pool,
/// regardless of tracked bookkeeping. Used when a strategy is misbehaving —
/// still bounded by the strategy's own honesty about its balance, but never
/// blocked by the pool's cached `principal_in_strategy` figure.
pub(crate) fn emergency_recall_strategy(env: &Env, caller: &Address) -> Result<i128, Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;
    let token = DripPool::get_token_address(env)?;
    let contract_addr = env.current_contract_address();

    let client = YieldStrategyClient::new(env, &strategy);
    let total = client.total_assets(&token);
    let recalled = if total > 0 {
        client.redeem(&contract_addr, &token, &total)
    } else {
        0
    };

    pool.principal_in_strategy = 0;
    env.storage().instance().set(&DataKey::Pool, &pool);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("emrecall")),
        (strategy, recalled),
    );
    Ok(recalled)
}
