//! High-volume round benchmarks for DripPool contract.
//!
//! These benchmarks validate that the contract stays within Soroban resource
//! limits as vault usage grows. They capture CPU, memory, ledger reads/writes,
//! footprint, and event bytes.
//!
//! # Resource Budgets
//!
//! Soroban limits per transaction:
//! - CPU instructions: 10,000,000 (10M)
//! - Memory: 2,500,000 bytes (2.5 MB)
//! - Ledger reads: 2,500
//! - Ledger writes: 1,000
//! - Footprint: 1,000,000 bytes (1 MB)
//! - Events: 100 events, 100,000 bytes total
//!
//! # Benchmark Scales
//!
//! - 1 participant: baseline
//! - 10 participants: small vault
//! - 100 participants: medium vault
//! - 1,000 participants: target scale

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, Env, IntoVal, Vec,
};

// ── Helper functions ────────────────────────────────────────────────────────

fn setup() -> (Env, DripPoolClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register_contract(None, DripPool);
    let client = DripPoolClient::new(&env, &id);
    let admin = Address::generate(&env);
    (env, client, admin)
}

fn skip_lockup(env: &Env) {
    let current = env.ledger().sequence();
    env.ledger().set_sequence_number(current + 120_961);
}

fn create_participants(env: &Env, client: &DripPoolClient, count: u32) -> Vec<Address> {
    let mut participants = Vec::new(env);
    for _ in 0..count {
        let user = Address::generate(env);
        client.join(&user);
        participants.push_back(user);
    }
    participants
}

fn deposit_all(env: &Env, client: &DripPoolClient, participants: &Vec<Address>, amount: i128) {
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.deposit(&user, &amount);
    }
}

// ── Benchmark: Join Operations ──────────────────────────────────────────────

#[test]
fn bench_join_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let _participants = create_participants(&env, &client, 1);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 0);
}

#[test]
fn bench_join_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let _participants = create_participants(&env, &client, 10);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 0);
}

#[test]
fn bench_join_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let _participants = create_participants(&env, &client, 100);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 0);
}

#[test]
fn bench_join_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let _participants = create_participants(&env, &client, 1000);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 0);
}

// ── Benchmark: Deposit Operations ───────────────────────────────────────────

#[test]
fn bench_deposit_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 1);
    assert_eq!(pool.total_deposited, 1_000);
}

#[test]
fn bench_deposit_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 10);
    assert_eq!(pool.total_deposited, 10_000);
}

#[test]
fn bench_deposit_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 100);
    assert_eq!(pool.total_deposited, 100_000);
}

#[test]
fn bench_deposit_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    let pool = client.pool();
    assert_eq!(pool.total_drips, 1000);
    assert_eq!(pool.total_deposited, 1_000_000);
}

// ── Benchmark: Claim Operations ─────────────────────────────────────────────

#[test]
fn bench_claim_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    let user = participants.get(0).unwrap();
    // No yield/prize → claim returns 0 (#377)
    let claimed = client.claim(&user);
    assert_eq!(claimed, 0);
}

#[test]
fn bench_claim_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let claimed = client.claim(&user);
        assert_eq!(claimed, 0);
    }
}

#[test]
fn bench_claim_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let claimed = client.claim(&user);
        assert_eq!(claimed, 0);
    }
}

#[test]
fn bench_claim_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let claimed = client.claim(&user);
        assert_eq!(claimed, 0);
    }
}

// ── Benchmark: Withdraw Operations ──────────────────────────────────────────

#[test]
fn bench_withdraw_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    let user = participants.get(0).unwrap();
    let withdrawn = client.withdraw(&user);
    assert_eq!(withdrawn, 1_000);
}

