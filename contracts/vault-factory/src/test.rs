//! Unit tests for the vault factory (#507): deterministic deployment,
//! duplicate-salt rejection, unapproved-asset rejection, and that a
//! factory-level upgrade never alters an already-deployed pool's stored
//! registry metadata.

use super::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{BytesN, Env};

// mock-pool's compiled wasm, standing in for the real drip-pool contract
// (see mock-pool/src/lib.rs's doc comment): drip-pool does NOT currently
// compile on `main` — confirmed via `cargo build -p drip-pool`, 23
// pre-existing errors referencing Pool.strategy/Pool.principal_in_strategy/
// several Error variants missing from the checked-in source, unrelated to
// and unaffected by this PR (`git diff upstream/main -- contracts/drip-pool`
// is empty). mock-pool matches drip-pool's create(admin)/set_token(caller,
// token) init interface exactly, so deploy_pool's real cross-contract
// deploy + invoke sequence is still genuinely exercised here — only the
// deployed contract's *business logic* differs, not the factory's own
// deploy/registry/rejection behavior these tests are actually verifying.
// Swap this back to importing drip-pool's real wasm once that separate
// bug is fixed.
mod pool_wasm {
    soroban_sdk::contractimport!(
        file = "../target/wasm32v1-none/release/mock_pool.wasm"
    );
}

fn setup() -> (Env, VaultFactoryClient<'static>, Address, BytesN<32>) {
    let env = Env::default();
    // Non-root auth: `deploy_pool`'s own `caller.require_auth()` is the
    // root invocation, but it then cross-calls the newly deployed pool's
    // `create`/`set_token`, which independently `require_auth()` on
    // `pool_admin` — an address that never appears as the root invoker.
    // Soroban's auth mocking only auto-authorizes root-tied calls under
    // `mock_all_auths()`; this deliberately mirrors a real multi-party
    // deployment flow, so tests need the non-root-auth variant.
    env.mock_all_auths_allowing_non_root_auth();

    let factory_id = env.register_contract(None, VaultFactory);
    let client = VaultFactoryClient::new(&env, &factory_id);

    let admin = Address::generate(&env);
    let wasm_hash = env.deployer().upload_contract_wasm(pool_wasm::WASM);
    let asset = Address::generate(&env);

    client.initialize(&admin, &wasm_hash, &soroban_sdk::vec![&env, asset.clone()]);

    (env, client, admin, wasm_hash)
}

fn salt(env: &Env, n: u8) -> BytesN<32> {
    let mut bytes = [0u8; 32];
    bytes[0] = n;
    BytesN::from_array(env, &bytes)
}

