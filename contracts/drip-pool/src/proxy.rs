//! Transparent proxy contract for vault logic upgrades.
//! Stores the logic contract hash in proxy storage and provides
//! an admin function to upgrade the implementation.
//!
//! ## Upgrade compatibility gate (issue #386, partial)
//!
//! This is a scoped slice of the full upgrade-safety work tracked in
//! issue #386. It adds an **on-chain** gate so a breaking upgrade cannot
//! land without an explicit migration record having been registered first;
//! it does **not** implement the rest of that issue's acceptance criteria
//! (automated storage/ABI spec diffing in CI, populated-state rehearsal,
//! post-upgrade smoke tests, or documented rollback procedures) — those
//! remain open follow-up work.
//!
//! Callers upgrading the logic contract must declare whether the change is
//! `breaking`. A breaking upgrade only succeeds if the admin has previously
//! called [`VaultProxy::register_migration`] for the exact
//! `(current_logic -> new_logic)` pair, which is intended to be the on-chain
//! record that a human (or CI job, once built) reviewed the transition and
//! supplied a migration path. Non-breaking upgrades (e.g. bugfixes that
//! don't touch storage layout or remove/rename entry points) proceed
//! without a migration record.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env,
};

// ── Storage keys ────────────────────────────────────────────────────────────
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,                   // current proxy admin
    LogicContract,           // Address of the current logic contract
    Migration(MigrationKey), // marker: this specific (from -> to) transition was reviewed
}

/// Identifies one specific logic-contract transition. Soroban's enum
/// `contracttype` support does not allow multi-field tuple variants, so the
/// two addresses are grouped into a dedicated key struct instead (mirrors
/// the pattern used for other multi-field storage keys in this workspace).
#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct MigrationKey {
    pub from: Address,
    pub to: Address,
}

// ── Errors ───────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidAddress = 4,
    /// `upgrade()` was called with `breaking = true` but no migration record
    /// exists for the `(current_logic -> new_logic)` pair. Call
    /// `register_migration` first.
    MigrationRequired = 5,
}

// ── Contract ────────────────────────────────────────────────────────────────
#[contract]
pub struct VaultProxy;

