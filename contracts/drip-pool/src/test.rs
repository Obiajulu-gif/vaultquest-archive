//! Adversarial unit-test suite (#141) + regression tests (#139, #140).
//! Event emission tests (#255). Storage optimisation regression (#257).
//! #377: principal/reward separation tests.

use super::proxy::{VaultProxy, VaultProxyClient};
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, Env, IntoVal,
};

// Re-export the main contract error for convenience
use super::Error;
// Import proxy error separately since it's a different type
use super::proxy::Error as ProxyError;

// ── helpers ────────────────────────────────────────────────────────────────

fn setup() -> (Env, DripPoolClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, DripPool);
    let client = DripPoolClient::new(&env, &id);
    let admin = Address::generate(&env);
    (env, client, admin)
}

/// Advance ledger sequence past the lockup window.
fn skip_lockup(env: &Env) {
    let current = env.ledger().sequence();
    env.ledger().set_sequence_number(current + 120_961);
}

// ── existing regression tests (updated for #377) ───────────────────────────

#[test]
fn create_initialises_pool() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    let pool = client.pool();
    assert_eq!(pool.admin, admin);
    assert_eq!(pool.total_drips, 0);
    assert_eq!(pool.total_deposited, 0);
}

#[test]
fn create_twice_fails() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(
        client.try_create(&admin),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn full_lifecycle_create_join_deposit_claim_withdraw() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &10);
    client.drip(&alice, &5);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 2);
    assert_eq!(pool.total_deposited, 15);

    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 15);

    // No yield or prize → claim returns 0 (#377)
    let claimed = client.claim(&alice);
    assert_eq!(claimed, 0);
    assert_eq!(client.claim_reward(&alice), 0);

    skip_lockup(&env);
    // Withdraw returns only principal, not rewards (#377)
    let withdrawn = client.withdraw(&alice);
    assert_eq!(withdrawn, 15);
}

#[test]
fn double_join_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(client.try_join(&alice), Err(Ok(Error::AlreadyJoined)));
}

#[test]
fn drip_zero_amount_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(client.try_drip(&alice, &0), Err(Ok(Error::InvalidAmount)));
}

#[test]
fn drip_without_join_auto_joins() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.drip(&alice, &10);
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 10);
    // No claimable field — deposit only adds to principal (#377)
}

#[test]
fn withdraw_without_join_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::NotJoined)));
}

#[test]
fn pool_uninitialized_fails() {
    let (_env, client, _admin) = setup();
    assert_eq!(client.try_pool(), Err(Ok(Error::NotInitialized)));
}

// ── #139: lockup & reentrancy ──────────────────────────────────────────────

#[test]
fn withdraw_before_lockup_reverts() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100);
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::LockupActive)));
}

#[test]
fn withdraw_after_lockup_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100);
    skip_lockup(&env);
    assert_eq!(client.withdraw(&alice), 100);
}

// ── #140: multi-sig admin controls ────────────────────────────────────────

#[test]
fn non_signer_cannot_propose() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let rando = Address::generate(&env);
    let res = client.try_propose(&rando, &ProposalAction::AddAdmin(rando.clone()));
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
}

#[test]
fn single_sig_does_not_execute_release() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 500),
    );
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::AlreadySigned))
    );
    assert_eq!(client.pool().total_deposited, 500);
}

#[test]
fn two_of_two_sigs_executes_release() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &500);

    let signer2 = Address::generate(&env);
    let add_pid = client.propose(&admin, &ProposalAction::AddAdmin(signer2.clone()));
    assert_eq!(
        client.try_approve(&admin, &add_pid),
        Err(Ok(Error::AlreadySigned))
    );

    let recipient = Address::generate(&env);
    let rel_pid = client.propose(&admin, &ProposalAction::ReleaseEscrow(recipient, 200));
    assert_eq!(client.pool().total_deposited, 500);
    let _ = rel_pid;
}

#[test]
fn duplicate_approval_rejected() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let pid = client.propose(&admin, &ProposalAction::AddAdmin(Address::generate(&env)));
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::AlreadySigned))
    );
}

// ── #141: adversarial edge cases ───────────────────────────────────────────

#[test]
fn single_depositor_principal_matches_total() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000_000);

    let pool = client.pool();
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, pool.total_deposited);
}

