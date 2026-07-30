#![allow(dead_code)]

//! Governed yield-strategy adapter (#496, #532).
//!
//! Deploys idle pool principal into an external `YieldStrategy` (see
//! `vaultquest_common::strategy`), harvests realized gains into
//! `Pool.distributable_yield`, and absorbs realized losses against
//! `Pool.principal_in_strategy`.
//!
//! Includes full strategy rotation state machine lifecycle (#532):
//! Propose -> Validate -> Drain -> Reconcile -> Activate / Cancel.

use super::*;
use vaultquest_common::strategy::StrategyRotationPhase;

fn get_strategy_token(env: &Env) -> Address {
    DripPool::get_token_address(env).unwrap_or_else(|_| env.current_contract_address())
}

pub(crate) fn set_strategy(env: &Env, caller: &Address, strategy: &Address) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    if pool.strategy.is_some() {
        internal_propose_strategy(env, strategy, i128::MAX)?;
    } else {
        let client = YieldStrategyClient::new(env, strategy);
        if client.interface_version() != vaultquest_common::STRATEGY_INTERFACE_VERSION {
            return Err(Error::StrategyVersionUnsupported);
        }

        pool.strategy = Some(strategy.clone());
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage().instance().set(&DataKey::StrategyExposureCap, &i128::MAX);
        env.storage().instance().set(&DataKey::StrategyRotationPhase, &StrategyRotationPhase::Idle);
        DripPool::bump_instance(env);

        env.events()
            .publish((symbol_short!("strat"), symbol_short!("set")), strategy.clone());
    }
    Ok(())
}

pub(crate) fn propose_strategy(
    env: &Env,
    caller: &Address,
    strategy: &Address,
    exposure_cap: i128,
) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;
    internal_propose_strategy(env, strategy, exposure_cap)
}

fn internal_propose_strategy(
    env: &Env,
    strategy: &Address,
    exposure_cap: i128,
) -> Result<(), Error> {
    if exposure_cap <= 0 {
        return Err(Error::InvalidAmount);
    }

    let phase: StrategyRotationPhase = env
        .storage()
        .instance()
        .get(&DataKey::StrategyRotationPhase)
        .unwrap_or(StrategyRotationPhase::Idle);

    if phase != StrategyRotationPhase::Idle {
        return Err(Error::StrategyRotationPending);
    }

    let client = YieldStrategyClient::new(env, strategy);
    if client.interface_version() != vaultquest_common::STRATEGY_INTERFACE_VERSION {
        return Err(Error::StrategyVersionUnsupported);
    }

    env.storage().instance().set(&DataKey::ProposedStrategy, &Some(strategy.clone()));
    env.storage().instance().set(&DataKey::ProposedExposureCap, &exposure_cap);
    env.storage().instance().set(&DataKey::StrategyRotationPhase, &StrategyRotationPhase::Proposed);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("propose")),
        (strategy.clone(), exposure_cap),
    );
    Ok(())
}

pub(crate) fn validate_strategy(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let phase: StrategyRotationPhase = env
        .storage()
        .instance()
        .get(&DataKey::StrategyRotationPhase)
        .unwrap_or(StrategyRotationPhase::Idle);

    if phase != StrategyRotationPhase::Proposed {
        return Err(Error::StrategyRotationNotInProgress);
    }

    let proposed: Option<Address> = env.storage().instance().get(&DataKey::ProposedStrategy).flatten();
    let strategy = proposed.ok_or(Error::StrategyNotSet)?;

    let client = YieldStrategyClient::new(env, &strategy);
    if client.interface_version() != vaultquest_common::STRATEGY_INTERFACE_VERSION {
        return Err(Error::StrategyVersionUnsupported);
    }

    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    let next_phase = if pool.principal_in_strategy > 0 {
        StrategyRotationPhase::Draining
    } else {
        StrategyRotationPhase::Reconciled
    };

    env.storage().instance().set(&DataKey::StrategyRotationPhase, &next_phase);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("valid")),
        (strategy, next_phase as u32),
    );
    Ok(())
}

pub(crate) fn drain_strategy(env: &Env, caller: &Address, amount: i128) -> Result<i128, Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let phase: StrategyRotationPhase = env
        .storage()
        .instance()
        .get(&DataKey::StrategyRotationPhase)
        .unwrap_or(StrategyRotationPhase::Idle);

    if phase != StrategyRotationPhase::Draining && phase != StrategyRotationPhase::Proposed {
        return Err(Error::StrategyRotationNotInProgress);
    }

    let recalled = internal_recall_from_strategy(env, amount)?;

    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    if pool.principal_in_strategy == 0 {
        env.storage()
            .instance()
            .set(&DataKey::StrategyRotationPhase, &StrategyRotationPhase::Reconciled);
    } else {
        env.storage()
            .instance()
            .set(&DataKey::StrategyRotationPhase, &StrategyRotationPhase::Draining);
    }
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("drain")),
        (recalled, pool.principal_in_strategy),
    );
    Ok(recalled)
}