#[contractimpl]
impl VaultProxy {
    /// Initialize the proxy with an admin and initial logic contract.
    pub fn create(env: Env, admin: Address, logic_contract: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::LogicContract, &logic_contract);
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("created")),
            (admin, logic_contract),
        );
        Ok(())
    }

    /// Record that the admin has reviewed and prepared a migration for the
    /// specific `from -> to` logic-contract transition. Required before a
    /// `breaking` upgrade to `to` can succeed while the current logic
    /// contract is `from`. Admin-only.
    ///
    /// This is the on-chain "explicit migration supplied" gate: registering
    /// is a separate, auditable step from the upgrade itself, so a breaking
    /// change can't be pushed through `upgrade()` alone.
    pub fn register_migration(
        env: Env,
        caller: Address,
        from: Address,
        to: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != caller {
            return Err(Error::Unauthorized);
        }
        if from == to {
            return Err(Error::InvalidAddress);
        }

        let key = DataKey::Migration(MigrationKey {
            from: from.clone(),
            to: to.clone(),
        });
        env.storage().instance().set(&key, &true);
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("migreg")),
            (from, to),
        );
        Ok(())
    }

    /// Returns whether a migration has been registered for the given
    /// `from -> to` logic-contract transition.
    pub fn has_migration(env: Env, from: Address, to: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::Migration(MigrationKey { from, to }))
    }

    /// Upgrade the logic contract address. Only callable by the stored admin.
    ///
    /// `breaking` must be `true` for any upgrade that changes storage
    /// layout, removes/renames an entry point, or otherwise isn't
    /// call-compatible with the current logic contract. Breaking upgrades
    /// require a matching [`register_migration`] record; non-breaking ones
    /// don't.
    pub fn upgrade(
        env: Env,
        caller: Address,
        new_logic: Address,
        breaking: bool,
    ) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;

        if admin != caller {
            return Err(Error::Unauthorized);
        }

        if new_logic == env.current_contract_address() {
            return Err(Error::InvalidAddress);
        }

        let current_logic: Address = env
            .storage()
            .instance()
            .get(&DataKey::LogicContract)
            .ok_or(Error::NotInitialized)?;

        if breaking {
            let key = DataKey::Migration(MigrationKey {
                from: current_logic.clone(),
                to: new_logic.clone(),
            });
            if !env.storage().instance().has(&key) {
                return Err(Error::MigrationRequired);
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::LogicContract, &new_logic);
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("upgraded")),
            (new_logic, breaking),
        );
        Ok(())
    }

    /// Get the current logic contract address.
    pub fn logic_contract(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::LogicContract)
            .ok_or(Error::NotInitialized)
    }

    /// Get the proxy admin.
    pub fn admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, VaultProxyClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(VaultProxy, ());
        let client = VaultProxyClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let logic_v1 = Address::generate(&env);
        client.create(&admin, &logic_v1);

        (env, client, admin, logic_v1)
    }

    #[test]
    fn test_non_breaking_upgrade_succeeds_without_migration() {
        let (env, client, admin, logic_v1) = setup();
        let logic_v2 = Address::generate(&env);

        client.upgrade(&admin, &logic_v2, &false);

        assert_eq!(client.logic_contract(), logic_v2);
        let _ = logic_v1;
    }

    #[test]
    fn test_breaking_upgrade_without_migration_fails() {
        let (env, client, admin, _logic_v1) = setup();
        let logic_v2 = Address::generate(&env);

        let result = client.try_upgrade(&admin, &logic_v2, &true);
        assert_eq!(result, Err(Ok(Error::MigrationRequired)));
    }

    #[test]
    fn test_breaking_upgrade_with_registered_migration_succeeds() {
        let (env, client, admin, logic_v1) = setup();
        let logic_v2 = Address::generate(&env);

        client.register_migration(&admin, &logic_v1, &logic_v2);
        assert!(client.has_migration(&logic_v1, &logic_v2));

        client.upgrade(&admin, &logic_v2, &true);
        assert_eq!(client.logic_contract(), logic_v2);
    }

    #[test]
    fn test_migration_registered_for_different_pair_does_not_apply() {
        let (env, client, admin, _logic_v1) = setup();
        let unrelated_from = Address::generate(&env);
        let logic_v2 = Address::generate(&env);

        // Register a migration for an unrelated `from`, not the proxy's
        // actual current logic contract.
        client.register_migration(&admin, &unrelated_from, &logic_v2);

        let result = client.try_upgrade(&admin, &logic_v2, &true);
        assert_eq!(result, Err(Ok(Error::MigrationRequired)));
    }

    #[test]
    fn test_register_migration_non_admin_rejected() {
        let (env, client, _admin, logic_v1) = setup();
        let impostor = Address::generate(&env);
        let logic_v2 = Address::generate(&env);

        let result = client.try_register_migration(&impostor, &logic_v1, &logic_v2);
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_upgrade_non_admin_rejected() {
        let (env, client, _admin, _logic_v1) = setup();
        let impostor = Address::generate(&env);
        let logic_v2 = Address::generate(&env);

        let result = client.try_upgrade(&impostor, &logic_v2, &false);
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_migration_record_persists_as_audit_trail_after_upgrade() {
        let (env, client, admin, logic_v1) = setup();
        let logic_v2 = Address::generate(&env);

        client.register_migration(&admin, &logic_v1, &logic_v2);
        client.upgrade(&admin, &logic_v2, &true);

        // The migration marker is not consumed — it remains queryable as a
        // historical/audit record of the reviewed transition.
        assert!(client.has_migration(&logic_v1, &logic_v2));
    }
}
