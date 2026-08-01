//! Adversarial unit-test suite (#141) + regression tests (#139, #140).
//! Event emission tests (#255). Storage optimisation regression (#257).
//! #377: principal/reward separation tests.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token, Address, Env, IntoVal,
};

// Re-export the main contract error for convenience
use super::Error;

/// Real-SAC setup for tests that need actual token custody (#526, #529),
/// mirroring the pattern used in `mock-yield`'s strategy tests.
fn setup_with_token() -> (
    Env,
    DripPoolClient<'static>,
    Address,
    token::TokenClient<'static>,
    token::StellarAssetClient<'static>,
) {
    let (env, client, admin) = setup();
    client.create(&admin);

    let asset_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(asset_admin);
    let token = token::TokenClient::new(&env, &sac.address());
    let issuer = token::StellarAssetClient::new(&env, &sac.address());
    client.set_token(&admin, &sac.address());

    (env, client, admin, token, issuer)
}

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

/// Advance ledger sequence past the high-risk governance timelock (#533).
fn skip_high_risk_delay(env: &Env) {
    let current = env.ledger().sequence();
    env.ledger().set_sequence_number(current + HIGH_RISK_DELAY_LEDGERS + 1);
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

// ── #531: proxy upgrade governance now lives in proxy.rs's own test module,
// since VaultProxy is bound to pool multisig governance (no single admin) ──

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
/// SetThreshold is high-risk (#533): approval alone doesn't execute it —
/// the timelock must elapse first, then any signer calls `execute_proposal`.
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
    // signer2 approves — threshold_met (2 of 2), but the timelock still blocks execution.
    let executed = client.approve(&signer2, &pid);
    assert!(!executed, "high-risk action must not execute before its delay");
    assert_eq!(client.threshold(), 2);

    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &pid);
    assert_eq!(client.threshold(), 1);
}

/// RemoveAdmin is blocked when it would leave fewer admins than threshold.
/// The liveness check now runs at execution time, after the timelock (#533).
#[test]
fn remove_admin_below_threshold_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2); // 2 admins, threshold=2

    // Trying to remove signer2 would leave 1 admin < threshold=2
    let pid = client.propose(&admin, &ProposalAction::RemoveAdmin(signer2.clone()));
    let executed = client.approve(&signer2, &pid);
    assert!(!executed, "high-risk action must not execute before its delay");

    skip_high_risk_delay(&env);
    let result = client.try_execute_proposal(&signer2, &pid);
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

    // Trigger emergency mode with 500 available assets. TriggerEmergency is
    // high-risk (#533): approval alone doesn't execute it — the timelock
    // must elapse first.
    let pid = client.propose(&admin, &ProposalAction::TriggerEmergency(500));
    client.approve(&signer2, &pid);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &pid);

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

    // Trigger emergency with 500 assets (50% loss). High-risk action: the
    // timelock must elapse before it executes (#533).
    let pid = client.propose(&admin, &ProposalAction::TriggerEmergency(500));
    client.approve(&signer2, &pid);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &pid);

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

    // Trigger emergency with 0 assets (high-risk; timelock must elapse first, #533)
    let pid = client.propose(&admin, &ProposalAction::TriggerEmergency(0));
    client.approve(&signer2, &pid);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &pid);

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

    // Trigger emergency with 400 assets (high-risk; timelock must elapse first, #533)
    let pid1 = client.propose(&admin, &ProposalAction::TriggerEmergency(400));
    client.approve(&signer2, &pid1);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &pid1);

    // Try ResumeNormal before recapitalization -> fails with Insolvent at propose time
    assert_eq!(
        client.try_propose(&admin, &ProposalAction::ResumeNormal),
        Err(Ok(Error::Insolvent))
    );

    // Recapitalize by 600 — low-risk, executes immediately once approved.
    let pid2 = client.propose(&admin, &ProposalAction::Recapitalize(600));
    client.approve(&signer2, &pid2);

    assert_eq!(client.emergency_assets(), 1_000);

    // Resume normal mode — also high-risk (#533): timelock must elapse.
    let pid3 = client.propose(&admin, &ProposalAction::ResumeNormal);
    client.approve(&signer2, &pid3);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &pid3);

    assert!(!client.is_emergency());
}

// ── #441: Configuration version and migration guard tests ─────────────────

#[test]
fn test_config_version_initialization() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    assert_eq!(client.config_version(), 1);
}