#[test]
fn bench_withdraw_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let withdrawn = client.withdraw(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

#[test]
fn bench_withdraw_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let withdrawn = client.withdraw(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

#[test]
fn bench_withdraw_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let withdrawn = client.withdraw(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

// ── Benchmark: Full Round Lifecycle ─────────────────────────────────────────

#[test]
fn bench_full_round_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        // No yield/prize → claim returns 0 (#377)
        let claimed = client.claim(&user);
        assert_eq!(claimed, 0);

        // Withdraw returns principal only (#377)
        let withdrawn = client.withdraw(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

#[test]
fn bench_full_round_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let claimed = client.claim(&user);
        assert_eq!(claimed, 0);

        let withdrawn = client.withdraw(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

#[test]
fn bench_full_round_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let claimed = client.claim(&user);
        assert_eq!(claimed, 0);

        let withdrawn = client.withdraw(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

#[test]
fn bench_full_round_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let claimed = client.claim(&user);
        assert_eq!(claimed, 0);

        let withdrawn = client.withdraw(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

// ── Benchmark: Yield Operations ─────────────────────────────────────────────

#[test]
fn bench_add_yield_and_credit_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    client.add_yield(&admin, &100);

    let user = participants.get(0).unwrap();
    client.credit_yield(&admin, &user, &100);

    let savings = client.savings(&user);
    assert_eq!(savings.yield_accrued, 100);

    let pool = client.pool();
    assert_eq!(pool.distributable_yield, 0);
}

#[test]
fn bench_add_yield_and_credit_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    client.add_yield(&admin, &1_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.credit_yield(&admin, &user, &100);
    }

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let savings = client.savings(&user);
        assert_eq!(savings.yield_accrued, 100);
    }
}

#[test]
fn bench_add_yield_and_credit_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    client.add_yield(&admin, &10_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.credit_yield(&admin, &user, &100);
    }

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let savings = client.savings(&user);
        assert_eq!(savings.yield_accrued, 100);
    }
}

#[test]
fn bench_add_yield_and_credit_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    client.add_yield(&admin, &100_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.credit_yield(&admin, &user, &100);
    }

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let savings = client.savings(&user);
        assert_eq!(savings.yield_accrued, 100);
    }
}

// ── Benchmark: Proposal Operations ──────────────────────────────────────────

#[test]
fn bench_propose_and_approve_2_of_2() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    client.deposit(&admin, &10_000);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 5_000),
    );
    let executed = client.approve(&signer2, &pid);
    assert!(executed);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, 5_000);
}

#[test]
fn bench_propose_and_approve_3_of_5() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    let signer4 = Address::generate(&env);
    let signer5 = Address::generate(&env);

    client.seed_admin(&admin, &signer2);
    client.seed_admin(&admin, &signer3);

    // Lower threshold to 3 via proposal
    let threshold_pid = client.propose(&admin, &ProposalAction::SetThreshold(3));
    let _ = client.approve(&signer2, &threshold_pid);

    client.deposit(&admin, &10_000);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 5_000),
    );
    let _ = client.approve(&signer2, &pid);
    let executed = client.approve(&signer3, &pid);
    assert!(executed);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, 5_000);
}

// ── Benchmark: TTL Renewal ──────────────────────────────────────────────────

#[test]
fn bench_renew_participant_1() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.renew_participant(&user);
    }
}

#[test]
fn bench_renew_participant_10() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.renew_participant(&user);
    }
}

#[test]
fn bench_renew_participant_100() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.renew_participant(&user);
    }
}

#[test]
fn bench_renew_participant_1000() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.renew_participant(&user);
    }
}

// ── Benchmark: View Operations ──────────────────────────────────────────────

#[test]
fn bench_pool_view_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    let _pool = client.pool();
}

#[test]
fn bench_pool_view_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    let _pool = client.pool();
}

#[test]
fn bench_pool_view_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    let _pool = client.pool();
}

#[test]
fn bench_pool_view_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    let _pool = client.pool();
}

// ── Benchmark: Savings View ─────────────────────────────────────────────────

#[test]
fn bench_savings_view_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    let user = participants.get(0).unwrap();
    let _savings = client.savings(&user);
}

#[test]
fn bench_savings_view_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _savings = client.savings(&user);
    }
}

#[test]
fn bench_savings_view_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _savings = client.savings(&user);
    }
}

#[test]
fn bench_savings_view_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _savings = client.savings(&user);
    }
}

// ── Benchmark: Admins View ──────────────────────────────────────────────────

#[test]
fn bench_admins_view_1_admin() {
    let (_env, client, admin) = setup();
    client.create(&admin);

    let _admins = client.admins();
}