pub(crate) fn reconcile_strategy(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let phase: StrategyRotationPhase = env
        .storage()
        .instance()
        .get(&DataKey::StrategyRotationPhase)
        .unwrap_or(StrategyRotationPhase::Idle);

    if phase == StrategyRotationPhase::Idle {
        return Err(Error::StrategyRotationNotInProgress);
    }

    if env.storage().instance().has(&DataKey::Pool) {
        let pool: Pool = env.storage().instance().get(&DataKey::Pool).unwrap();
        if pool.strategy.is_some() {
            let _ = internal_harvest_strategy(env);
        }
    }

    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    if pool.principal_in_strategy > 0 {
        return Err(Error::StrategyUnreconciledPrincipal);
    }

    env.storage()
        .instance()
        .set(&DataKey::StrategyRotationPhase, &StrategyRotationPhase::Reconciled);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("reconc")),
        pool.principal_in_strategy,
    );
    Ok(())
}

pub(crate) fn activate_strategy(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let phase: StrategyRotationPhase = env
        .storage()
        .instance()
        .get(&DataKey::StrategyRotationPhase)
        .unwrap_or(StrategyRotationPhase::Idle);

    if phase != StrategyRotationPhase::Reconciled && phase != StrategyRotationPhase::Proposed {
        return Err(Error::StrategyRotationNotInProgress);
    }

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    if pool.principal_in_strategy > 0 {
        return Err(Error::StrategyUnreconciledPrincipal);
    }

    let proposed: Option<Address> = env.storage().instance().get(&DataKey::ProposedStrategy).flatten();
    let new_strategy = proposed.ok_or(Error::StrategyNotSet)?;

    let proposed_cap: i128 = env.storage().instance().get(&DataKey::ProposedExposureCap).unwrap_or(i128::MAX);

    pool.strategy = Some(new_strategy.clone());
    env.storage().instance().set(&DataKey::Pool, &pool);
    env.storage().instance().set(&DataKey::StrategyExposureCap, &proposed_cap);
    env.storage().instance().remove(&DataKey::ProposedStrategy);
    env.storage().instance().remove(&DataKey::ProposedExposureCap);
    env.storage().instance().set(&DataKey::StrategyRotationPhase, &StrategyRotationPhase::Idle);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("activ")),
        new_strategy,
    );
    Ok(())
}

pub(crate) fn cancel_strategy_rotation(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let phase: StrategyRotationPhase = env
        .storage()
        .instance()
        .get(&DataKey::StrategyRotationPhase)
        .unwrap_or(StrategyRotationPhase::Idle);

    if phase == StrategyRotationPhase::Idle {
        return Err(Error::StrategyRotationNotInProgress);
    }

    env.storage().instance().remove(&DataKey::ProposedStrategy);
    env.storage().instance().remove(&DataKey::ProposedExposureCap);
    env.storage().instance().set(&DataKey::StrategyRotationPhase, &StrategyRotationPhase::Idle);
    DripPool::bump_instance(env);

    env.events().publish(
        (symbol_short!("strat"), symbol_short!("cancel")),
        phase as u32,
    );
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

    let phase: StrategyRotationPhase = env
        .storage()
        .instance()
        .get(&DataKey::StrategyRotationPhase)
        .unwrap_or(StrategyRotationPhase::Idle);

    if phase != StrategyRotationPhase::Idle {
        return Err(Error::StrategyRotationPending);
    }

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;

    let exposure_cap: i128 = env.storage().instance().get(&DataKey::StrategyExposureCap).unwrap_or(i128::MAX);
    if pool.principal_in_strategy.saturating_add(amount) > exposure_cap {
        return Err(Error::ExposureCapExceeded);
    }

    let idle = pool.total_deposited - pool.principal_in_strategy;
    if amount > idle {
        return Err(Error::InvalidAction);
    }

    let token = get_strategy_token(env);
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

pub(crate) fn recall_from_strategy(env: &Env, caller: &Address, amount: i128) -> Result<i128, Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;
    internal_recall_from_strategy(env, amount)
}

fn internal_recall_from_strategy(env: &Env, amount: i128) -> Result<i128, Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;
    let token = get_strategy_token(env);
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

pub(crate) fn harvest_strategy(env: &Env, caller: &Address) -> Result<(i128, i128), Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;
    internal_harvest_strategy(env)
}

fn internal_harvest_strategy(env: &Env) -> Result<(i128, i128), Error> {
    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;
    let token = get_strategy_token(env);

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

pub(crate) fn emergency_recall_strategy(env: &Env, caller: &Address) -> Result<i128, Error> {
    caller.require_auth();
    DripPool::require_signer(env, caller)?;

    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    let strategy = pool.strategy.clone().ok_or(Error::StrategyNotSet)?;
    let token = get_strategy_token(env);
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