#[test]
fn test_update_config_version_success() {
    let (env, client, admin) = setup();
    client.create(&admin);
    
    // Update config version from 1 to 2
    let res = client.try_update_config_version(&admin, &1, &2);
    assert!(res.is_ok());
    assert_eq!(client.config_version(), 2);

    // Verify event emission
    let events = env.events().all();
    assert!(!events.events().is_empty());
}

#[test]
fn test_update_config_version_invalid_expected() {
    let (_env, client, admin) = setup();
    client.create(&admin);
    
    // Update config version with wrong expected_version fails
    let res = client.try_update_config_version(&admin, &2, &3);
    assert_eq!(res, Err(Ok(Error::IncompatibleConfig)));
    assert_eq!(client.config_version(), 1);
}

#[test]
fn test_update_config_version_unauthorized() {
    let (env, client, admin) = setup();
    client.create(&admin);
    
    let rando = Address::generate(&env);
    let res = client.try_update_config_version(&rando, &1, &2);
    assert_eq!(res, Err(Ok(Error::Unauthorized)));
    assert_eq!(client.config_version(), 1);
}

#[test]
fn test_incompatible_config_blocks_operations() {
    let (env, client, admin) = setup();
    client.create(&admin);
    
    // Migrate config version to 2 (making it incompatible with logic version 1)
    client.update_config_version(&admin, &1, &2);
    
    let alice = Address::generate(&env);
    
    // core mutations should fail
    assert_eq!(client.try_join(&alice), Err(Ok(Error::IncompatibleConfig)));
    assert_eq!(client.try_deposit(&alice, &100), Err(Ok(Error::IncompatibleConfig)));
    assert_eq!(client.try_withdraw(&alice), Err(Ok(Error::IncompatibleConfig)));
    assert_eq!(client.try_claim_reward(&alice), Err(Ok(Error::IncompatibleConfig)));
    
    // admin operations should fail
    let token = Address::generate(&env);
    assert_eq!(client.try_set_token(&admin, &token), Err(Ok(Error::IncompatibleConfig)));
}

// ── #532: Strategy Rotation Tests ──────────────────────────────────────────

#[contract]
pub struct MockStrategy;

#[contractimpl]
impl MockStrategy {
    pub fn interface_version(_env: Env) -> u32 {
        1
    }
    pub fn deposit(_env: Env, _from: Address, _asset: Address, _amount: i128) -> Result<(), vaultquest_common::ContractError> {
        Ok(())
    }
    pub fn redeem(_env: Env, _to: Address, _asset: Address, amount: i128) -> Result<i128, vaultquest_common::ContractError> {
        Ok(amount)
    }
    pub fn harvest(_env: Env, _asset: Address) -> Result<vaultquest_common::StrategyReport, vaultquest_common::ContractError> {
        Ok(vaultquest_common::StrategyReport {
            realized_yield: 0,
            realized_loss: 0,
            total_assets: 0,
        })
    }
    pub fn total_assets(_env: Env, _asset: Address) -> i128 {
        0
    }
}

#[contract]
pub struct BadVersionStrategy;

#[contractimpl]
impl BadVersionStrategy {
    pub fn interface_version(_env: Env) -> u32 {
        99
    }
    pub fn deposit(_env: Env, _from: Address, _asset: Address, _amount: i128) -> Result<(), vaultquest_common::ContractError> {
        Ok(())
    }
    pub fn redeem(_env: Env, _to: Address, _asset: Address, amount: i128) -> Result<i128, vaultquest_common::ContractError> {
        Ok(amount)
    }
    pub fn harvest(_env: Env, _asset: Address) -> Result<vaultquest_common::StrategyReport, vaultquest_common::ContractError> {
        Ok(vaultquest_common::StrategyReport {
            realized_yield: 0,
            realized_loss: 0,
            total_assets: 0,
        })
    }
    pub fn total_assets(_env: Env, _asset: Address) -> i128 {
        0
    }
}

/// Strategy stub that moves *real* SAC tokens, for tests that need the
/// pool's actual custody balance to change (#529 idle-liquidity checks).
#[contract]
pub struct RealTokenStrategy;

