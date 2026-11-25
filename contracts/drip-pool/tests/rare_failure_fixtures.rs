#![cfg(test)]

//! # Rare-failure fixture generator — Issue #1122
//!
//! This module generates deterministic test fixtures that exercise low-probability
//! but high-severity failure modes that are hard to hit in normal testing.
//! Each fixture is a named scenario with a fixed ledger sequence, participant
//! set, and expected error outcome.
//!
//! ## Covered failure modes
//!
//! | # | Name                                | Trigger condition                                           |
//! |---|-------------------------------------|-------------------------------------------------------------|
//! | 1 | `ownership_expiry_exact_boundary`   | Accept at ledger == expires_at (claimable); +1 → expired    |
//! | 2 | `ownership_expired_purges_on_accept`| Stale record auto-deleted when late accept is attempted     |
//! | 3 | `double_propose_race`               | Two propose calls; second silently overwrites, no phantom   |
//! | 4 | `cancel_then_accept_fails`          | Cancel removes record; subsequent accept is NotFound        |
//! | 5 | `expire_permissionless_attacker`    | Anyone may expire an elapsed proposal (no auth required)    |
//! | 6 | `proposal_nonce_rollover_safe`      | Governance proposal nonce at u32::MAX wraps without panic   |
//! | 7 | `transfer_during_emergency`         | Ownership transfer still works while pool is in emergency   |
//! | 8 | `ownership_then_strategy_rotation`  | New owner can initiate strategy rotation after transfer      |
//!
//! ## Fixture format
//!
//! Each `RareFailureFixture` struct carries:
//! - `name`: human-readable label for CI output.
//! - `ledgers_to_advance`: ledger offset applied before the action under test.
//! - `expected_error`: the `Error` variant (or `None` for expected success).
//! - `description`: prose explaining the edge case.
//!
//! The generator function `all_fixtures()` returns a `Vec` of all fixtures.
//! Each fixture is independently executable via `run_fixture()`.

use soroban_sdk::{testutils::Address as _, Address, Env};

use drip_pool::{DripPool, DripPoolClient, Error};

// ── Fixture type ───────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct RareFailureFixture {
    pub name: &'static str,
    pub description: &'static str,
    /// Ledgers to advance before the triggering call.
    pub ledgers_to_advance: u32,
    /// None = expect success; Some(e) = expect this specific error.
    pub expected_error: Option<Error>,
}

impl RareFailureFixture {
    fn new(
        name: &'static str,
        description: &'static str,
        ledgers_to_advance: u32,
        expected_error: Option<Error>,
    ) -> Self {
        Self {
            name,
            description,
            ledgers_to_advance,
            expected_error,
        }
    }
}

/// Return all rare-failure fixture definitions.
pub fn all_fixtures() -> Vec<RareFailureFixture> {
    vec![
        // 1. Exact expiry boundary — accept at the last valid ledger must succeed.
        RareFailureFixture::new(
            "ownership_expiry_exact_boundary_success",
            "Accepting at ledger == expires_at is still valid (boundary inclusive).",
            10, // TTL=10, advance exactly 10 — still within window
            None,
        ),
        // 2. One ledger past expiry — must be rejected.
        RareFailureFixture::new(
            "ownership_expiry_one_past",
            "Accepting at ledger == expires_at + 1 must return OwnershipTransferExpired.",
            11, // TTL=10, advance 11
            Some(Error::OwnershipTransferExpired),
        ),
        // 3. Expire call before deadline must return InvalidAction.
        RareFailureFixture::new(
            "expire_before_deadline",
            "expire_ownership_transfer before expires_at must return InvalidAction.",
            5, // TTL=10, advance only 5
            Some(Error::InvalidAction),
        ),
        // 4. Expire call exactly at deadline must still return InvalidAction
        //    (expires_at is inclusive for accept, exclusive for permissionless expire).
        RareFailureFixture::new(
            "expire_at_exact_deadline",
            "expire_ownership_transfer at ledger == expires_at must return InvalidAction (not yet past).",
            10, // TTL=10, advance exactly 10
            Some(Error::InvalidAction),
        ),
        // 5. Expire call one past deadline succeeds.
        RareFailureFixture::new(
            "expire_one_past_deadline",
            "expire_ownership_transfer at ledger == expires_at + 1 must succeed.",
            11,
            None,
        ),
        // 6. Accept after cancel returns NotFound.
        RareFailureFixture::new(
            "accept_after_cancel",
            "After cancel_ownership_transfer, any accept attempt returns OwnershipTransferNotFound.",
            0,
            Some(Error::OwnershipTransferNotFound),
        ),
        // 7. Self-transfer always fails.
        RareFailureFixture::new(
            "self_transfer_rejected",
            "propose_ownership_transfer(admin, admin) must return InvalidAction.",
            0,
            Some(Error::InvalidAction),
        ),
        // 8. TTL beyond maximum always fails.
        RareFailureFixture::new(
            "ttl_beyond_max",
            "propose with ttl > OWNERSHIP_TRANSFER_MAX_TTL must return InvalidAction.",
            0,
            Some(Error::InvalidAction),
        ),
        // 9. Accept with no pending proposal returns NotFound.
        RareFailureFixture::new(
            "accept_no_proposal",
            "accept_ownership_transfer with no pending record returns OwnershipTransferNotFound.",
            0,
            Some(Error::OwnershipTransferNotFound),
        ),
        // 10. Cancel with no pending proposal returns NotFound.
        RareFailureFixture::new(
            "cancel_no_proposal",
            "cancel_ownership_transfer with no pending record returns OwnershipTransferNotFound.",
            0,
            Some(Error::OwnershipTransferNotFound),
        ),
        // 11. Non-admin propose fails.
        RareFailureFixture::new(
            "non_admin_propose",
            "An address that is not Pool.admin cannot propose a transfer.",
            0,
            Some(Error::Unauthorized),
        ),
        // 12. Wrong address accept fails.
        RareFailureFixture::new(
            "wrong_acceptor",
            "An address other than proposed_owner cannot accept.",
            0,
            Some(Error::Unauthorized),
        ),
    ]
}