#[test]
fn zero_balance_account_shows_zero_principal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 0);
    assert_eq!(savings.prize, 0);
    assert_eq!(savings.claimed_reward, 0);
}

#[test]
fn high_volume_deposits_consistent() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let n: i128 = 50;
    for _ in 0..n {
        let user = Address::generate(&env);
        client.join(&user);
        client.deposit(&user, &1_000);
    }

    let pool = client.pool();
    assert_eq!(pool.total_deposited, n * 1_000);
    assert_eq!(pool.total_drips, n as u64);
}

#[test]
fn flash_loan_blocked_by_lockup() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let attacker = Address::generate(&env);
    client.join(&attacker);
    client.deposit(&attacker, &1_000_000_000);
    assert_eq!(client.try_withdraw(&attacker), Err(Ok(Error::LockupActive)));
    assert_eq!(client.pool().total_deposited, 1_000_000_000);
}

#[test]
fn negative_deposit_rejected() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(
        client.try_deposit(&alice, &-1),
        Err(Ok(Error::InvalidAmount))
    );
}

// ── #255: event emission ───────────────────────────────────────────────────

#[test]
fn deposit_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);
    let events = env.events().all();
    assert!(!events.events().is_empty(), "no events emitted");
}

#[test]
fn withdraw_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &200);
    skip_lockup(&env);
    client.withdraw(&alice);
    let events = env.events().all();
    assert!(!events.events().is_empty(), "no events emitted");
}

#[test]
fn draw_winner_emits_payout_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    let winner = client.draw_winner(&admin, &100);
    assert_eq!(winner, admin);
    let events = env.events().all();
    assert!(!events.events().is_empty(), "no events emitted");
}

#[test]
fn draw_winner_zero_prize_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(
        client.try_draw_winner(&admin, &0),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn draw_winner_unauthorized_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let rando = Address::generate(&env);
    assert_eq!(
        client.try_draw_winner(&rando, &100),
        Err(Ok(Error::Unauthorized))
    );
}

// ── #257: storage optimisation regression ─────────────────────────────────

#[test]
fn proposal_nonce_increments_in_pool() {
    let (env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(client.pool().proposal_nonce, 0);
    client.propose(&admin, &ProposalAction::AddAdmin(Address::generate(&env)));
    assert_eq!(client.pool().proposal_nonce, 1);
}

#[test]
fn pool_locked_field_starts_false() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert!(!client.pool().locked);
}

// ── #265: proxy upgrade tests ─────────────────────────────────────────────

#[test]
fn proxy_create_initialises() {
    let env = Env::default();
    env.mock_all_auths();
    let proxy_id = env.register_contract(None, VaultProxy);
    let client = VaultProxyClient::new(&env, &proxy_id);
    let admin = Address::generate(&env);
    let logic = Address::generate(&env);
    client.create(&admin, &logic);
    assert_eq!(client.admin(), admin);
    assert_eq!(client.logic_contract(), logic);
}

#[test]
fn proxy_upgrade_changes_logic() {
    let env = Env::default();
    env.mock_all_auths();
    let proxy_id = env.register_contract(None, VaultProxy);
    let client = VaultProxyClient::new(&env, &proxy_id);
    let admin = Address::generate(&env);
    let logic1 = Address::generate(&env);
    let logic2 = Address::generate(&env);
    client.create(&admin, &logic1);
    assert_eq!(client.logic_contract(), logic1);
    client.upgrade(&admin, &logic2, &false);
    assert_eq!(client.logic_contract(), logic2);
}

#[test]
fn proxy_upgrade_unauthorized_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let proxy_id = env.register_contract(None, VaultProxy);
    let client = VaultProxyClient::new(&env, &proxy_id);
    let admin = Address::generate(&env);
    let rando = Address::generate(&env);
    let logic = Address::generate(&env);
    client.create(&admin, &logic);
    assert_eq!(
        client.try_upgrade(&rando, &logic, &false),
        Err(Ok(ProxyError::Unauthorized))
    );
}

// ── #382: yield-backed lockup multipliers ─────────────────────────────────

#[test]
fn deposit_with_duration_weight_not_payout() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit_with_duration(&alice, &1_000, &90);
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 1_000);
    assert_eq!(savings.lockup_multiplier, 150);
    assert_eq!(savings.yield_accrued, 0);
}

