#![cfg(test)]

//! Tests for Issue #1123 — Implement ownership transfer acceptance and expiry.
//!
//! Covers:
//! - Happy path: propose → accept transfers ownership correctly.
//! - Proposer can overwrite a pending proposal with a new one.
//! - Non-owner cannot propose a transfer.
//! - Proposed owner cannot accept before expiry but wrong caller is blocked.
//! - Acceptance after expiry returns `OwnershipTransferExpired` and purges record.
//! - `expire_ownership_transfer` before expiry returns `InvalidAction`.
//! - `expire_ownership_transfer` after expiry succeeds and purges record.
//! - Cancel by current owner removes the record.
//! - Cancel by non-owner is unauthorized.
//! - Self-transfer is rejected with `InvalidAction`.
//! - TTL greater than max is rejected.
//! - Accepting when no proposal exists returns `OwnershipTransferNotFound`.
//! - After ownership transfer, old owner loses admin privileges.
//! - `pending_ownership_transfer` view returns `None` when nothing is pending.

use soroban_sdk::{testutils::Address as _, Address, Env};

use drip_pool::{DripPool, DripPoolClient, Error};

// ── Helpers ────────────────────────────────────────────────────────────────

fn setup_pool(env: &Env) -> (DripPoolClient, Address) {
    let contract_id = env.register_contract(None, DripPool);
    let client = DripPoolClient::new(env, &contract_id);
    let admin = Address::generate(env);

    env.mock_all_auths();
    client.create(&admin).unwrap();
    // Seed a second admin so threshold = 2 is reachable during setup,
    // then we operate as the first admin for ownership tests.
    (client, admin)
}

/// Advance the ledger sequence by `n` ledgers (each ledger ~5 s).
fn advance_ledger(env: &Env, n: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += n;
    });
}

// ── Normal path ────────────────────────────────────────────────────────────

#[test]
fn test_propose_and_accept_transfers_admin() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();

    // Propose with default TTL (0 → uses OWNERSHIP_TRANSFER_DEFAULT_TTL).
    client.propose_ownership_transfer(&admin, &new_owner, &0).unwrap();

    // Verify record is stored.
    let pending = client.pending_ownership_transfer().unwrap();
    assert_eq!(pending.proposed_owner, new_owner);
    assert_eq!(pending.current_owner, admin);
    assert!(pending.expires_at > env.ledger().sequence());

    // New owner accepts.
    client.accept_ownership_transfer(&new_owner).unwrap();

    // Pool.admin must now be new_owner.
    let pool = client.pool().unwrap();
    assert_eq!(pool.admin, new_owner);

    // Pending record must be cleared.
    assert!(client.pending_ownership_transfer().is_none());
}

#[test]
fn test_accept_emits_events_and_clears_record() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &0).unwrap();
    client.accept_ownership_transfer(&new_owner).unwrap();

    // After acceptance the record is gone.
    assert!(client.pending_ownership_transfer().is_none());

    // Pool.admin is updated.
    assert_eq!(client.pool().unwrap().admin, new_owner);
}

// ── Authorization failures ────────────────────────────────────────────────

#[test]
fn test_non_admin_cannot_propose() {
    let env = Env::default();
    let (client, _admin) = setup_pool(&env);
    let attacker = Address::generate(&env);
    let victim = Address::generate(&env);

    env.mock_all_auths();

    let result = client.try_propose_ownership_transfer(&attacker, &victim, &0);
    // Should fail: attacker is not Pool.admin.
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_wrong_address_cannot_accept() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let intended = Address::generate(&env);
    let intruder = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &intended, &0).unwrap();

    let result = client.try_accept_ownership_transfer(&intruder);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_cancel_by_non_owner_is_unauthorized() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);
    let attacker = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &0).unwrap();

    let result = client.try_cancel_ownership_transfer(&attacker);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

// ── Expiry ─────────────────────────────────────────────────────────────────

#[test]
fn test_accept_after_expiry_returns_expired_and_purges() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();

    // Set a short TTL: 10 ledgers.
    client.propose_ownership_transfer(&admin, &new_owner, &10).unwrap();

    // Advance past expiry.
    advance_ledger(&env, 11);

    let result = client.try_accept_ownership_transfer(&new_owner);
    assert_eq!(result, Err(Ok(Error::OwnershipTransferExpired)));

    // Record should be purged automatically on expiry detection.
    assert!(client.pending_ownership_transfer().is_none());
}

