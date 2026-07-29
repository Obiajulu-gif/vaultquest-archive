#![no_std]

//! #264 Time-locked withdrawals with yield multipliers.
//! #382 Multipliers are reward weights, not principal amplifiers.
//! Existing DripPool behavior is untouched; vault functions expose the
//! duration-aware deposit and withdrawal paths.

use super::*;

// ── Yield tiers (basis points) ───────────────────────────────────────────
const FLEXIBLE_MULTIPLIER: u32 = 100;
const SHORT_MULTIPLIER: u32 = 110;
const MEDIUM_MULTIPLIER: u32 = 125;
const LONG_MULTIPLIER: u32 = 150;

// Approximate ledger windows (5s/ledger).
const SHORT_LEDGERS: u32 = 7 * 17_280;
const MEDIUM_LEDGERS: u32 = 14 * 17_280;
const LONG_LEDGERS: u32 = 90 * 17_280;

pub(crate) fn multiplier_for(lockup_days: u32) -> Result<u32, Error> {
    match lockup_days {
        0 => Ok(FLEXIBLE_MULTIPLIER),
        1..=7 => Ok(SHORT_MULTIPLIER),
        8..=14 => Ok(MEDIUM_MULTIPLIER),
        15..=u32::MAX => Ok(LONG_MULTIPLIER),
    }
}

fn lockup_ledgers_for(lockup_days: u32) -> Result<u32, Error> {
    match lockup_days {
        0 => Ok(0),
        1..=7 => Ok(SHORT_LEDGERS),
        8..=14 => Ok(MEDIUM_LEDGERS),
        15..=u32::MAX => Ok(LONG_LEDGERS),
    }
}

/// Record a duration-based deposit for an existing participant.
/// Sets the lockup_multiplier as a reward *weight*, not a payout multiplier.
/// Caller must already be joined.
pub(crate) fn apply_time_locked_deposit(
    env: &Env,
    who: &Address,
    amount: i128,
    lockup_days: u32,
) -> Result<(), Error> {
    let p: Participant = super::DripPool::load_participant(env, who)?;
    let mut p = p;
    p.deposited += amount;
    p.lockup_multiplier = multiplier_for(lockup_days)?;
    let ledgers = lockup_ledgers_for(lockup_days)?;
    p.locked_until = env.ledger().sequence() + ledgers;
    super::DripPool::save_participant(env, who, &p);
    Ok(())
}

/// Clear a participant's state after the lockup expires.
/// Returns principal only — rewards must be claimed separately via claim_reward (#377).
/// The lockup_multiplier is a reward weight and is NOT applied to principal (#382).
pub(crate) fn apply_withdrawal(env: &Env, who: &Address) -> Result<i128, Error> {
    let p = super::DripPool::load_participant(env, who)?;

    if env.ledger().sequence() < p.locked_until {
        return Err(Error::LockupActive);
    }

    let principal = p.deposited;
    env.storage()
        .persistent()
        .remove(&DataKey::Participant(who.clone()));
    env.storage()
        .persistent()
        .remove(&DataKey::ParticipantV1(who.clone()));
    Ok(principal)
}

/// Decrement pool accounting for an admin-initiated escrow release.
pub(crate) fn apply_admin_release(env: &Env, amount: i128) -> Result<(), Error> {
    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;
    pool.total_deposited = pool.total_deposited.saturating_sub(amount);
    env.storage().instance().set(&DataKey::Pool, &pool);
    Ok(())
}