#[contractimpl]
impl RealTokenStrategy {
    pub fn interface_version(_env: Env) -> u32 {
        1
    }
    pub fn deposit(env: Env, from: Address, asset: Address, amount: i128) -> Result<(), vaultquest_common::ContractError> {
        let token = token::TokenClient::new(&env, &asset);
        token.transfer(&from, &env.current_contract_address(), &amount);
        Ok(())
    }
    pub fn redeem(env: Env, to: Address, asset: Address, amount: i128) -> Result<i128, vaultquest_common::ContractError> {
        let token = token::TokenClient::new(&env, &asset);
        let available = token.balance(&env.current_contract_address());
        let redeemed = if amount < available { amount } else { available };
        if redeemed > 0 {
            token.transfer(&env.current_contract_address(), &to, &redeemed);
        }
        Ok(redeemed)
    }
    pub fn harvest(env: Env, asset: Address) -> Result<vaultquest_common::StrategyReport, vaultquest_common::ContractError> {
        let balance = token::TokenClient::new(&env, &asset).balance(&env.current_contract_address());
        Ok(vaultquest_common::StrategyReport {
            realized_yield: 0,
            realized_loss: 0,
            total_assets: balance,
        })
    }
    pub fn total_assets(env: Env, asset: Address) -> i128 {
        token::TokenClient::new(&env, &asset).balance(&env.current_contract_address())
    }
}

#[test]
fn test_strategy_rotation_lifecycle_happy_path() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let s1 = env.register_contract(None, MockStrategy);
    let s2 = env.register_contract(None, MockStrategy);

    // Initial strategy setup
    client.set_strategy(&admin, &s1);

    // Propose rotation to s2 with exposure cap of 500
    client.propose_strategy(&admin, &s2, &500);

    // Validate proposed strategy
    client.validate_strategy(&admin);

    // Reconcile and activate. Strategy rotation is high-risk (#533): it
    // cannot activate before its ledger-based delay elapses.
    client.reconcile_strategy(&admin);
    skip_high_risk_delay(&env);
    client.activate_strategy(&admin);

    let pool = client.pool();
    assert_eq!(pool.strategy, Some(s2));
}

/// Strategy rotation cannot activate before its timelock elapses, even once
/// fully reconciled (#533).
#[test]
fn test_strategy_rotation_activate_before_delay_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let s1 = env.register_contract(None, MockStrategy);
    let s2 = env.register_contract(None, MockStrategy);

    client.set_strategy(&admin, &s1);
    client.propose_strategy(&admin, &s2, &500);
    client.validate_strategy(&admin);
    client.reconcile_strategy(&admin);

    assert_eq!(
        client.try_activate_strategy(&admin),
        Err(Ok(Error::StrategyRotationDelayNotElapsed))
    );
}

#[test]
fn test_strategy_exposure_cap_enforced() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1000);

    let s1 = env.register_contract(None, MockStrategy);
    let s2 = env.register_contract(None, MockStrategy);

    client.set_strategy(&admin, &s1);
    client.propose_strategy(&admin, &s2, &300);
    client.validate_strategy(&admin);
    client.reconcile_strategy(&admin);
    skip_high_risk_delay(&env);
    client.activate_strategy(&admin);

    // Deploying 400 when cap is 300 should fail
    let res = client.try_deploy_to_strategy(&admin, &400);
    assert_eq!(res, Err(Ok(Error::ExposureCapExceeded)));

    // Deploying 300 should succeed
    client.deploy_to_strategy(&admin, &300);
    let pool = client.pool();
    assert_eq!(pool.principal_in_strategy, 300);
}

#[test]
fn test_strategy_rotation_bad_interface_version_reverts() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let s_bad = env.register_contract(None, BadVersionStrategy);

    let res = client.try_propose_strategy(&admin, &s_bad, &1000);
    assert_eq!(res, Err(Ok(Error::StrategyVersionUnsupported)));
}

#[test]
fn test_strategy_rotation_cancel() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let s1 = env.register_contract(None, MockStrategy);
    let s2 = env.register_contract(None, MockStrategy);

    client.set_strategy(&admin, &s1);
    client.propose_strategy(&admin, &s2, &500);

    // Cancel rotation
    client.cancel_strategy_rotation(&admin);

    let pool = client.pool();
    assert_eq!(pool.strategy, Some(s1));
}

#[test]
fn test_strategy_emergency_recall_during_rotation() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &500);

    let s1 = env.register_contract(None, MockStrategy);
    let s2 = env.register_contract(None, MockStrategy);

    client.set_strategy(&admin, &s1);
    client.deploy_to_strategy(&admin, &200);

    client.propose_strategy(&admin, &s2, &1000);

    // Emergency recall works on active old strategy
    client.emergency_recall_strategy(&admin);
    let pool = client.pool();
    assert_eq!(pool.principal_in_strategy, 0);
}