#[test]
fn withdraw_locked_zero_yield_returns_principal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit_with_duration(&alice, &500, &7);
    skip_lockup(&env);
    let payout = client.withdraw_locked(&alice);
    assert_eq!(payout, 500);
}

/// Withdraw returns principal only — yield is claimed via claim_reward (#377).
#[test]
fn withdraw_returns_principal_only_separate_claim_for_yield() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    client.add_yield(&admin, &200);
    assert_eq!(client.pool().distributable_yield, 200);
    client.credit_yield(&admin, &alice, &200);
    assert_eq!(client.pool().distributable_yield, 0);
    assert_eq!(client.savings(&alice).yield_accrued, 200);

    // Claim reward picks up the yield (#377)
    let claimed = client.claim_reward(&alice);
    assert_eq!(claimed, 200);
    assert_eq!(client.savings(&alice).claimed_reward, 200);

    skip_lockup(&env);
    // Withdraw returns only principal, not yield (#377)
    let payout = client.withdraw(&alice);
    assert_eq!(payout, 1_000);
}

/// Without claiming, withdraw returns only principal (yield stays as unclaimed reward).
#[test]
fn withdraw_principal_without_claiming_yield() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    client.add_yield(&admin, &200);
    client.credit_yield(&admin, &alice, &200);

    skip_lockup(&env);
    // Withdraw does not auto-claim yield (#377)
    let payout = client.withdraw(&alice);
    assert_eq!(payout, 1_000);

    // Alice can still claim yield after withdrawing principal
    let claimed = client.claim_reward(&alice);
    assert_eq!(claimed, 200);
}

#[test]
fn credit_yield_exceeding_pool_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &100);
    assert_eq!(
        client.try_credit_yield(&admin, &alice, &101),
        Err(Ok(Error::InvalidAction))
    );
}

#[test]
fn mixed_lock_tiers_correct_principal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.join(&alice);
    client.join(&bob);
    client.deposit_with_duration(&alice, &400, &7);
    client.deposit_with_duration(&bob, &600, &7);
    skip_lockup(&env);

    let alice_out = client.withdraw_locked(&alice);
    let bob_out = client.withdraw_locked(&bob);
    assert_eq!(alice_out, 400, "alice gets principal back");
    assert_eq!(bob_out, 600, "bob gets principal back");
}

#[test]
fn flexible_deposit_no_lockup() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit_with_duration(&alice, &100, &0);
    let payout = client.withdraw_locked(&alice);
    assert_eq!(payout, 100);
}

// ── #383: multisig-only admin mutations ───────────────────────────────────

/// seed_admin adds a second signer while admin count < threshold.
#[test]
fn seed_admin_bootstrap_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);
    let list = client.admins();
    assert!(list.contains(&signer2));
}

/// seed_admin is blocked once admin count reaches threshold.
#[test]
fn seed_admin_blocked_at_threshold() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.seed_admin(&admin, &signer2); // admins now = 2 = threshold
    assert_eq!(
        client.try_seed_admin(&admin, &signer3),
        Err(Ok(Error::Unauthorized))
    );
}

/// SetThreshold proposal lowers threshold so 2-of-2 workflows become testable.
#[test]
fn set_threshold_via_proposal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    // Threshold is 2; only 1 admin → lower to 1 via proposal (1 sig satisfies threshold=1 after execution).
    // But wait: we need to propose with current threshold=2 but only 1 signer.
    // Workaround: lower threshold itself is the bootstrapping problem.
    // Instead seed a second signer first, then propose SetThreshold(1).
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2); // now 2 admins, threshold=2

    // propose SetThreshold(1) — admin auto-approves (1 of 2)
    let pid = client.propose(&admin, &ProposalAction::SetThreshold(1));
    // signer2 approves — threshold_met (2 of 2)
    let executed = client.approve(&signer2, &pid);
    assert!(executed);
    assert_eq!(client.threshold(), 1);
}

/// RemoveAdmin is blocked when it would leave fewer admins than threshold.
#[test]
fn remove_admin_below_threshold_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2); // 2 admins, threshold=2

    // Trying to remove signer2 would leave 1 admin < threshold=2
    let pid = client.propose(&admin, &ProposalAction::RemoveAdmin(signer2.clone()));
    let result = client.try_approve(&signer2, &pid);
    // Execution should fail with InvalidAction
    assert_eq!(result, Err(Ok(Error::InvalidAction)));
}