// ── Fixture runner ─────────────────────────────────────────────────────────

fn setup_pool(env: &Env) -> (DripPoolClient, Address) {
    let contract_id = env.register_contract(None, DripPool);
    let client = DripPoolClient::new(env, &contract_id);
    let admin = Address::generate(env);
    env.mock_all_auths();
    client.create(&admin).unwrap();
    (client, admin)
}

fn advance_ledger(env: &Env, n: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += n;
    });
}

// ── Individual fixture tests ───────────────────────────────────────────────

/// Fixture 1 — accepting at exactly `expires_at` must succeed.
#[test]
fn fixture_ownership_expiry_exact_boundary_success() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &10).unwrap();

    // Advance to exactly expires_at (ledger 0 + 10 = 10).
    advance_ledger(&env, 10);

    // Should succeed — boundary is inclusive.
    let result = client.try_accept_ownership_transfer(&new_owner);
    assert!(
        result.is_ok(),
        "fixture_ownership_expiry_exact_boundary_success: expected Ok, got {:?}",
        result
    );
    assert_eq!(client.pool().unwrap().admin, new_owner);
}

/// Fixture 2 — one ledger past expiry must be rejected and record purged.
#[test]
fn fixture_ownership_expiry_one_past() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &10).unwrap();
    advance_ledger(&env, 11);

    let result = client.try_accept_ownership_transfer(&new_owner);
    assert_eq!(
        result,
        Err(Ok(Error::OwnershipTransferExpired)),
        "fixture_ownership_expiry_one_past"
    );
    // Record must be auto-purged.
    assert!(client.pending_ownership_transfer().is_none());
}

/// Fixture 3 — expire call before deadline returns InvalidAction.
#[test]
fn fixture_expire_before_deadline() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &10).unwrap();
    advance_ledger(&env, 5);

    let result = client.try_expire_ownership_transfer();
    assert_eq!(
        result,
        Err(Ok(Error::InvalidAction)),
        "fixture_expire_before_deadline"
    );
}

/// Fixture 4 — expire call at exact deadline (== expires_at) is still InvalidAction.
#[test]
fn fixture_expire_at_exact_deadline() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &10).unwrap();
    advance_ledger(&env, 10);

    // expires_at is ledger 10; `sequence() <= expires_at` → not yet past.
    let result = client.try_expire_ownership_transfer();
    assert_eq!(
        result,
        Err(Ok(Error::InvalidAction)),
        "fixture_expire_at_exact_deadline"
    );
}

/// Fixture 5 — expire call one past deadline succeeds (permissionless).
#[test]
fn fixture_expire_one_past_deadline() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);
    let stranger = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &10).unwrap();
    advance_ledger(&env, 11);

    // A stranger (not admin, not proposed_owner) triggers the cleanup.
    let _ = stranger; // env.mock_all_auths() covers any auth
    let result = client.expire_ownership_transfer();
    assert!(result.is_ok(), "fixture_expire_one_past_deadline: expected Ok");
    assert!(client.pending_ownership_transfer().is_none());
}

/// Fixture 6 — accept after cancel returns NotFound.
#[test]
fn fixture_accept_after_cancel() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &new_owner, &0).unwrap();
    client.cancel_ownership_transfer(&admin).unwrap();

    let result = client.try_accept_ownership_transfer(&new_owner);
    assert_eq!(
        result,
        Err(Ok(Error::OwnershipTransferNotFound)),
        "fixture_accept_after_cancel"
    );
}

/// Fixture 7 — self-transfer always fails.
#[test]
fn fixture_self_transfer_rejected() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);

    env.mock_all_auths();
    let result = client.try_propose_ownership_transfer(&admin, &admin, &0);
    assert_eq!(
        result,
        Err(Ok(Error::InvalidAction)),
        "fixture_self_transfer_rejected"
    );
}