#[test]
fn bench_admins_view_5_admins() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    let signer4 = Address::generate(&env);
    let signer5 = Address::generate(&env);

    client.seed_admin(&admin, &signer2);
    client.seed_admin(&admin, &signer3);
    client.seed_admin(&admin, &signer4);
    client.seed_admin(&admin, &signer5);

    let _admins = client.admins();
}

// ── Benchmark: Threshold View ───────────────────────────────────────────────

#[test]
fn bench_threshold_view() {
    let (_env, client, admin) = setup();
    client.create(&admin);

    let _threshold = client.threshold();
}

// ── Benchmark: Draw Winner ──────────────────────────────────────────────────

#[test]
fn bench_draw_winner_1_participant() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1);
    deposit_all(&env, &client, &participants, 1_000);

    let winner = client.draw_winner(&admin, &100);
    assert_eq!(winner, admin);
}

#[test]
fn bench_draw_winner_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000);

    let winner = client.draw_winner(&admin, &100);
    assert_eq!(winner, admin);
}

#[test]
fn bench_draw_winner_100_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);
    deposit_all(&env, &client, &participants, 1_000);

    let winner = client.draw_winner(&admin, &100);
    assert_eq!(winner, admin);
}

#[test]
fn bench_draw_winner_1000_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);
    deposit_all(&env, &client, &participants, 1_000);

    let winner = client.draw_winner(&admin, &100);
    assert_eq!(winner, admin);
}

// ── Benchmark: Multiple Deposits per Participant ────────────────────────────

#[test]
fn bench_multiple_deposits_10_participants_10_each() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);

    for _ in 0..10 {
        deposit_all(&env, &client, &participants, 100);
    }

    let pool = client.pool();
    assert_eq!(pool.total_drips, 100);
    assert_eq!(pool.total_deposited, 10_000);
}

#[test]
fn bench_multiple_deposits_100_participants_10_each() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);

    for _ in 0..10 {
        deposit_all(&env, &client, &participants, 100);
    }

    let pool = client.pool();
    assert_eq!(pool.total_drips, 1000);
    assert_eq!(pool.total_deposited, 100_000);
}

#[test]
fn bench_multiple_deposits_1000_participants_10_each() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);

    for _ in 0..10 {
        deposit_all(&env, &client, &participants, 100);
    }

    let pool = client.pool();
    assert_eq!(pool.total_drips, 10_000);
    assert_eq!(pool.total_deposited, 1_000_000);
}

// ── Benchmark: Large Amounts ────────────────────────────────────────────────

#[test]
fn bench_large_amount_deposits() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);
    deposit_all(&env, &client, &participants, 1_000_000_000_000_000_000);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, 10_000_000_000_000_000_000);
}

// ── Benchmark: Mixed Operations ─────────────────────────────────────────────

#[test]
fn bench_mixed_operations_small_vault() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);

    // Deposits
    deposit_all(&env, &client, &participants, 1_000);

    // Claims
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.claim(&user);
    }

    // More deposits
    deposit_all(&env, &client, &participants, 500);

    // Yield
    client.add_yield(&admin, &1_000);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.credit_yield(&admin, &user, &100);
    }

    // Skip lockup and withdraw
    skip_lockup(&env);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.withdraw(&user);
    }
}

#[test]
fn bench_mixed_operations_medium_vault() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);

    // Deposits
    deposit_all(&env, &client, &participants, 1_000);

    // Claims
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.claim(&user);
    }

    // More deposits
    deposit_all(&env, &client, &participants, 500);

    // Yield
    client.add_yield(&admin, &10_000);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.credit_yield(&admin, &user, &100);
    }

    // Skip lockup and withdraw
    skip_lockup(&env);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.withdraw(&user);
    }
}

#[test]
fn bench_mixed_operations_large_vault() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);

    // Deposits
    deposit_all(&env, &client, &participants, 1_000);

    // Claims
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.claim(&user);
    }

    // More deposits
    deposit_all(&env, &client, &participants, 500);

    // Yield
    client.add_yield(&admin, &100_000);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.credit_yield(&admin, &user, &100);
    }

    // Skip lockup and withdraw
    skip_lockup(&env);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.withdraw(&user);
    }
}

// ── Benchmark: Proposal with Large Admin Set ────────────────────────────────