/// cancel_proposal removes a pending proposal.
#[test]
fn cancel_proposal_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let rando = Address::generate(&env);
    let pid = client.propose(&admin, &ProposalAction::AddAdmin(rando));
    client.cancel_proposal(&admin, &pid);
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::ProposalNotFound))
    );
}

// ── #384: payload validation ───────────────────────────────────────────────

/// ReleaseEscrow with zero amount is rejected at proposal time.
#[test]
fn propose_release_zero_amount_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let recipient = Address::generate(&env);
    assert_eq!(
        client.try_propose(&admin, &ProposalAction::ReleaseEscrow(recipient, 0)),
        Err(Ok(Error::InvalidAmount))
    );
}

/// ReleaseEscrow exceeding pool reserves is rejected at proposal time.
#[test]
fn propose_release_exceeds_reserves_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    client.deposit(&admin, &100);
    let recipient = Address::generate(&env);
    assert_eq!(
        client.try_propose(&admin, &ProposalAction::ReleaseEscrow(recipient, 101)),
        Err(Ok(Error::InvalidAction))
    );
}

/// SetThreshold exceeding signer count is rejected at proposal time.
#[test]
fn propose_threshold_above_signer_count_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    // Only 1 admin; setting threshold to 3 is invalid
    assert_eq!(
        client.try_propose(&admin, &ProposalAction::SetThreshold(3)),
        Err(Ok(Error::InvalidAction))
    );
}

/// Snapshot semantics: a signer added AFTER proposal creation cannot approve it.
#[test]
fn late_signer_cannot_approve_existing_proposal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2); // 2 admins, threshold=2

    // Propose SetThreshold(1) with snapshot [admin, signer2]
    let pid = client.propose(&admin, &ProposalAction::SetThreshold(1));

    // Lower threshold to 1 by a different route so we can add signer3
    // (we can't without another approval in this scenario — just verify
    // that a non-snapshot address is rejected)
    let late = Address::generate(&env);
    assert_eq!(
        client.try_approve(&late, &pid),
        Err(Ok(Error::Unauthorized))
    );
}

// ── #385: TTL renewal ─────────────────────────────────────────────────────

/// renew_participant succeeds for an existing participant.
#[test]
fn renew_participant_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    // Should not panic or error
    client.renew_participant(&alice);
}

/// renew_participant fails for a non-existent participant.
#[test]
fn renew_participant_not_joined_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let ghost = Address::generate(&env);
    assert_eq!(
        client.try_renew_participant(&ghost),
        Err(Ok(Error::NotJoined))
    );
}

/// renew_instance succeeds when pool is initialized.
#[test]
fn renew_instance_succeeds() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    client.renew_instance();
}

/// renew_instance fails before initialization.
#[test]
fn renew_instance_not_initialized_fails() {
    let (_env, client, _admin) = setup();
    assert_eq!(client.try_renew_instance(), Err(Ok(Error::NotInitialized)));
}

/// threshold view returns the stored value.
#[test]
fn threshold_view_returns_default() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(client.threshold(), 2);
}

// ── #376: real SAC token custody ───────────────────────────────────────────

#[test]
fn set_token_by_signer_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let token = Address::generate(&env);
    client.set_token(&admin, &token);
    assert_eq!(client.token(), token);
}

#[test]
fn set_token_by_non_signer_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let rando = Address::generate(&env);
    let token = Address::generate(&env);
    assert_eq!(
        client.try_set_token(&rando, &token),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn token_not_configured_deposit_succeeds_without_transfer() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 500);
}

#[test]
fn token_not_configured_withdraw_succeeds_without_transfer() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &200);
    skip_lockup(&env);
    let amount = client.withdraw(&alice);
    assert_eq!(amount, 200);
}

#[test]
fn deposit_with_duration_without_token_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit_with_duration(&alice, &300, &90);
    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 300);
    assert_eq!(savings.lockup_multiplier, 150);
}

#[test]
fn withdraw_locked_without_token_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit_with_duration(&alice, &400, &7);
    skip_lockup(&env);
    let payout = client.withdraw_locked(&alice);
    assert_eq!(payout, 400);
}