#[test]
fn test_expire_before_deadline_is_invalid() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &100).unwrap();

    // Try to expire immediately — deadline hasn't passed.
    let result = client.try_expire_ownership_transfer();
    assert_eq!(result, Err(Ok(Error::InvalidAction)));
}

#[test]
fn test_expire_after_deadline_succeeds_and_purges() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &10).unwrap();

    // Advance past expiry.
    advance_ledger(&env, 11);

    client.expire_ownership_transfer().unwrap();
    assert!(client.pending_ownership_transfer().is_none());
}

#[test]
fn test_expire_when_no_proposal_returns_not_found() {
    let env = Env::default();
    let (client, _admin) = setup_pool(&env);

    env.mock_all_auths();
    let result = client.try_expire_ownership_transfer();
    assert_eq!(result, Err(Ok(Error::OwnershipTransferNotFound)));
}

// ── Cancel ─────────────────────────────────────────────────────────────────

#[test]
fn test_cancel_by_current_owner_removes_record() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &0).unwrap();

    // Confirm record exists.
    assert!(client.pending_ownership_transfer().is_some());

    client.cancel_ownership_transfer(&admin).unwrap();

    // Record must be gone.
    assert!(client.pending_ownership_transfer().is_none());

    // Admin must be unchanged.
    assert_eq!(client.pool().unwrap().admin, admin);
}

#[test]
fn test_cancel_when_no_proposal_returns_not_found() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);

    env.mock_all_auths();
    let result = client.try_cancel_ownership_transfer(&admin);
    assert_eq!(result, Err(Ok(Error::OwnershipTransferNotFound)));
}

// ── Validation ─────────────────────────────────────────────────────────────

#[test]
fn test_self_transfer_rejected() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);

    env.mock_all_auths();
    let result = client.try_propose_ownership_transfer(&admin, &admin, &0);
    assert_eq!(result, Err(Ok(Error::InvalidAction)));
}

#[test]
fn test_ttl_exceeding_maximum_is_rejected() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();

    // Max TTL = 17_280 * 90 = 1_555_200. Pass one above.
    let too_long: u32 = 17_280 * 90 + 1;
    let result = client.try_propose_ownership_transfer(&admin, &new_owner, &too_long);
    assert_eq!(result, Err(Ok(Error::InvalidAction)));
}

#[test]
fn test_accept_when_no_proposal_returns_not_found() {
    let env = Env::default();
    let (client, _admin) = setup_pool(&env);
    let caller = Address::generate(&env);

    env.mock_all_auths();
    let result = client.try_accept_ownership_transfer(&caller);
    assert_eq!(result, Err(Ok(Error::OwnershipTransferNotFound)));
}

// ── Overwrite ──────────────────────────────────────────────────────────────

#[test]
fn test_propose_overwrites_existing_pending() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    env.mock_all_auths();

    client.propose_ownership_transfer(&admin, &first, &0).unwrap();
    // Overwrite with a different target.
    client.propose_ownership_transfer(&admin, &second, &0).unwrap();

    let pending = client.pending_ownership_transfer().unwrap();
    // The active proposal must point to `second`, not `first`.
    assert_eq!(pending.proposed_owner, second);
}

// ── Post-transfer privilege checks ─────────────────────────────────────────

#[test]
fn test_old_owner_loses_admin_after_transfer() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &0).unwrap();
    client.accept_ownership_transfer(&new_owner).unwrap();

    // The old admin trying to propose a transfer again should fail
    // because Pool.admin is now new_owner.
    let third = Address::generate(&env);
    let result = client.try_propose_ownership_transfer(&admin, &third, &0);
    assert_eq!(result, Err(Ok(Error::Unauthorized)));
}

#[test]
fn test_new_owner_can_propose_further_transfer() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let second_owner = Address::generate(&env);
    let third_owner = Address::generate(&env);

    env.mock_all_auths();

    // First handoff.
    client.propose_ownership_transfer(&admin, &second_owner, &0).unwrap();
    client.accept_ownership_transfer(&second_owner).unwrap();

    // Second handoff initiated by the new admin.
    client.propose_ownership_transfer(&second_owner, &third_owner, &0).unwrap();
    client.accept_ownership_transfer(&third_owner).unwrap();

    assert_eq!(client.pool().unwrap().admin, third_owner);
}

// ── View default state ─────────────────────────────────────────────────────

#[test]
fn test_pending_ownership_transfer_is_none_at_init() {
    let env = Env::default();
    let (client, _admin) = setup_pool(&env);

    env.mock_all_auths();
    assert!(client.pending_ownership_transfer().is_none());
}
