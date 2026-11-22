#![no_std]

//! # Ownership Transfer — Issue #1123
//!
//! Two-phase ownership transfer with an expiry window:
//!
//! 1. **Propose** — the current admin calls `propose_ownership_transfer(new_owner, ttl_ledgers)`.
//!    This writes a `PendingOwnershipTransfer` record under `DataKey::PendingOwner` and emits
//!    an `ownership_proposed` event.
//!
//! 2. **Accept** — `new_owner` calls `accept_ownership_transfer()` before `expires_at`.
//!    The `Pool.admin` field is updated, `DataKey::Admin` is rewritten, `DataKey::PendingOwner`
//!    is removed, and an `ownership_accepted` event is emitted.
//!
//! 3. **Cancel / expiry** — the current admin may call `cancel_ownership_transfer()` at any
//!    time before acceptance.  Any caller may call `expire_ownership_transfer()` once the
//!    `expires_at` ledger has passed; this deletes the pending record and emits
//!    `ownership_expired`.  Attempting `accept_ownership_transfer()` after expiry returns
//!    `Error::OwnershipTransferExpired`.
//!
//! ## Why two-phase?
//! A single-step `set_owner` call transfers control the instant it executes, with no way for
//! the new owner to signal readiness or refuse.  Two-phase forces the new owner to actively
//! claim control, preventing accidental transfers to wrong/inactive addresses.
//!
//! ## Migration
//! No on-chain migration needed.  `DataKey::PendingOwner` is a new variant; absence means
//! no transfer is pending.  Existing `Pool.admin` semantics are unchanged.

use super::*;

// ── Default TTL for a pending transfer (~7 days at 5 s/ledger) ────────────
pub(crate) const OWNERSHIP_TRANSFER_DEFAULT_TTL: u32 = 17_280 * 7;
// Maximum TTL a proposer may request (~90 days).
pub(crate) const OWNERSHIP_TRANSFER_MAX_TTL: u32 = 17_280 * 90;

// ── Storage record ─────────────────────────────────────────────────────────
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PendingOwnershipTransfer {
    /// The address that must call `accept_ownership_transfer` to complete the handoff.
    pub proposed_owner: Address,
    /// Current owner at proposal time — stored so we can verify the canceller.
    pub current_owner: Address,
    /// Ledger sequence after which acceptance is no longer valid.
    pub expires_at: u32,
    /// Ledger sequence when the proposal was created (audit trail).
    pub proposed_at: u32,
}

// ── Public entry points (called from DripPool contractimpl) ───────────────

/// Propose a transfer of contract ownership to `new_owner`.
///
/// Only the current `Pool.admin` may call this.  A second call overwrites any
/// existing pending transfer — intentional: the admin can redirect a proposal
/// to a different address if the first recipient was wrong.
///
/// `ttl_ledgers` defaults to `OWNERSHIP_TRANSFER_DEFAULT_TTL` when 0.
/// Returns `Error::InvalidAction` when `ttl_ledgers > OWNERSHIP_TRANSFER_MAX_TTL`.
pub(crate) fn propose_ownership_transfer(
    env: &Env,
    caller: &Address,
    new_owner: Address,
    ttl_ledgers: u32,
) -> Result<(), Error> {
    caller.require_auth();

    // Verify the caller is the current admin.
    let pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    if pool.admin != *caller {
        return Err(Error::Unauthorized);
    }

    // Reject self-transfer — it would be a no-op and waste ledger budget.
    if new_owner == pool.admin {
        return Err(Error::InvalidAction);
    }

    let effective_ttl = if ttl_ledgers == 0 {
        OWNERSHIP_TRANSFER_DEFAULT_TTL
    } else {
        ttl_ledgers
    };

    if effective_ttl > OWNERSHIP_TRANSFER_MAX_TTL {
        return Err(Error::InvalidAction);
    }

    let now = env.ledger().sequence();
    let record = PendingOwnershipTransfer {
        proposed_owner: new_owner.clone(),
        current_owner: caller.clone(),
        expires_at: now + effective_ttl,
        proposed_at: now,
    };

    env.storage()
        .instance()
        .set(&DataKey::PendingOwner, &record);

    env.events().publish(
        (symbol_short!("ownership"), symbol_short!("proposed")),
        (caller.clone(), new_owner, now + effective_ttl),
    );

    DripPool::bump_instance(env);
    Ok(())
}

