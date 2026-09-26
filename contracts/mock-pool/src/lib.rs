#![no_std]

//! Minimal stand-in for `contracts/drip-pool`'s `create(admin)` /
//! `set_token(caller, token)` init interface, used ONLY by
//! `vault-factory`'s test suite as a deployable dev-dependency.
//!
//! `drip-pool` itself does not currently compile on `main` (confirmed via
//! `cargo build -p drip-pool`: 23 pre-existing errors referencing
//! `Pool.strategy`/`Pool.principal_in_strategy`/several `Error` variants
//! that don't exist in the checked-in source — unrelated to and
//! unaffected by this PR's changes) — see the vault-factory PR notes for
//! full disclosure. This mock exists so `vault-factory`'s own deploy/
//! registry/rejection logic can still be proven correct via a real
//! cross-contract deployment + invocation, pending that separate bug fix.
//! Once drip-pool builds again, vault-factory's tests should switch to
//! importing its real wasm instead of this mock (see the `contractimport!`
//! comment in vault-factory/src/test.rs).

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Address, Env};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
}

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Admin,
    Token,
}

#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn create(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    pub fn set_token(env: Env, caller: Address, token: Address) {
        caller.require_auth();
        env.storage().instance().set(&DataKey::Token, &token);
    }

    pub fn admin(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn token(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Token).unwrap()
    }
}