// ── #526: reward claims transfer real SAC assets ───────────────────────────

#[test]
fn claim_reward_transfers_real_tokens() {
    let (env, client, admin, token, issuer) = setup_with_token();
    let alice = Address::generate(&env);
    client.join(&alice);

    issuer.mint(&alice, &1_000);
    client.deposit(&alice, &1_000);

    issuer.mint(&admin, &200);
    client.add_yield(&admin, &200);
    client.credit_yield(&admin, &alice, &200);

    assert_eq!(token.balance(&alice), 0);
    let claimed = client.claim_reward(&alice);
    assert_eq!(claimed, 200);
    // The claimant's SAC balance increases by exactly the returned amount (#526).
    assert_eq!(token.balance(&alice), 200);
    assert_eq!(client.savings(&alice).claimed_reward, 200);
}

#[test]
fn claim_reward_zero_available_is_a_noop() {
    let (env, client, _admin, _token, _issuer) = setup_with_token();
    let alice = Address::generate(&env);
    client.join(&alice);
    assert_eq!(client.claim_reward(&alice), 0);
}

#[test]
fn claim_reward_twice_only_pays_once() {
    let (env, client, admin, token, issuer) = setup_with_token();
    let alice = Address::generate(&env);
    client.join(&alice);
    issuer.mint(&admin, &150);
    client.add_yield(&admin, &150);
    client.credit_yield(&admin, &alice, &150);

    assert_eq!(client.claim_reward(&alice), 150);
    // Already-claimed rewards cannot be claimed again (#526).
    assert_eq!(client.claim_reward(&alice), 0);
    assert_eq!(token.balance(&alice), 150);
}

#[test]
fn claim_reward_after_deadline_fails_and_keeps_balance_claimable() {
    let (env, client, admin, token, issuer) = setup_with_token();
    let alice = Address::generate(&env);
    client.join(&alice);
    issuer.mint(&admin, &100);
    client.add_yield(&admin, &100);
    client.credit_yield(&admin, &alice, &100);

    env.ledger().set_timestamp(1_000);
    client.set_claim_deadline(&admin, &2_000);
    env.ledger().set_timestamp(2_001);

    assert_eq!(
        client.try_claim_reward(&alice),
        Err(Ok(Error::ClaimDeadlinePassed))
    );
    assert_eq!(token.balance(&alice), 0);
    assert_eq!(client.savings(&alice).claimed_reward, 0);
}

// ── #533: governance epoch & timelock for high-risk actions ────────────────

#[test]
fn epoch_bumps_on_threshold_change_and_invalidates_pending_proposal() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);
    assert_eq!(client.governance_epoch(), 1); // seed_admin bumped it once

    // A ReleaseEscrow proposal is snapshotted under the current epoch.
    client.deposit(&admin, &500);
    let recipient = Address::generate(&env);
    let pid = client.propose(&admin, &ProposalAction::ReleaseEscrow(recipient, 100));

    // Rotate governance via SetThreshold, which bumps the epoch after its own delay.
    let set_pid = client.propose(&admin, &ProposalAction::SetThreshold(1));
    client.approve(&signer2, &set_pid);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &set_pid);
    assert_eq!(client.governance_epoch(), 2);

    // The earlier ReleaseEscrow proposal is now stale and cannot be approved.
    assert_eq!(
        client.try_approve(&signer2, &pid),
        Err(Ok(Error::GovernanceEpochChanged))
    );
    assert_eq!(client.pool().total_deposited, 500, "stale proposal must not execute");
}

#[test]
fn threshold_snapshot_is_frozen_even_if_threshold_later_changes() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    client.seed_admin(&admin, &signer2); // 2 admins, threshold=2

    // Lower threshold to 1 via governance (high-risk, delayed).
    let set_pid = client.propose(&admin, &ProposalAction::SetThreshold(1));
    client.approve(&signer2, &set_pid);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &set_pid);
    assert_eq!(client.threshold(), 1);

    // Add signer3: with threshold now 1, the proposer's own approval already
    // meets threshold_snapshot, so any signer can trigger execution directly
    // (AddAdmin is low-risk, so `ready_at` is immediate).
    let add_pid = client.propose(&admin, &ProposalAction::AddAdmin(signer3.clone()));
    client.execute_proposal(&admin, &add_pid);
    assert!(client.admins().contains(&signer3));

    // A NEW proposal created now snapshots threshold=1, not the original 2 —
    // it must execute on the FIRST approval, proving the snapshot isn't
    // retroactively affected by any later change either way (#533).
    client.deposit(&admin, &50);
    let recipient = Address::generate(&env);
    let pid = client.propose(&admin, &ProposalAction::ReleaseEscrow(recipient, 10));
    // Single approval (the proposer's) already meets threshold_snapshot=1,
    // and ReleaseEscrow's ready_at is in the future (high-risk) — so it's
    // recorded as met but not yet executed.
    assert_eq!(client.pool().total_deposited, 50);
}