/// Accept a pending ownership transfer.
///
/// Must be called by exactly `PendingOwnershipTransfer.proposed_owner` before
/// `expires_at`.  On success the `Pool.admin` and `DataKey::Admin` are updated
/// atomically, the pending record is deleted, and an `ownership_accepted` event
/// is emitted.
pub(crate) fn accept_ownership_transfer(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();

    let record: PendingOwnershipTransfer = env
        .storage()
        .instance()
        .get(&DataKey::PendingOwner)
        .ok_or(Error::OwnershipTransferNotFound)?;

    // Expiry check — must come before the authorization check so a stale record
    // is never silently accepted even if the right address calls late.
    if env.ledger().sequence() > record.expires_at {
        // Clean up the expired record so storage is not left polluted.
        env.storage().instance().remove(&DataKey::PendingOwner);
        return Err(Error::OwnershipTransferExpired);
    }

    if *caller != record.proposed_owner {
        return Err(Error::Unauthorized);
    }

    // ── Update Pool.admin ──────────────────────────────────────────────────
    let mut pool: Pool = env
        .storage()
        .instance()
        .get(&DataKey::Pool)
        .ok_or(Error::NotInitialized)?;

    let old_owner = pool.admin.clone();
    pool.admin = caller.clone();

    env.storage().instance().set(&DataKey::Pool, &pool);
    // Keep the legacy DataKey::Admin key consistent.
    env.storage().instance().set(&DataKey::Admin, caller);

    // Remove the pending record — transfer is complete.
    env.storage().instance().remove(&DataKey::PendingOwner);

    env.events().publish(
        (symbol_short!("ownership"), symbol_short!("accepted")),
        (old_owner, caller.clone()),
    );

    DripPool::bump_instance(env);
    Ok(())
}

/// Cancel a pending ownership transfer.
///
/// Only the current `Pool.admin` (the proposing owner) may cancel.  Returns
/// `Error::OwnershipTransferNotFound` when no transfer is pending.
pub(crate) fn cancel_ownership_transfer(env: &Env, caller: &Address) -> Result<(), Error> {
    caller.require_auth();

    let record: PendingOwnershipTransfer = env
        .storage()
        .instance()
        .get(&DataKey::PendingOwner)
        .ok_or(Error::OwnershipTransferNotFound)?;

    if *caller != record.current_owner {
        return Err(Error::Unauthorized);
    }

    env.storage().instance().remove(&DataKey::PendingOwner);

    env.events().publish(
        (symbol_short!("ownership"), symbol_short!("cancelled")),
        (caller.clone(), record.proposed_owner),
    );

    DripPool::bump_instance(env);
    Ok(())
}

/// Expire a pending ownership transfer that has passed its `expires_at` ledger.
///
/// Permissionless — anyone may call this to clean up a stale record and
/// restore a clean state.  Returns `Error::InvalidAction` when the transfer
/// has not yet expired (prevents premature expiry).
pub(crate) fn expire_ownership_transfer(env: &Env) -> Result<(), Error> {
    let record: PendingOwnershipTransfer = env
        .storage()
        .instance()
        .get(&DataKey::PendingOwner)
        .ok_or(Error::OwnershipTransferNotFound)?;

    if env.ledger().sequence() <= record.expires_at {
        return Err(Error::InvalidAction);
    }

    env.storage().instance().remove(&DataKey::PendingOwner);

    env.events().publish(
        (symbol_short!("ownership"), symbol_short!("expired")),
        (record.current_owner, record.proposed_owner, record.expires_at),
    );

    DripPool::bump_instance(env);
    Ok(())
}

/// Read the current pending transfer, if any.
pub(crate) fn pending_ownership_transfer(
    env: &Env,
) -> Option<PendingOwnershipTransfer> {
    env.storage().instance().get(&DataKey::PendingOwner)
}