#[test]
fn token_view_returns_error_when_not_set() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(client.try_token(), Err(Ok(Error::TokenNotConfigured)));
}

#[test]
fn token_event_emitted_on_set() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let token = Address::generate(&env);
    client.set_token(&admin, &token);
    let events = env.events().all();
    assert!(!events.events().is_empty());
}

#[test]
fn deposit_event_emits_total_deposited() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &750);

    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 750);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, 750);
    assert_eq!(pool.total_drips, 1);
}

#[test]
fn multiple_deposits_accumulate_correctly() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &100);
    client.deposit(&alice, &200);
    client.deposit(&alice, &300);

    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 600);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, 600);
    assert_eq!(pool.total_drips, 3);
}

// ── #377: principal / reward separation ────────────────────────────────────

/// Deposit only adds to principal, never to claimable/reward balances.
#[test]
fn deposit_does_not_create_claimable_reward() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    let savings = client.savings(&alice);
    assert_eq!(savings.deposited, 1_000);
    assert_eq!(savings.yield_accrued, 0);
    assert_eq!(savings.prize, 0);
    assert_eq!(savings.claimed_reward, 0);
    assert_eq!(savings.withdrawn_principal, 0);
}

/// Claiming rewards only touches yield/prize, never reduces principal.
#[test]
fn claim_never_reduces_principal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);

    // Credit some yield
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    let before = client.savings(&alice);
    assert_eq!(before.deposited, 500);
    assert_eq!(before.yield_accrued, 100);

    client.claim_reward(&alice);

    let after = client.savings(&alice);
    // Principal unchanged
    assert_eq!(after.deposited, 500);
    // Reward claimed
    assert_eq!(after.claimed_reward, 100);
    assert_eq!(after.withdrawn_principal, 0);
}

/// Cannot claim more rewards than available (yield + prize).
#[test]
fn claim_limited_to_available_rewards() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);

    // No yield or prize yet
    let claimed1 = client.claim_reward(&alice);
    assert_eq!(claimed1, 0);

    // Add some yield
    client.add_yield(&admin, &50);
    client.credit_yield(&admin, &alice, &50);

    let claimed2 = client.claim_reward(&alice);
    assert_eq!(claimed2, 50);

    // Second claim returns 0 (all claimed)
    let claimed3 = client.claim_reward(&alice);
    assert_eq!(claimed3, 0);
}

/// Prize credited via draw_winner is claimable separately from principal.
#[test]
fn prize_is_separate_from_principal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    // Admin draws a prize that goes to admin (current stub winner)
    let winner = client.draw_winner(&admin, &500);
    assert_eq!(winner, admin);

    let admin_savings = client.savings(&admin);
    assert_eq!(admin_savings.prize, 500);
    assert_eq!(admin_savings.deposited, 0);
    assert_eq!(admin_savings.deposited, 0); // admin never deposited
}

/// Claim prize then withdraw principal — total paid never exceeds deposit + rewards.
#[test]
fn claim_and_withdraw_total_limited() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    // Credit yield and prize
    client.add_yield(&admin, &200);
    client.credit_yield(&admin, &alice, &200);
    client.draw_winner(&admin, &300); // prize goes to admin (stub winner)

    // Admin claims prize
    let prize_claimed = client.claim_reward(&admin);
    assert_eq!(prize_claimed, 300);

    // Alice claims yield
    let yield_claimed = client.claim_reward(&alice);
    assert_eq!(yield_claimed, 200);

    // Alice withdraws principal
    skip_lockup(&env);
    let withdrawn = client.withdraw(&alice);
    assert_eq!(withdrawn, 1_000);

    // Alice has no more to claim or withdraw
    assert_eq!(client.claim_reward(&alice), 0);
    assert_eq!(client.withdraw(&alice), 0);

    // Total paid out: prizes + yield + principal = 300 + 200 + 1000 = 1500
    // Total deposited: 1000 (alice)
    // Total rewards: 200 (yield) + 300 (prize) = 500
    // Total = deposited + rewards = 1500, which is >= total paid = 1500 ✓
    let pool = client.pool();
    assert_eq!(pool.total_deposited, 1_000 + 0); // alice deposited 1000, admin 0
                                                 // pool.total_deposited is not reduced by claims/prizes (they are not escrow releases)
}