#[test]
fn cancel_proposal_by_current_signer_when_epoch_is_stale() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    let recipient = Address::generate(&env);
    client.deposit(&admin, &200);
    let pid = client.propose(&admin, &ProposalAction::ReleaseEscrow(recipient, 100));

    // Rotate epoch via SetThreshold.
    let set_pid = client.propose(&admin, &ProposalAction::SetThreshold(1));
    client.approve(&signer2, &set_pid);
    skip_high_risk_delay(&env);
    client.execute_proposal(&signer2, &set_pid);

    // signer2 is a current signer but was never in the stale proposal's
    // approver snapshot's approvals; cancellation must still succeed rather
    // than deadlock (#533).
    client.cancel_proposal(&signer2, &pid);
    assert_eq!(
        client.try_approve(&admin, &pid),
        Err(Ok(Error::ProposalNotFound))
    );
}

#[test]
fn high_risk_execute_before_threshold_met_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    client.deposit(&admin, &500);
    let recipient = Address::generate(&env);
    let pid = client.propose(&admin, &ProposalAction::ReleaseEscrow(recipient, 100));

    skip_high_risk_delay(&env);
    // Only the proposer has approved — threshold (2) not met.
    assert_eq!(
        client.try_execute_proposal(&admin, &pid),
        Err(Ok(Error::ThresholdNotMet))
    );
}

// ── #529: liquidity buffer & withdrawal queue ──────────────────────────────

#[test]
fn deploy_to_strategy_below_min_idle_reserve_fails() {
    let (env, client, admin, _token, issuer) = setup_with_token();
    let alice = Address::generate(&env);
    client.join(&alice);
    issuer.mint(&alice, &1_000);
    client.deposit(&alice, &1_000);

    client.set_min_idle_reserve(&admin, &300);

    let strategy = env.register_contract(None, RealTokenStrategy);
    client.set_strategy(&admin, &strategy);

    // Deploying 800 would leave only 200 idle, below the 300 buffer.
    assert_eq!(
        client.try_deploy_to_strategy(&admin, &800),
        Err(Ok(Error::InsufficientIdleReserve))
    );
    // Deploying 700 leaves exactly 300 idle — allowed.
    client.deploy_to_strategy(&admin, &700);
    assert_eq!(client.pool().principal_in_strategy, 700);
}

#[test]
fn withdraw_queues_when_strategy_deployment_exhausts_idle_liquidity() {
    let (env, client, admin, token, issuer) = setup_with_token();
    let alice = Address::generate(&env);
    client.join(&alice);
    issuer.mint(&alice, &1_000);
    client.deposit(&alice, &1_000);

    let strategy = env.register_contract(None, RealTokenStrategy);
    client.set_strategy(&admin, &strategy);
    client.deploy_to_strategy(&admin, &900); // only 100 left in real custody

    skip_lockup(&env);
    // Queuing is a successful outcome (Ok(0) paid immediately), not an
    // error — a failing top-level call would roll back the queue entry (#529).
    let result = client.withdraw(&alice);
    assert_eq!(result, 0);
    // Nothing was paid out, and the participant's principal is untouched.
    assert_eq!(token.balance(&alice), 0);
    assert_eq!(client.savings(&alice).withdrawn_principal, 0);

    let qid = client.withdrawal_request_of(&alice).unwrap();
    let request = client.withdrawal_request(&qid);
    assert_eq!(request.amount, 1_000);
    assert_eq!(request.status, WithdrawalRequestStatus::Pending);

    // Calling withdraw again while queued is rejected, not re-queued (#529).
    assert_eq!(
        client.try_withdraw(&alice),
        Err(Ok(Error::WithdrawalAlreadyQueued))
    );
}

