#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token::TokenClient, Address, Env,
};
use vaultquest_common::{ContractError, StrategyReport, YieldStrategy, STRATEGY_INTERFACE_VERSION};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    TotalYield,
    PoolYield(Address),
    /// Real SAC principal tracked by the strategy (#496).
    Principal,
    Paused,
}

#[contract]
pub struct MockYield;

#[contractimpl]
impl MockYield {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TotalYield, &0_i128);
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();
    }

    pub fn simulate_yield(env: Env, pool: Address, amount: i128) {
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let pool_key = DataKey::PoolYield(pool.clone());
        let current_pool: i128 = env.storage().persistent().get(&pool_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&pool_key, &(current_pool + amount));

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalYield)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::TotalYield, &(total + amount));

        env.events().publish(
            (symbol_short!("yield"), symbol_short!("simulated")),
            (pool, amount, total + amount),
        );
    }

    pub fn set_yield(env: Env, pool: Address, amount: i128) {
        Self::require_admin(&env);
        if amount < 0 {
            panic!("amount must be non-negative");
        }

        let pool_key = DataKey::PoolYield(pool.clone());
        let previous: i128 = env.storage().persistent().get(&pool_key).unwrap_or(0);
        env.storage().persistent().set(&pool_key, &amount);

        let total: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalYield)
            .unwrap_or(0);
        let adjusted = total - previous + amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalYield, &adjusted);

        env.events().publish(
            (symbol_short!("yield"), symbol_short!("set")),
            (pool, previous, amount, adjusted),
        );
    }

    pub fn total_yield(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalYield)
            .unwrap_or(0)
    }

    pub fn pool_yield(env: Env, pool: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::PoolYield(pool))
            .unwrap_or(0)
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    // ── Governance (#496) ────────────────────────────────────────────────

    /// Admin-only circuit breaker: blocks new `deposit` calls. `redeem` and
    /// `harvest` remain callable while paused so a caller (e.g. the pool's
    /// emergency-recall path) can never be blocked from pulling funds back.
    pub fn set_paused(env: Env, paused: bool) {
        Self::require_admin(&env);
        env.storage().instance().set(&DataKey::Paused, &paused);
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    fn tracked_principal(env: &Env) -> i128 {
        env.storage().instance().get(&DataKey::Principal).unwrap_or(0)
    }
}

// ── Real yield-strategy interface (#496) ────────────────────────────────────
//
// Unlike `simulate_yield`/`set_yield` above (admin-attested bookkeeping kept
// for existing callers), these entrypoints move real SAC tokens and
// reconcile every operation against the strategy's actual on-chain balance —
// this is the "test strategy" the scope calls for.
#[contractimpl]
impl YieldStrategy for MockYield {
    fn interface_version(_env: Env) -> u32 {
        STRATEGY_INTERFACE_VERSION
    }

    fn deposit(env: Env, from: Address, asset: Address, amount: i128) -> Result<(), ContractError> {
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }
        if Self::is_paused(env.clone()) {
            return Err(ContractError::StrategyPaused);
        }
        from.require_auth();

        let token = TokenClient::new(&env, &asset);
        token.transfer(&from, &env.current_contract_address(), &amount);

        let principal = Self::tracked_principal(&env);
        env.storage()
            .instance()
            .set(&DataKey::Principal, &(principal + amount));
        Ok(())
    }

    fn redeem(env: Env, to: Address, asset: Address, amount: i128) -> Result<i128, ContractError> {
        Self::require_admin(&env);
        if amount <= 0 {
            return Err(ContractError::InvalidAmount);
        }

        let token = TokenClient::new(&env, &asset);
        let available = token.balance(&env.current_contract_address());
        // Never revert on under-collateralization: redeem whatever is
        // actually there (partial redeem / slippage / prior loss) so the
        // caller's emergency-recall path can always get *something* back
        // instead of being stranded by a strict full-amount requirement.
        let redeemed = if amount < available { amount } else { available };
        if redeemed > 0 {
            token.transfer(&env.current_contract_address(), &to, &redeemed);
        }

        let principal = Self::tracked_principal(&env);
        let new_principal = if redeemed > principal { 0 } else { principal - redeemed };
        env.storage().instance().set(&DataKey::Principal, &new_principal);

        Ok(redeemed)
    }

    fn harvest(env: Env, asset: Address) -> Result<StrategyReport, ContractError> {
        Self::require_admin(&env);

        let token = TokenClient::new(&env, &asset);
        let balance = token.balance(&env.current_contract_address());
        let principal = Self::tracked_principal(&env);
        let delta = balance - principal;

        let report = if delta > 0 {
            // Realize gains by handing them to the caller now — principal
            // stays deployed, only the reconciled surplus leaves the strategy.
            let admin: Address = env
                .storage()
                .instance()
                .get(&DataKey::Admin)
                .ok_or(ContractError::NotInitialized)?;
            token.transfer(&env.current_contract_address(), &admin, &delta);
            StrategyReport {
                realized_yield: delta,
                realized_loss: 0,
                total_assets: balance - delta,
            }
        } else if delta < 0 {
            let loss = -delta;
            env.storage().instance().set(&DataKey::Principal, &balance);
            StrategyReport {
                realized_yield: 0,
                realized_loss: loss,
                total_assets: balance,
            }
        } else {
            StrategyReport {
                realized_yield: 0,
                realized_loss: 0,
                total_assets: balance,
            }
        };

        Ok(report)
    }

    fn total_assets(env: Env, asset: Address) -> i128 {
        TokenClient::new(&env, &asset).balance(&env.current_contract_address())
    }
}