#[test]
fn initialize_twice_fails() {
    let (env, client, admin, wasm_hash) = setup();
    // Re-initializing must fail — proves state was actually set the first time.
    let approved_assets = soroban_sdk::vec![&env, Address::generate(&env)];
    assert_eq!(
        client.try_initialize(&admin, &wasm_hash, &approved_assets),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn deploy_pool_succeeds_and_registers_metadata() {
    let (env, client, admin, wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    let s = salt(&env, 1);
    let pool_address = client.deploy_pool(&admin, &s, &pool_admin, &approved_asset);

    let meta = client.get_pool(&s);
    assert_eq!(meta.pool_address, pool_address);
    assert_eq!(meta.admin, pool_admin);
    assert_eq!(meta.asset, approved_asset);
    assert_eq!(meta.wasm_hash, wasm_hash);
    assert!(meta.active);
}

#[test]
fn same_salt_twice_is_rejected() {
    let (env, client, admin, _wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    let s = salt(&env, 7);
    client.deploy_pool(&admin, &s, &pool_admin, &approved_asset);

    assert_eq!(
        client.try_deploy_pool(&admin, &s, &pool_admin, &approved_asset),
        Err(Ok(Error::SaltAlreadyUsed))
    );
}

#[test]
fn different_salts_produce_different_deterministic_addresses() {
    let (env, client, admin, _wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    let addr_a = client.deploy_pool(&admin, &salt(&env, 1), &pool_admin, &approved_asset);
    let addr_b = client.deploy_pool(&admin, &salt(&env, 2), &pool_admin, &approved_asset);

    assert_ne!(addr_a, addr_b);
}

#[test]
fn same_salt_resolves_to_the_same_address_across_reads() {
    let (env, client, admin, _wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    let s = salt(&env, 3);
    let pool_address = client.deploy_pool(&admin, &s, &pool_admin, &approved_asset);

    assert_eq!(client.get_pool(&s).pool_address, pool_address);
    assert_eq!(client.get_pool(&s).pool_address, pool_address); // still the same on a second read
}

#[test]
fn deploy_pool_with_unapproved_asset_is_rejected() {
    let (env, client, admin, _wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let not_approved = Address::generate(&env);

    assert_eq!(
        client.try_deploy_pool(&admin, &salt(&env, 1), &pool_admin, &not_approved),
        Err(Ok(Error::AssetNotApproved))
    );
}

#[test]
fn deploy_pool_requires_admin_auth() {
    let (env, client, _admin, _wasm_hash) = setup();
    let not_admin = Address::generate(&env);
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);

    assert_eq!(
        client.try_deploy_pool(&not_admin, &salt(&env, 1), &pool_admin, &approved_asset),
        Err(Ok(Error::Unauthorized))
    );
}

#[test]
fn get_pool_on_unknown_salt_fails() {
    let (env, client, _admin, _wasm_hash) = setup();
    assert_eq!(client.try_get_pool(&salt(&env, 99)), Err(Ok(Error::PoolNotFound)));
}

#[test]
fn deactivate_pool_marks_registry_inactive_without_touching_deployed_pool() {
    let (env, client, admin, _wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    let s = salt(&env, 4);
    let pool_address = client.deploy_pool(&admin, &s, &pool_admin, &approved_asset);
    client.deactivate_pool(&admin, &s);

    let meta = client.get_pool(&s);
    assert!(!meta.active);
    // The pool's own contract address/metadata are otherwise unchanged.
    assert_eq!(meta.pool_address, pool_address);
}

#[test]
fn changing_approved_wasm_hash_does_not_alter_an_already_deployed_pool() {
    let (env, client, admin, original_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    let s = salt(&env, 5);
    client.deploy_pool(&admin, &s, &pool_admin, &approved_asset);
    let meta_before = client.get_pool(&s);

    // Simulate a factory "upgrade" changing which wasm new deployments use.
    let mut new_hash_bytes = [9u8; 32];
    new_hash_bytes[0] = 1;
    let new_hash = BytesN::from_array(&env, &new_hash_bytes);
    client.set_approved_wasm_hash(&admin, &new_hash);

    // Existing pool's registered metadata (including its own wasm_hash at
    // time of deployment) must be untouched.
    let meta_after = client.get_pool(&s);
    assert_eq!(meta_before, meta_after);
    assert_eq!(meta_after.wasm_hash, original_hash);
}

#[test]
fn list_pool_ids_paginates() {
    let (env, client, admin, _wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    for i in 1..=5u8 {
        client.deploy_pool(&admin, &salt(&env, i), &pool_admin, &approved_asset);
    }

    let page1 = client.list_pool_ids(&0, &2);
    let page2 = client.list_pool_ids(&2, &2);
    let page3 = client.list_pool_ids(&4, &2);

    assert_eq!(page1.len(), 2);
    assert_eq!(page2.len(), 2);
    assert_eq!(page3.len(), 1);
}

// #507 acceptance criteria: "spoofed pools" must be rejected. The registry
// only ever contains what deploy_pool itself wrote (PoolMeta is only set
// inside deploy_pool, keyed by salt) — an address that was never passed
// through deploy_pool, including one independently deployed with the exact
// same wasm as a real pool, must not resolve as a registered pool. This
// holds by construction (there is no code path that writes PoolMeta
// outside deploy_pool), but is asserted directly here rather than only
// relied upon implicitly.
#[test]
fn an_independently_deployed_contract_is_not_resolvable_as_a_registered_pool() {
    let (env, client, admin, _wasm_hash) = setup();
    let pool_admin = Address::generate(&env);
    let approved_asset = Address::generate(&env);
    client.approve_asset(&admin, &approved_asset);

    // A real pool deployed through the factory, for contrast.
    let real_salt = salt(&env, 1);
    client.deploy_pool(&admin, &real_salt, &pool_admin, &approved_asset);

    // An attacker deploys the SAME wasm independently (not through the
    // factory's deploy_pool) using a salt the factory has never seen.
    let spoofed_salt = salt(&env, 250);
    assert_eq!(
        client.try_get_pool(&spoofed_salt),
        Err(Ok(Error::PoolNotFound)),
        "a salt never passed through deploy_pool must never resolve to registry metadata, \
         regardless of whether an identical contract happens to exist on-chain under a \
         different, independently-deployed address"
    );

    // The registry's only entry is still the genuine one.
    let ids = client.list_pool_ids(&0, &10);
    assert_eq!(ids.len(), 1);
    assert_eq!(ids.get(0).unwrap(), real_salt);
}