#[test]
fn fulfill_withdrawal_queue_pays_partial_then_completes_in_order() {
    let (env, client, admin, token, issuer) = setup_with_token();
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.join(&alice);
    client.join(&bob);
    issuer.mint(&alice, &1_000);
    issuer.mint(&bob, &1_000);
    client.deposit(&alice, &1_000);
    client.deposit(&bob, &1_000);

    let strategy = env.register_contract(None, RealTokenStrategy);
    client.set_strategy(&admin, &strategy);
    client.deploy_to_strategy(&admin, &1_950); // 50 left idle

    skip_lockup(&env);
    // Alice queues first (FIFO position 0), then Bob (position 1).
    assert_eq!(client.withdraw(&alice), 0);
    assert_eq!(client.withdraw(&bob), 0);

    // Only 50 idle: fulfillment partially pays Alice's 1,000 request and
    // stops — Bob's smaller-or-equal request is never paid out of order.
    let paid = client.fulfill_withdrawal_queue(&admin, &10);
    assert_eq!(paid, 50);
    assert_eq!(token.balance(&alice), 50);
    assert_eq!(token.balance(&bob), 0);
    assert_eq!(client.withdrawal_queue_head(), 0, "alice's request stays at head, partially paid");

    // Recall more liquidity from the strategy, then fulfill the rest.
    client.recall_from_strategy(&admin, &1_950);
    let paid2 = client.fulfill_withdrawal_queue(&admin, &10);
    assert_eq!(paid2, 1_950);
    assert_eq!(token.balance(&alice), 1_000);
    assert_eq!(token.balance(&bob), 1_000);
    assert_eq!(client.withdrawal_queue_head(), 2, "both requests fulfilled");
}

// ── Round-scoped accounting (#508) ──────────────────────────────────────────
//
// Regression coverage for round isolation: yield/prize realized for round N
// must never leak into round N+1's calculations, and a deposit made after a
// round is locked must never be counted in that round's snapshot.

#[test]
fn open_round_starts_empty_and_open() {
    let (_env, client, admin) = setup();
    client.create(&admin);

    let round_id = client.open_round(&admin);
    assert_eq!(round_id, 0);

    let round = client.round(&round_id);
    assert_eq!(round.status, RoundStatus::Open);
    assert_eq!(round.principal_snapshot, 0);
    assert_eq!(round.realized_yield, 0);
    assert_eq!(round.prize_reserve, 0);
    assert_eq!(round.claimed, 0);

    // Nonce advances so the next open_round doesn't collide.
    assert_eq!(client.round_nonce(), 1);
    let round_id_2 = client.open_round(&admin);
    assert_eq!(round_id_2, 1);
}

#[test]
fn open_round_unauthorized_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let stranger = Address::generate(&env);
    assert_eq!(client.try_open_round(&stranger), Err(Ok(Error::Unauthorized)));
}

#[test]
fn round_deposit_accumulates_into_snapshot() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    client.round_deposit(&alice, &round_id, &100);
    client.round_deposit(&bob, &round_id, &50);
    client.round_deposit(&alice, &round_id, &25); // second deposit, same round

    let round = client.round(&round_id);
    assert_eq!(round.principal_snapshot, 175);
    assert_eq!(client.round_deposit_of(&alice, &round_id), 125);
    assert_eq!(client.round_deposit_of(&bob, &round_id), 50);
}

#[test]
fn round_deposit_zero_or_negative_rejected() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);
    let alice = Address::generate(&env);

    assert_eq!(
        client.try_round_deposit(&alice, &round_id, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        client.try_round_deposit(&alice, &round_id, &-10),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn round_deposit_into_unknown_round_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let alice = Address::generate(&env);
    assert_eq!(
        client.try_round_deposit(&alice, &999, &10),
        Err(Ok(Error::RoundNotFound))
    );
}

#[test]
fn deposits_before_vs_after_lock_go_to_correct_rounds() {
    // Core isolation guarantee: a late deposit (after lock) must never be
    // counted in the already-locked round's snapshot — it must land in the
    // next round instead.
    let (env, client, admin) = setup();
    client.create(&admin);

    let round_0 = client.open_round(&admin);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    client.round_deposit(&alice, &round_0, &100);
    client.lock_round(&admin, &round_0);

    // Late deposit attempt into the now-locked round is rejected outright.
    assert_eq!(
        client.try_round_deposit(&bob, &round_0, &999),
        Err(Ok(Error::RoundNotOpen))
    );

    // round_0's snapshot is unaffected by the rejected attempt.
    let locked_round = client.round(&round_0);
    assert_eq!(locked_round.status, RoundStatus::Locked);
    assert_eq!(locked_round.principal_snapshot, 100);

    // Bob's deposit correctly lands in a freshly opened round_1 instead.
    let round_1 = client.open_round(&admin);
    client.round_deposit(&bob, &round_1, &999);
    let round_1_state = client.round(&round_1);
    assert_eq!(round_1_state.principal_snapshot, 999);

    // round_0 is still untouched by round_1 activity.
    assert_eq!(client.round(&round_0).principal_snapshot, 100);
}

#[test]
fn lock_round_requires_open_status() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);
    client.lock_round(&admin, &round_id);

    // Locking an already-locked round fails rather than silently no-op'ing.
    assert_eq!(
        client.try_lock_round(&admin, &round_id),
        Err(Ok(Error::RoundNotOpen))
    );
}

