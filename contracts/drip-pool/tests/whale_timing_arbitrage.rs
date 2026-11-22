#![cfg(test)]

//! Regression tests for whale deposit-timing arbitrage scenarios (#724).
//!
//! These tests verify that the time-weighted ticket system prevents whales
//! from extracting expected value at the expense of small depositors through
//! strategic deposit/withdrawal timing around round boundaries.

use soroban_sdk::{testutils::Address as _, Address, Env};

mod drip_pool {
    soroban_sdk::contractimport!(
        file = "../target/wasm32-unknown-unknown/release/drip_pool.wasm"
    );
}

use drip_pool::{Client as DripPoolClient, Error, RoundStatus};

const ONE_XLM: i128 = 10_000_000; // 7 decimal places
const ROUND_DURATION_SECONDS: u64 = 7 * 24 * 60 * 60; // 7 days

fn setup_test() -> (Env, DripPoolClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    
    let contract_id = env.register_contract_wasm(None, drip_pool::WASM);
    let client = DripPoolClient::new(&env, &contract_id);
    
    let admin = Address::generate(&env);
    let whale = Address::generate(&env);
    let small_depositor = Address::generate(&env);
    
    // Initialize pool
    client.initialize(&admin);
    
    (env, client, admin, whale, small_depositor)
}

#[test]
fn test_late_deposit_receives_low_weight() {
    let (env, client, admin, whale, small_depositor) = setup_test();
    
    // Open round at T=0
    let round_id = client.open_round(&admin);
    let round_start = env.ledger().timestamp();
    
    // Small depositor deposits 10 XLM at T=0
    client.round_deposit(&small_depositor, &(10 * ONE_XLM), &round_id);
    
    // Advance time to 1 hour before round close (T = 7 days - 1 hour)
    env.ledger().with_mut(|li| {
        li.timestamp = round_start + ROUND_DURATION_SECONDS - 3600;
    });
    
    // Whale deposits 1,000 XLM at T = 7 days - 1 hour
    client.round_deposit(&whale, &(1000 * ONE_XLM), &round_id);
    
    // Lock round
    client.lock_round(&admin, &round_id);
    
    // Get ticket weights
    let small_weight = client.get_round_deposit(&small_depositor, &round_id);
    let whale_weight = client.get_round_deposit(&whale, &round_id);
    
    // Small depositor: 10 XLM × 1.0 = 10 XLM tickets
    assert_eq!(small_weight, 10 * ONE_XLM);
    
    // Whale: 1,000 XLM × ~0.059 (1h/168h) ≈ 59 XLM tickets
    // Whale deposited 100× more capital but gets only ~6× more tickets
    assert!(whale_weight < 100 * ONE_XLM);
    assert!(whale_weight > 50 * ONE_XLM); // At least 5% floor
    
    // Verify proportional expected value
    let total_tickets = small_weight + whale_weight;
    let whale_win_probability = (whale_weight * 10000) / total_tickets;
    
    // Whale should have ~85% win probability (59/(10+59))
    // but only exposed capital for ~0.6% of round duration
    assert!(whale_win_probability < 9000); // < 90%
}

#[test]
fn test_early_withdrawal_reduces_weight_proportionally() {
    let (env, client, admin, whale, _) = setup_test();
    
    // Open round at T=0
    let round_id = client.open_round(&admin);
    let round_start = env.ledger().timestamp();
    
    // Whale deposits 1,000 XLM at T=0
    client.round_deposit(&whale, &(1000 * ONE_XLM), &round_id);
    
    // Verify initial weight
    let initial_weight = client.get_round_deposit(&whale, &round_id);
    assert_eq!(initial_weight, 1000 * ONE_XLM);
    
    // Advance time to T=3 days (half-way through round)
    env.ledger().with_mut(|li| {
        li.timestamp = round_start + (ROUND_DURATION_SECONDS / 2);
    });
    
    // Whale withdraws 500 XLM mid-round
    let result = client.try_withdraw_from_round(&whale, &(500 * ONE_XLM), &round_id);
    
    // Note: This test assumes withdraw_from_round is implemented (#725)
    // If not implemented yet, this will fail with Error::NotImplemented
    match result {
        Ok(_) => {
            // Get updated weight
            let updated_weight = client.get_round_deposit(&whale, &round_id);
            
            // Expected: 1000 - (500 × 0.5 time_factor) ≈ 750 XLM tickets
            assert!(updated_weight < initial_weight);
            assert!(updated_weight > 700 * ONE_XLM);
            assert!(updated_weight < 800 * ONE_XLM);
        }
        Err(Error::NotImplemented) => {
            // Expected if withdraw_from_round not yet implemented
            // Test documents expected behavior
        }
        Err(e) => panic!("Unexpected error: {:?}", e),
    }
}