#[cfg(test)]
mod strategy_tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token;

    fn setup() -> (Env, MockYieldClient<'static>, Address, token::TokenClient<'static>, token::StellarAssetClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MockYield);
        let client = MockYieldClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);

        let asset_admin = Address::generate(&env);
        let sac = env.register_stellar_asset_contract_v2(asset_admin);
        let token = token::TokenClient::new(&env, &sac.address());
        let issuer = token::StellarAssetClient::new(&env, &sac.address());

        (env, client, contract_id, token, issuer)
    }

    #[test]
    fn deposit_reconciles_to_real_sac_balance() {
        let (env, client, contract_id, token, issuer) = setup();
        let depositor = Address::generate(&env);
        issuer.mint(&depositor, &1_000);

        client.deposit(&depositor, &token.address, &400);

        assert_eq!(token.balance(&contract_id), 400);
        assert_eq!(client.total_assets(&token.address), 400);
    }

    #[test]
    fn redeem_is_partial_when_requested_amount_exceeds_balance() {
        let (env, client, _contract_id, token, issuer) = setup();
        let depositor = Address::generate(&env);
        let receiver = Address::generate(&env);
        issuer.mint(&depositor, &1_000);
        client.deposit(&depositor, &token.address, &300);

        // Ask for more than the strategy actually holds (slippage / partial redeem).
        let redeemed = client.redeem(&receiver, &token.address, &900);

        assert_eq!(redeemed, 300);
        assert_eq!(token.balance(&receiver), 300);
        assert_eq!(client.total_assets(&token.address), 0);
    }

    #[test]
    fn harvest_reports_zero_when_balance_matches_principal() {
        let (env, client, _contract_id, token, issuer) = setup();
        let depositor = Address::generate(&env);
        issuer.mint(&depositor, &1_000);
        client.deposit(&depositor, &token.address, &500);

        let report = client.harvest(&token.address);

        assert_eq!(report.realized_yield, 0);
        assert_eq!(report.realized_loss, 0);
        assert_eq!(report.total_assets, 500);
    }

    #[test]
    fn harvest_realizes_yield_and_pays_it_to_admin() {
        let (env, client, contract_id, token, issuer) = setup();
        let depositor = Address::generate(&env);
        issuer.mint(&depositor, &1_000);
        client.deposit(&depositor, &token.address, &500);

        // Simulate accrual: extra real tokens land in the strategy's balance
        // without going through `deposit` (mirrors an external yield source).
        issuer.mint(&contract_id, &50);

        let report = client.harvest(&token.address);

        assert_eq!(report.realized_yield, 50);
        assert_eq!(report.realized_loss, 0);
        // Realized yield leaves the strategy for the admin (the pool) to hold
        // as distributable yield — principal stays deployed.
        assert_eq!(token.balance(&client.get_admin()), 50);
        assert_eq!(client.total_assets(&token.address), 500);
    }

    #[test]
    fn harvest_reports_loss_when_balance_drops_below_principal() {
        let (env, client, contract_id, token, issuer) = setup();
        let depositor = Address::generate(&env);
        issuer.mint(&depositor, &1_000);
        client.deposit(&depositor, &token.address, &500);

        // Simulate the strategy itself losing funds (e.g. a slashing event) —
        // real balance drops without going through `redeem`.
        let admin_for_burn = token::StellarAssetClient::new(&env, &token.address);
        admin_for_burn.clawback(&contract_id, &200);

        let report = client.harvest(&token.address);

        assert_eq!(report.realized_yield, 0);
        assert_eq!(report.realized_loss, 200);
        assert_eq!(report.total_assets, 300);
        // Loss is reflected in tracked principal, reconciled to real balance.
        assert_eq!(client.total_assets(&token.address), 300);
    }

    #[test]
    fn pause_blocks_deposit_but_never_blocks_redeem() {
        let (env, client, _contract_id, token, issuer) = setup();
        let depositor = Address::generate(&env);
        let receiver = Address::generate(&env);
        issuer.mint(&depositor, &1_000);
        client.deposit(&depositor, &token.address, &400);

        client.set_paused(&true);

        let deposit_result = client.try_deposit(&depositor, &token.address, &100);
        assert!(deposit_result.is_err());

        // A strategy failure/pause must never strand an emergency recall.
        let redeemed = client.redeem(&receiver, &token.address, &400);
        assert_eq!(redeemed, 400);
    }

    #[test]
    fn interface_version_matches_shared_constant() {
        let (_env, client, _contract_id, _token, _issuer) = setup();
        assert_eq!(client.interface_version(), vaultquest_common::STRATEGY_INTERFACE_VERSION);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup() -> (Env, MockYieldClient<'static>, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MockYield);
        let client = MockYieldClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        (env, client, admin)
    }

    #[test]
    fn test_initialize() {
        let (_env, client, _admin) = setup();
        assert_eq!(client.total_yield(), 0);
    }

    #[test]
    fn test_simulate_yield() {
        let (_env, client, _admin) = setup();
        let pool = Address::generate(&_env);
        client.simulate_yield(&pool, &1000);
        assert_eq!(client.pool_yield(&pool), 1000);
        assert_eq!(client.total_yield(), 1000);
    }

    #[test]
    fn test_multiple_simulations_accumulate() {
        let (_env, client, _admin) = setup();
        let pool = Address::generate(&_env);
        client.simulate_yield(&pool, &500);
        client.simulate_yield(&pool, &300);
        assert_eq!(client.pool_yield(&pool), 800);
        assert_eq!(client.total_yield(), 800);
    }

    #[test]
    fn test_yield_tracked_per_pool() {
        let (_env, client, _admin) = setup();
        let pool_a = Address::generate(&_env);
        let pool_b = Address::generate(&_env);
        client.simulate_yield(&pool_a, &100);
        client.simulate_yield(&pool_b, &200);
        client.simulate_yield(&pool_a, &50);
        assert_eq!(client.pool_yield(&pool_a), 150);
        assert_eq!(client.pool_yield(&pool_b), 200);
        assert_eq!(client.total_yield(), 350);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_zero_amount_reverts() {
        let (_env, client, _admin) = setup();
        let pool = Address::generate(&_env);
        client.simulate_yield(&pool, &0);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_negative_amount_reverts() {
        let (_env, client, _admin) = setup();
        let pool = Address::generate(&_env);
        client.simulate_yield(&pool, &(-100));
    }

    #[test]
    fn test_set_yield_overwrites() {
        let (_env, client, _admin) = setup();
        let pool = Address::generate(&_env);
        client.simulate_yield(&pool, &500);
        client.set_yield(&pool, &200);
        assert_eq!(client.pool_yield(&pool), 200);
        assert_eq!(client.total_yield(), 200);
    }

    #[test]
    fn test_set_yield_to_zero() {
        let (_env, client, _admin) = setup();
        let pool = Address::generate(&_env);
        client.simulate_yield(&pool, &500);
        client.set_yield(&pool, &0);
        assert_eq!(client.pool_yield(&pool), 0);
        assert_eq!(client.total_yield(), 0);
    }

    #[test]
    fn test_get_admin() {
        let (_env, client, admin) = setup();
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    fn test_multiple_pools_set_yield() {
        let (_env, client, _admin) = setup();
        let pool_a = Address::generate(&_env);
        let pool_b = Address::generate(&_env);
        client.set_yield(&pool_a, &100);
        client.set_yield(&pool_b, &200);
        assert_eq!(client.total_yield(), 300);
        client.set_yield(&pool_a, &50);
        assert_eq!(client.total_yield(), 250);
    }

    #[test]
    #[should_panic]
    fn test_set_yield_negative_reverts() {
        let (_env, client, _admin) = setup();
        let pool = Address::generate(&_env);
        client.set_yield(&pool, &(-1));
    }
}