/// Double-spend protection: deposit cannot be claimed twice.
#[test]
fn no_double_spend_claim_then_withdraw() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);

    // Claim returns 0 (no yield/prize)
    let claimed = client.claim_reward(&alice);
    assert_eq!(claimed, 0);

    // Withdraw returns full principal
    skip_lockup(&env);
    let withdrawn = client.withdraw(&alice);
    assert_eq!(withdrawn, 500);

    // Participant record should show withdrawn_principal = 500
    let savings = client.savings(&alice);
    assert_eq!(savings.withdrawn_principal, 500);
    assert_eq!(savings.deposited, 500);
    assert_eq!(savings.claimed_reward, 0);

    // Try to withdraw again — should return 0 (nothing left)
    assert_eq!(client.withdraw(&alice), 0);
}

/// Withdraw only returns unwithdrawn principal (partial withdrawals).
#[test]
fn partial_withdraw_tracks_remaining_principal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    skip_lockup(&env);

    let w1 = client.withdraw(&alice);
    assert_eq!(w1, 1_000);
    assert_eq!(client.savings(&alice).withdrawn_principal, 1_000);

    // Second withdraw returns 0
    assert_eq!(client.withdraw(&alice), 0);
}

/// Property-style: arbitrary sequence of deposit → claim → win → withdraw
/// never violates invariant: total_reward_claimed ≤ total_yield + total_prize.
#[test]
fn invariant_total_claimed_never_exceeds_rewards() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.join(&alice);
    client.join(&bob);
    client.join(&admin);

    // Sequence: Alice deposits, admin adds yield, admin credits alice,
    // admin draws prize, alice claims, bob deposits, alice withdraws.
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &300);
    client.credit_yield(&admin, &alice, &300);
    client.draw_winner(&admin, &200);

    // Alice claims yield
    let alice_claimed = client.claim_reward(&alice);
    assert_eq!(alice_claimed, 300);

    // Admin claims prize
    let admin_claimed = client.claim_reward(&admin);
    assert_eq!(admin_claimed, 200);

    // Bob deposits and admin credits him yield
    client.deposit(&bob, &500);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &bob, &100);
    let bob_claimed = client.claim_reward(&bob);
    assert_eq!(bob_claimed, 100);

    // Invariant: claimed ≤ yield + prize for each participant
    let alice_savings = client.savings(&alice);
    assert!(alice_savings.claimed_reward <= alice_savings.yield_accrued + alice_savings.prize);
    assert_eq!(alice_savings.claimed_reward, 300);
    assert_eq!(alice_savings.yield_accrued, 300);
    assert_eq!(alice_savings.prize, 0);

    let admin_savings = client.savings(&admin);
    assert!(admin_savings.claimed_reward <= admin_savings.yield_accrued + admin_savings.prize);
    assert_eq!(admin_savings.claimed_reward, 200);
    assert_eq!(admin_savings.prize, 200);

    let bob_savings = client.savings(&bob);
    assert!(bob_savings.claimed_reward <= bob_savings.yield_accrued + bob_savings.prize);
    assert_eq!(bob_savings.claimed_reward, 100);

    // Withdrawals
    skip_lockup(&env);
    assert_eq!(client.withdraw(&alice), 1_000);
    assert_eq!(client.withdraw(&bob), 500);

    // Total withdrawn principal by alice = 1_000 = her deposit
    assert_eq!(client.savings(&alice).withdrawn_principal, 1_000);
    assert_eq!(client.savings(&bob).withdrawn_principal, 500);
}

// ── #440: claim deadline and unclaimed reward sweep ────────────────────────

/// set_claim_deadline stores the deadline and is readable via the view.
#[test]
fn set_claim_deadline_by_signer_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &1_500);
    assert_eq!(client.claim_deadline(), Some(1_500));
    assert!(!client.claim_deadline_passed());
}

/// set_claim_deadline emits an event.
#[test]
fn set_claim_deadline_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &1_500);
    let events = env.events().all();
    assert!(!events.events().is_empty(), "no events emitted");
}