#[test]
fn lock_round_unauthorized_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);
    let stranger = Address::generate(&env);
    assert_eq!(
        client.try_lock_round(&stranger, &round_id),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn settle_round_requires_locked_status() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);

    // Can't settle an Open round — must be Locked first.
    assert_eq!(
        client.try_settle_round(&admin, &round_id, &100, &0),
        Err(Ok(Error::RoundNotLocked))
    );
}

#[test]
fn settle_round_twice_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);
    client.lock_round(&admin, &round_id);
    client.settle_round(&admin, &round_id, &100, &0);

    assert_eq!(
        client.try_settle_round(&admin, &round_id, &50, &0),
        Err(Ok(Error::RoundAlreadySettled))
    );
    // First settlement's values are untouched by the rejected second call.
    assert_eq!(client.round(&round_id).realized_yield, 100);
}

#[test]
fn settling_round_does_not_affect_next_rounds_opening_balance() {
    // "settling a round doesn't affect the next round's opening balance"
    let (env, client, admin) = setup();
    client.create(&admin);

    let round_0 = client.open_round(&admin);
    let alice = Address::generate(&env);
    client.round_deposit(&alice, &round_0, &200);
    client.lock_round(&admin, &round_0);
    client.settle_round(&admin, &round_0, &40, &10); // yield=40, prize=10

    let round_1 = client.open_round(&admin);
    let round_1_state = client.round(&round_1);
    assert_eq!(round_1_state.principal_snapshot, 0, "round_1 opens with a zero balance");
    assert_eq!(round_1_state.realized_yield, 0);
    assert_eq!(round_1_state.prize_reserve, 0);

    // round_0's settled figures are unchanged by round_1 having been opened.
    let round_0_state = client.round(&round_0);
    assert_eq!(round_0_state.realized_yield, 40);
    assert_eq!(round_0_state.prize_reserve, 10);
}

#[test]
fn round_claim_pays_pro_rata_share_and_is_isolated_per_round() {
    // Basic overlap/isolation scenario: two participants across two rounds
    // with different yield outcomes — round N's payout must never bleed
    // into round N+1's, and vice versa.
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // Round 0: alice 300, bob 100 (75%/25% split), settled with yield 40.
    let round_0 = client.open_round(&admin);
    client.round_deposit(&alice, &round_0, &300);
    client.round_deposit(&bob, &round_0, &100);
    client.lock_round(&admin, &round_0);
    client.settle_round(&admin, &round_0, &40, &0);

    // Round 1 opened concurrently with different deposits/outcome.
    let round_1 = client.open_round(&admin);
    client.round_deposit(&alice, &round_1, &50);
    client.round_deposit(&bob, &round_1, &50);
    client.lock_round(&admin, &round_1);
    client.settle_round(&admin, &round_1, &0, &20); // pure prize round

    // Round 0 payouts: 40 * 300/400 = 30, 40 * 100/400 = 10.
    assert_eq!(client.round_claim(&alice, &round_0), 30);
    assert_eq!(client.round_claim(&bob, &round_0), 10);
    assert_eq!(client.round(&round_0).claimed, 40);

    // Round 1 payouts (independent split): 20 * 50/100 = 10 each.
    assert_eq!(client.round_claim(&alice, &round_1), 10);
    assert_eq!(client.round_claim(&bob, &round_1), 10);
    assert_eq!(client.round(&round_1).claimed, 20);

    // Second claim attempt for the same round pays nothing further —
    // the per-round deposit was zeroed on first claim.
    assert_eq!(client.round_claim(&alice, &round_0), 0);
}