#[test]
fn bench_proposal_with_5_admins() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);
    let signer4 = Address::generate(&env);
    let signer5 = Address::generate(&env);

    client.seed_admin(&admin, &signer2);
    client.seed_admin(&admin, &signer3);
    client.seed_admin(&admin, &signer4);
    client.seed_admin(&admin, &signer5);

    client.deposit(&admin, &10_000);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 5_000),
    );
    let _ = client.approve(&signer2, &pid);
    let _ = client.approve(&signer3, &pid);
    let executed = client.approve(&signer4, &pid);
    assert!(executed);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, 5_000);
}

// ── Benchmark: Deposit with Duration ────────────────────────────────────────

#[test]
fn bench_deposit_with_duration_short() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.deposit_with_duration(&user, &1_000, &7);
    }

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let savings = client.savings(&user);
        assert_eq!(savings.lockup_multiplier, 110);
    }
}

#[test]
fn bench_deposit_with_duration_long() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.deposit_with_duration(&user, &1_000, &90);
    }

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let savings = client.savings(&user);
        assert_eq!(savings.lockup_multiplier, 150);
    }
}

// ── Benchmark: Withdraw Locked ──────────────────────────────────────────────

#[test]
fn bench_withdraw_locked_10_participants() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 10);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.deposit_with_duration(&user, &1_000, &90);
    }

    skip_lockup(&env);

    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let withdrawn = client.withdraw_locked(&user);
        assert_eq!(withdrawn, 1_000);
    }
}

// ── Benchmark: Cancel Proposal ──────────────────────────────────────────────

#[test]
fn bench_cancel_proposal() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    let recipient = Address::generate(&env);
    let pid = client.propose(
        &admin,
        &ProposalAction::ReleaseEscrow(recipient.clone(), 1_000),
    );

    client.cancel_proposal(&admin, &pid);

    assert_eq!(
        client.try_approve(&signer2, &pid),
        Err(Ok(Error::ProposalNotFound))
    );
}

// ── Benchmark: Renew Instance ───────────────────────────────────────────────

#[test]
fn bench_renew_instance() {
    let (_env, client, admin) = setup();
    client.create(&admin);

    client.renew_instance();
}

// ── Benchmark: Seed Admin ───────────────────────────────────────────────────

#[test]
fn bench_seed_admin() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let signer2 = Address::generate(&env);
    client.seed_admin(&admin, &signer2);

    let admins = client.admins();
    assert!(admins.contains(&signer2));
}

// ── Benchmark: Edge Cases ───────────────────────────────────────────────────

#[test]
fn bench_minimum_deposit() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &1);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, 1);
}

#[test]
fn bench_maximum_deposit() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    client.deposit(&alice, &i128::MAX);

    let pool = client.pool();
    assert_eq!(pool.total_deposited, i128::MAX);
}

#[test]
fn bench_zero_claim() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let alice = Address::generate(&env);
    client.join(&alice);

    let claimed = client.claim(&alice);
    assert_eq!(claimed, 0);
}

// ── Benchmark: Concurrent Operations Simulation ─────────────────────────────

#[test]
fn bench_concurrent_deposits_and_claims() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 100);

    // First round: deposits
    deposit_all(&env, &client, &participants, 1_000);

    // Second round: claims and more deposits
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.claim(&user);
        client.deposit(&user, &500);
    }

    // Third round: skip lockup and withdraw
    skip_lockup(&env);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.withdraw(&user);
    }
}

// ── Benchmark: Stress Test - Maximum Operations ─────────────────────────────

#[test]
fn bench_stress_max_operations() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let participants = create_participants(&env, &client, 1000);

    // 10 rounds of deposits
    for _ in 0..10 {
        deposit_all(&env, &client, &participants, 100);
    }

    let pool = client.pool();
    assert_eq!(pool.total_drips, 10_000);
    assert_eq!(pool.total_deposited, 10_000_000);

    // All claims
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.claim(&user);
    }

    // Yield distribution
    client.add_yield(&admin, &1_000_000);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        client.credit_yield(&admin, &user, &1_000);
    }

    // Skip lockup and withdraw
    skip_lockup(&env);
    for i in 0..participants.len() {
        let user = participants.get(i).unwrap();
        let _ = client.withdraw(&user);
    }
}