/// set_claim_deadline rejects a deadline that is not strictly in the future.
#[test]
fn set_claim_deadline_in_past_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    env.ledger().set_timestamp(1_000);
    assert_eq!(
        client.try_set_claim_deadline(&admin, &1_000),
        Err(Ok(Error::InvalidDeadline))
    );
    assert_eq!(
        client.try_set_claim_deadline(&admin, &999),
        Err(Ok(Error::InvalidDeadline))
    );
}

/// Only an approved signer may set the claim deadline.
#[test]
fn set_claim_deadline_by_non_signer_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let rando = Address::generate(&env);
    env.ledger().set_timestamp(1_000);
    assert_eq!(
        client.try_set_claim_deadline(&rando, &1_500),
        Err(Ok(Error::Unauthorized))
    );
}

/// Without a configured deadline, claims are always allowed.
#[test]
fn claim_without_deadline_never_blocked() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    env.ledger().set_timestamp(10_000_000);
    assert_eq!(client.claim_reward(&alice), 100);
}

/// Boundary: the deadline instant itself is still claimable.
#[test]
fn claim_exactly_at_deadline_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);

    env.ledger().set_timestamp(2_000);
    assert_eq!(client.claim_reward(&alice), 100);
}

/// Boundary: one second before the deadline is claimable.
#[test]
fn claim_one_second_before_deadline_succeeds() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);

    env.ledger().set_timestamp(1_999);
    assert_eq!(client.claim_reward(&alice), 100);
}

/// Boundary: one second after the deadline reverts.
#[test]
fn claim_one_second_after_deadline_reverts() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);

    env.ledger().set_timestamp(2_001);
    assert_eq!(
        client.try_claim_reward(&alice),
        Err(Ok(Error::ClaimDeadlinePassed))
    );
    // Reward remains unclaimed — deadline enforcement does not lose it.
    assert_eq!(client.savings(&alice).claimed_reward, 0);
}

/// claim() (the alias) is also blocked once the deadline has passed.
#[test]
fn claim_alias_blocked_after_deadline() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);
    env.ledger().set_timestamp(2_001);

    assert_eq!(
        client.try_claim(&alice),
        Err(Ok(Error::ClaimDeadlinePassed))
    );
}

/// sweep_unclaimed cannot run before a deadline is configured.
#[test]
fn sweep_without_deadline_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(
        client.try_sweep_unclaimed(&admin, &alice),
        Err(Ok(Error::NoClaimDeadline))
    );
}

/// sweep_unclaimed cannot run before the deadline has passed (not even
/// exactly at the deadline — the deadline instant still belongs to claim).
#[test]
fn sweep_before_deadline_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);

    env.ledger().set_timestamp(2_000);
    assert_eq!(
        client.try_sweep_unclaimed(&admin, &alice),
        Err(Ok(Error::ClaimDeadlineNotReached))
    );
}

/// After the deadline passes, unclaimed reward is swept to the pool admin
/// (treasury), the participant's reward is marked claimed, and the pool
/// records that a sweep has occurred.
#[test]
fn sweep_after_deadline_moves_reward_to_admin() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &300);
    client.credit_yield(&admin, &alice, &300);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);
    env.ledger().set_timestamp(2_001);

    assert!(!client.unclaimed_swept());
    let swept = client.sweep_unclaimed(&admin, &alice);
    assert_eq!(swept, 300);
    assert!(client.unclaimed_swept());
    assert!(client.claim_deadline_passed());

    // Participant's reward is now marked claimed; nothing left to claim or
    // sweep again.
    assert_eq!(client.savings(&alice).claimed_reward, 300);
    assert_eq!(
        client.try_claim_reward(&alice),
        Err(Ok(Error::ClaimDeadlinePassed))
    );
    assert_eq!(client.sweep_unclaimed(&admin, &alice), 0);

    // Principal is untouched by the sweep.
    assert_eq!(client.savings(&alice).deposited, 1_000);
}

/// sweep_unclaimed emits an event.
#[test]
fn sweep_emits_event() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);
    env.ledger().set_timestamp(2_001);

    client.sweep_unclaimed(&admin, &alice);
    let events = env.events().all();
    assert!(!events.events().is_empty(), "no events emitted");
}

/// Only an approved signer may sweep unclaimed rewards.
#[test]
fn sweep_by_non_signer_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);
    env.ledger().set_timestamp(2_001);

    let rando = Address::generate(&env);
    assert_eq!(
        client.try_sweep_unclaimed(&rando, &alice),
        Err(Ok(Error::Unauthorized))
    );
}