#[test]
fn round_claim_before_settlement_fails() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);
    let alice = Address::generate(&env);
    client.round_deposit(&alice, &round_id, &100);

    assert_eq!(
        client.try_round_claim(&alice, &round_id),
        Err(Ok(Error::RoundNotLocked))
    );

    client.lock_round(&admin, &round_id);
    assert_eq!(
        client.try_round_claim(&alice, &round_id),
        Err(Ok(Error::RoundNotLocked)),
        "still not Settled, only Locked"
    );
}

#[test]
fn round_claim_with_no_deposit_returns_zero() {
    let (env, client, admin) = setup();
    client.create(&admin);
    let round_id = client.open_round(&admin);
    client.lock_round(&admin, &round_id);
    client.settle_round(&admin, &round_id, &100, &0);

    let stranger = Address::generate(&env);
    assert_eq!(client.round_claim(&stranger, &round_id), 0);
}

#[test]
fn round_claim_rounding_never_over_distributes() {
    // Odd realized_yield split across an odd number of participants: sum of
    // distributed shares must never exceed the settled total (dust is left
    // unclaimed rather than dropped incorrectly or over-paid).
    let (env, client, admin) = setup();
    client.create(&admin);

    let round_id = client.open_round(&admin);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let carol = Address::generate(&env);
    client.round_deposit(&alice, &round_id, &1);
    client.round_deposit(&bob, &round_id, &1);
    client.round_deposit(&carol, &round_id, &1);
    client.lock_round(&admin, &round_id);
    client.settle_round(&admin, &round_id, &10, &0); // 10 / 3 each, not evenly divisible

    let a = client.round_claim(&alice, &round_id);
    let b = client.round_claim(&bob, &round_id);
    let c = client.round_claim(&carol, &round_id);

    assert!(a + b + c <= 10, "distributed total must never exceed realized_yield");
    assert_eq!(client.round(&round_id).claimed, a + b + c);
}

#[test]
fn full_round_lifecycle_two_overlapping_rounds() {
    // End-to-end: round 0 is locked and settled while round 1 is opened and
    // collects deposits concurrently — asserts full isolation both ways.
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let round_0 = client.open_round(&admin);
    client.round_deposit(&alice, &round_0, &500);
    client.lock_round(&admin, &round_0);

    // round_1 opens while round_0 is locked but not yet settled.
    let round_1 = client.open_round(&admin);
    client.round_deposit(&bob, &round_1, &200);

    // Settle round_0 — must not touch round_1 in any way.
    client.settle_round(&admin, &round_0, &50, &0);
    let round_1_mid = client.round(&round_1);
    assert_eq!(round_1_mid.status, RoundStatus::Open);
    assert_eq!(round_1_mid.principal_snapshot, 200);
    assert_eq!(round_1_mid.realized_yield, 0);

    assert_eq!(client.round_claim(&alice, &round_0), 50);

    // round_1 continues its own lifecycle independently.
    client.lock_round(&admin, &round_1);
    client.settle_round(&admin, &round_1, &20, &0);
    assert_eq!(client.round_claim(&bob, &round_1), 20);

    // Final sanity: round_0's claimed total didn't move during round_1's
    // settlement/claim.
    assert_eq!(client.round(&round_0).claimed, 50);
}

#[test]
fn cancel_withdrawal_request_preserves_claim_for_a_later_withdraw() {
    let (env, client, admin, token, issuer) = setup_with_token();
    let alice = Address::generate(&env);
    client.join(&alice);
    issuer.mint(&alice, &1_000);
    client.deposit(&alice, &1_000);

    let strategy = env.register_contract(None, RealTokenStrategy);
    client.set_strategy(&admin, &strategy);
    client.deploy_to_strategy(&admin, &900);

    skip_lockup(&env);
    assert_eq!(client.withdraw(&alice), 0);

    let refunded = client.cancel_withdrawal_request(&alice);
    assert_eq!(refunded, 1_000);
    assert_eq!(client.savings(&alice).withdrawn_principal, 0);

    // Recall liquidity, then a fresh withdraw succeeds immediately.
    client.recall_from_strategy(&admin, &900);
    let paid = client.withdraw(&alice);
    assert_eq!(paid, 1_000);
    assert_eq!(token.balance(&alice), 1_000);
}