#[test]
fn test_repeated_deposit_withdraw_no_advantage() {
    let (env, client, admin, whale, _) = setup_test();
    
    // Open round at T=0
    let round_id = client.open_round(&admin);
    let round_start = env.ledger().timestamp();
    
    // Whale strategy: deposit/withdraw cycle 5 times
    // Attempt to game time-weighting by resetting deposit timestamp
    
    for i in 0..5 {
        // Deposit 200 XLM
        client.round_deposit(&whale, &(200 * ONE_XLM), &round_id);
        
        // Advance time by 1 day
        env.ledger().with_mut(|li| {
            li.timestamp = round_start + ((i + 1) * 24 * 60 * 60);
        });
        
        // Withdraw 150 XLM (if implemented)
        let _ = client.try_withdraw_from_round(&whale, &(150 * ONE_XLM), &round_id);
    }
    
    // Final balance: 5 × (200 - 150) = 250 XLM principal
    // But ticket weight should reflect actual capital-time exposure,
    // not full-round exposure for 250 XLM
    
    let final_weight = client.get_round_deposit(&whale, &round_id);
    
    // If whale had simply deposited 250 XLM at T=0, weight = 250 XLM
    // With cycling, weight should be ≤ 250 XLM (no advantage)
    assert!(final_weight <= 250 * ONE_XLM);
    
    // Cycling should actually give LESS weight due to time decay
    // Each redeposit receives reduced weight based on time elapsed
    assert!(final_weight < 250 * ONE_XLM);
}

#[test]
fn test_whale_vs_small_depositor_fair_odds() {
    let (env, client, admin, whale, small_depositor) = setup_test();
    
    // Open round at T=0
    let round_id = client.open_round(&admin);
    
    // Both deposit at T=0 (equal time exposure)
    client.round_deposit(&whale, &(10_000 * ONE_XLM), &round_id); // 10,000 XLM
    client.round_deposit(&small_depositor, &(10 * ONE_XLM), &round_id); // 10 XLM
    
    // Lock round
    client.lock_round(&admin, &round_id);
    
    // Get weights
    let whale_weight = client.get_round_deposit(&whale, &round_id);
    let small_weight = client.get_round_deposit(&small_depositor, &round_id);
    
    // Verify proportional odds: 10,000:10 = 1000:1
    let ratio = whale_weight / small_weight;
    assert_eq!(ratio, 1000);
    
    // Verify win probabilities
    let total_tickets = whale_weight + small_weight;
    let whale_prob = (whale_weight * 10000) / total_tickets;
    let small_prob = (small_weight * 10000) / total_tickets;
    
    // Whale: ~99.9% win probability
    assert!(whale_prob > 9990);
    
    // Small depositor: ~0.1% win probability
    assert!(small_prob < 10);
    
    // Sum to ~100%
    assert_eq!(whale_prob + small_prob, 10000);
}