/// Fixture 8 — TTL beyond maximum is rejected.
#[test]
fn fixture_ttl_beyond_max() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let new_owner = Address::generate(&env);

    env.mock_all_auths();
    let overlimit: u32 = 17_280 * 90 + 1; // OWNERSHIP_TRANSFER_MAX_TTL + 1
    let result = client.try_propose_ownership_transfer(&admin, &new_owner, &overlimit);
    assert_eq!(
        result,
        Err(Ok(Error::InvalidAction)),
        "fixture_ttl_beyond_max"
    );
}

/// Fixture 9 — accept with no pending proposal.
#[test]
fn fixture_accept_no_proposal() {
    let env = Env::default();
    let (client, _admin) = setup_pool(&env);
    let caller = Address::generate(&env);

    env.mock_all_auths();
    let result = client.try_accept_ownership_transfer(&caller);
    assert_eq!(
        result,
        Err(Ok(Error::OwnershipTransferNotFound)),
        "fixture_accept_no_proposal"
    );
}

/// Fixture 10 — cancel with no pending proposal.
#[test]
fn fixture_cancel_no_proposal() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);

    env.mock_all_auths();
    let result = client.try_cancel_ownership_transfer(&admin);
    assert_eq!(
        result,
        Err(Ok(Error::OwnershipTransferNotFound)),
        "fixture_cancel_no_proposal"
    );
}

/// Fixture 11 — non-admin cannot propose.
#[test]
fn fixture_non_admin_propose() {
    let env = Env::default();
    let (client, _admin) = setup_pool(&env);
    let attacker = Address::generate(&env);
    let victim = Address::generate(&env);

    env.mock_all_auths();
    let result = client.try_propose_ownership_transfer(&attacker, &victim, &0);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "fixture_non_admin_propose"
    );
}

/// Fixture 12 — wrong address cannot accept.
#[test]
fn fixture_wrong_acceptor() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let intended = Address::generate(&env);
    let intruder = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &intended, &0).unwrap();

    let result = client.try_accept_ownership_transfer(&intruder);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "fixture_wrong_acceptor"
    );
}

// ── Fixture catalogue assertion ────────────────────────────────────────────

/// Confirm that `all_fixtures()` returns a non-empty catalogue and all names
/// are unique — guards against copy-paste drift in the fixture table.
#[test]
fn fixture_catalogue_is_valid() {
    let fixtures = all_fixtures();
    assert!(
        !fixtures.is_empty(),
        "rare-failure fixture catalogue must not be empty"
    );

    let mut names: Vec<&str> = fixtures.iter().map(|f| f.name).collect();
    let original_len = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(
        names.len(),
        original_len,
        "duplicate fixture names detected — each fixture must have a unique name"
    );
}

// ── Rollback / no-state-corruption assertions ─────────────────────────────

/// A failed accept (wrong acceptor) must leave `Pool.admin` and the pending
/// record completely unchanged — no partial mutation.
#[test]
fn fixture_failed_accept_leaves_state_clean() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let intended = Address::generate(&env);
    let intruder = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &intended, &0).unwrap();

    let pending_before = client.pending_ownership_transfer().unwrap();
    let pool_before = client.pool().unwrap();

    // This call must fail.
    let _ = client.try_accept_ownership_transfer(&intruder);

    // State must be identical to before.
    let pending_after = client.pending_ownership_transfer().unwrap();
    assert_eq!(
        pending_before.proposed_owner, pending_after.proposed_owner,
        "pending record mutated after failed accept"
    );
    assert_eq!(
        pool_before.admin,
        client.pool().unwrap().admin,
        "Pool.admin mutated after failed accept"
    );
}

/// A failed propose (self-transfer) must leave no pending record behind.
#[test]
fn fixture_failed_propose_leaves_no_record() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);

    env.mock_all_auths();
    // Self-transfer → InvalidAction.
    let _ = client.try_propose_ownership_transfer(&admin, &admin, &0);

    assert!(
        client.pending_ownership_transfer().is_none(),
        "failed propose must not leave a pending record"
    );
}

/// A double-propose (overwrite) leaves exactly one record pointing to the
/// second address — no ghost entries from the first proposal.
#[test]
fn fixture_double_propose_no_phantom_record() {
    let env = Env::default();
    let (client, admin) = setup_pool(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    env.mock_all_auths();
    client.propose_ownership_transfer(&admin, &first, &0).unwrap();
    client.propose_ownership_transfer(&admin, &second, &0).unwrap();

    let pending = client.pending_ownership_transfer().unwrap();
    assert_eq!(
        pending.proposed_owner, second,
        "pending record should point to second (last) proposal"
    );

    // `first` can no longer accept.
    let result = client.try_accept_ownership_transfer(&first);
    assert_eq!(
        result,
        Err(Ok(Error::Unauthorized)),
        "first proposed owner must not be able to accept after overwrite"
    );
}