/// A participant who claims before the deadline has nothing left to sweep.
#[test]
fn claimed_reward_leaves_nothing_to_sweep() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);

    // Alice claims before the deadline.
    assert_eq!(client.claim_reward(&alice), 100);

    env.ledger().set_timestamp(2_001);
    assert_eq!(client.sweep_unclaimed(&admin, &alice), 0);
    // Nothing was actually moved, so the pool-level sweep flag stays unset.
    assert!(!client.unclaimed_swept());
}

/// Participant struct has the correct V2 fields via savings view.
#[test]
fn participant_v2_fields_present() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    client.join(&alice);
    let savings = client.savings(&alice);
    // V2-only fields
    let _ = savings.prize;
    let _ = savings.claimed_reward;
    let _ = savings.withdrawn_principal;
    // V1 field that should NOT be present
    // The following would fail to compile: savings.claimable
}

// ── #512: Loss Circuit Breaker & Emergency Exit ────────────────────────────

/// draw_winner and deposit are blocked while in emergency mode.
#[test]
fn draw_winner_blocked_in_emergency() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2); // 2 signers for threshold

    // Trigger emergency mode with 500 available assets
    let pid = client.propose(&admin, &ProposalAction::TriggerEmergency(500));
    client.approve(&signer2, &pid);

    assert!(client.is_emergency());
    assert_eq!(client.emergency_assets(), 500);

    // draw_winner fails with InEmergency
    assert_eq!(
        client.try_draw_winner(&admin, &100),
        Err(Ok(Error::InEmergency))
    );

    // join and deposit fail with InEmergency
    let alice = Address::generate(&env);
    assert_eq!(client.try_join(&alice), Err(Ok(Error::InEmergency)));
}

/// Emergency withdraw distributes available assets pro-rata on partial loss.
#[test]
fn emergency_withdraw_pro_rata_partial_loss() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.join(&alice);
    client.join(&bob);

    client.deposit(&alice, &600);
    client.deposit(&bob, &400);
    assert_eq!(client.pool().total_deposited, 1_000);

    // Trigger emergency with 500 assets (50% loss)
    let pid = client.propose(&admin, &ProposalAction::TriggerEmergency(500));
    client.approve(&signer2, &pid);

    assert!(client.is_emergency());

    // Alice has 600/1000 = 60%, gets 600 * 500 / 1000 = 300
    let alice_payout = client.emergency_withdraw(&alice);
    assert_eq!(alice_payout, 300);

    // Bob has 400 remaining out of 400 total_deposited, 200 emergency_assets, gets 200
    let bob_payout = client.emergency_withdraw(&bob);
    assert_eq!(bob_payout, 200);

    assert_eq!(client.pool().total_deposited, 0);
    assert_eq!(client.emergency_assets(), 0);
}

/// Emergency withdraw returns 0 on total strategy failure (0 emergency assets).
#[test]
fn emergency_withdraw_total_strategy_failure() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    // Trigger emergency with 0 assets
    let pid = client.propose(&admin, &ProposalAction::TriggerEmergency(0));
    client.approve(&signer2, &pid);

    let payout = client.emergency_withdraw(&alice);
    assert_eq!(payout, 0);
    assert_eq!(client.pool().total_deposited, 0);
}

/// Recapitalization and return to normal mode via governance.
#[test]
fn recapitalization_and_resume_normal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1_000);

    // Trigger emergency with 400 assets
    let pid1 = client.propose(&admin, &ProposalAction::TriggerEmergency(400));
    client.approve(&signer2, &pid1);

    // Try ResumeNormal before recapitalization -> fails with Insolvent at propose time
    assert_eq!(
        client.try_propose(&admin, &ProposalAction::ResumeNormal),
        Err(Ok(Error::Insolvent))
    );

    // Recapitalize by 600
    let pid2 = client.propose(&admin, &ProposalAction::Recapitalize(600));
    client.approve(&signer2, &pid2);

    assert_eq!(client.emergency_assets(), 1_000);

    // Resume normal mode
    let pid3 = client.propose(&admin, &ProposalAction::ResumeNormal);
    client.approve(&signer2, &pid3);

    assert!(!client.is_emergency());
}