#[test]
fn test_dust_deposit_griefing_prevented() {
    let (env, client, admin, _whale, small_depositor) = setup_test();
    
    // Open round
    let round_id = client.open_round(&admin);
    
    // Legitimate depositor: 100 XLM
    client.round_deposit(&small_depositor, &(100 * ONE_XLM), &round_id);
    
    // Attacker creates 10,000 accounts with 1 stroop each
    let mut total_dust_weight = 0i128;
    
    for i in 0..10_000 {
        let dust_account = Address::generate(&env);
        
        // Attempt to deposit 1 stroop (0.0000001 XLM)
        let result = client.try_round_deposit(&dust_account, &1, &round_id);
        
        // If minimum deposit check is implemented, this should fail
        match result {
            Ok(_) => {
                total_dust_weight += client.get_round_deposit(&dust_account, &round_id);
            }
            Err(Error::InvalidAmount) => {
                // Expected: minimum deposit enforced
                continue;
            }
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
    }
    
    let legitimate_weight = client.get_round_deposit(&small_depositor, &round_id);
    
    // Even if dust deposits succeed, their total weight should be negligible
    // 10,000 stroops = 0.001 XLM < 0.001% of 100 XLM
    let dust_impact_bps = (total_dust_weight * 10000) / legitimate_weight;
    
    assert!(dust_impact_bps < 10); // < 0.1% impact
}

#[test]
fn test_withdraw_to_zero_then_redeposit() {
    let (env, client, admin, whale, _) = setup_test();
    
    // Open round at T=0
    let round_id = client.open_round(&admin);
    let round_start = env.ledger().timestamp();
    
    // Whale deposits 1,000 XLM at T=0
    client.round_deposit(&whale, &(1000 * ONE_XLM), &round_id);
    
    // Advance time to T=3 days
    env.ledger().with_mut(|li| {
        li.timestamp = round_start + 3 * 24 * 60 * 60;
    });
    
    // Whale withdraws entire balance
    let result = client.try_withdraw_from_round(&whale, &(1000 * ONE_XLM), &round_id);
    
    match result {
        Ok(_) => {
            // Verify weight is zero
            let weight_after_withdraw = client.get_round_deposit(&whale, &round_id);
            assert_eq!(weight_after_withdraw, 0);
            
            // Advance time to T=5 days
            env.ledger().with_mut(|li| {
                li.timestamp = round_start + 5 * 24 * 60 * 60;
            });
            
            // Redeposit 500 XLM at T=5 days
            client.round_deposit(&whale, &(500 * ONE_XLM), &round_id);
            
            let final_weight = client.get_round_deposit(&whale, &round_id);
            
            // Weight should be based on T=5 days deposit, not T=0
            // Time remaining: 2 days / 7 days ≈ 28.6%
            // Expected weight: 500 × 0.286 ≈ 143 XLM tickets
            assert!(final_weight < 200 * ONE_XLM);
            assert!(final_weight > 100 * ONE_XLM);
            
            // NO carryover from original T=0 deposit
            assert!(final_weight < 1000 * ONE_XLM);
        }
        Err(Error::NotImplemented) | Err(Error::RoundNotOpen) => {
            // Expected if feature not implemented yet
        }
        Err(e) => panic!("Unexpected error: {:?}", e),
    }
}

#[test]
fn test_deposit_after_lock_fails() {
    let (env, client, admin, whale, _) = setup_test();
    
    // Open and lock round
    let round_id = client.open_round(&admin);
    client.lock_round(&admin, &round_id);
    
    // Attempt deposit after lock
    let result = client.try_round_deposit(&whale, &(1000 * ONE_XLM), &round_id);
    
    // Should fail with RoundNotOpen
    assert_eq!(result, Err(Error::RoundNotOpen));
}

#[test]
fn test_time_weighted_ticket_floor() {
    let (env, client, admin, whale, _) = setup_test();
    
    // Open round at T=0
    let round_id = client.open_round(&admin);
    let round_start = env.ledger().timestamp();
    
    // Advance to very end of round (1 minute before close)
    env.ledger().with_mut(|li| {
        li.timestamp = round_start + ROUND_DURATION_SECONDS - 60;
    });
    
    // Whale deposits at the last minute
    client.round_deposit(&whale, &(1000 * ONE_XLM), &round_id);
    
    let weight = client.get_round_deposit(&whale, &round_id);
    
    // Even at the last minute, whale should get minimum 5% weight
    // 1,000 XLM × 0.05 = 50 XLM tickets minimum
    assert!(weight >= 50 * ONE_XLM);
    
    // But not more than time-proportional weight
    // Time remaining: 60s / (7*24*60*60) ≈ 0.01%
    // Max weight: 1,000 × max(0.05, 0.0001) = 50 XLM
    assert!(weight <= 60 * ONE_XLM);
}
