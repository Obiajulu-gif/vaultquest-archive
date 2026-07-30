#![no_std]

//! # Vault factory (#507)
//!
//! Deploys new `drip-pool` (the canonical contract — see
//! `contracts/CONTRACT_BOUNDARY.md`) instances deterministically and
//! maintains an on-chain registry mapping a caller-chosen `salt` (the pool
//! id) to the resulting pool's contract address and metadata.
//!
//! Per `CONTRACT_BOUNDARY.md`'s own factory placeholder: "Any future
//! multi-pool factory must deploy drip-pool instances and register them
//! through the same `contracts/drip-pool/canonical-spec.ts`" — this
//! contract only deploys+registers; it does not reimplement any pool
//! logic itself.
//!
//! Determinism: Soroban's `Deployer::with_current_contract(salt)` derives
//! the new contract's address from `(this factory's address, salt)`, so
//! the same salt always resolves to the same pool address — satisfying
//! "a pool id maps to exactly one verified contract deployment."
//!
//! Governance: `deploy_pool` requires the factory admin's auth (a single
//! admin today, matching drip-pool's own current single-admin bootstrap
//! model per CONTRACT_BOUNDARY.md — a full multi-admin governance layer
//! for pool creation itself is deferred, see the design proposal on #507).
//! Only the configured `wasm_hash` (the currently-approved drip-pool
//! build) and an asset on the `approved_assets` allowlist can be used —
//! both rejections are enforced before any deployment happens.
//!
//! Upgrades: this factory contract can be upgraded via the standard
//! Soroban `upgrade()` admin call, but upgrading it can only affect
//! *future* deployments — each deployed pool is its own independent
//! contract instance, and this factory never re-touches a pool's stored
//! metadata after deployment. "Factory upgrades do not silently alter
//! existing pool logic" holds by construction, not by an explicit guard.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    IntoVal, Symbol, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    SaltAlreadyUsed = 4,     // deterministic pool id already deployed
    AssetNotApproved = 5,    // asset not on the admin-managed allowlist
    WasmHashNotApproved = 6, // deploying with anything but the currently-approved drip-pool build
    PoolNotFound = 7,
}

#[derive(Clone)]
#[contracttype]
enum DataKey {
    Admin,
    ApprovedWasmHash,          // BytesN<32> — the currently-approved drip-pool wasm hash
    ApprovedAssets,            // Vec<Address>
    PoolIds,                   // Vec<BytesN<32>> — every salt ever deployed, for pagination
    PoolMeta(BytesN<32>),      // salt -> PoolMetadata
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PoolMetadata {
    pub pool_address: Address,
    pub admin: Address,
    pub asset: Address,
    pub wasm_hash: BytesN<32>,
    pub deployed_at_ledger: u32,
    pub active: bool,
}

/// Registry event payload (#507). Published as a single-symbol-topic event
/// (matching this workspace's `vault/src/lib.rs` `_TOPIC` convention) with
/// this struct as the data — `contracttype` structs decode via
/// `scValToNative` into a plain object keyed by field name, so the backend
/// indexer (`stellarIndexer.ts`'s `sorobanNativeXdrDecoder`) can read
/// `payload.salt` / `payload.pool_address` / etc. directly rather than
/// needing to know positional tuple ordering.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct PoolDeployedEvent {
    pub salt: BytesN<32>,
    pub pool_address: Address,
    pub admin: Address,
    pub asset: Address,
    pub wasm_hash: BytesN<32>,
}

const FACTORY_POOL_DEPLOYED_TOPIC: Symbol = symbol_short!("fpooldep");

#[contract]
pub struct VaultFactory;

#[contractimpl]
impl VaultFactory {
    /// Initialize the factory. `wasm_hash` is the currently-approved
    /// drip-pool build (see `contracts/drip-pool`'s own release process
    /// for how this hash is produced) and `approved_assets` is the
    /// initial allowlist of Stellar Asset Contract addresses new pools
    /// may be configured with.
    pub fn initialize(
        env: Env,
        admin: Address,
        wasm_hash: BytesN<32>,
        approved_assets: Vec<Address>,
    ) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ApprovedWasmHash, &wasm_hash);
        env.storage()
            .instance()
            .set(&DataKey::ApprovedAssets, &approved_assets);
        env.storage()
            .instance()
            .set(&DataKey::PoolIds, &Vec::<BytesN<32>>::new(&env));
        Ok(())
    }

    /// Update the approved drip-pool wasm hash used for new deployments.
    /// Never touches already-deployed pools' code or metadata.
    pub fn set_approved_wasm_hash(env: Env, caller: Address, wasm_hash: BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage()
            .instance()
            .set(&DataKey::ApprovedWasmHash, &wasm_hash);
        Ok(())
    }

    /// Add an asset to the allowlist new pools may be configured with.
    pub fn approve_asset(env: Env, caller: Address, asset: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        let mut assets = Self::get_approved_assets(&env);
        if !assets.contains(&asset) {
            assets.push_back(asset);
            env.storage().instance().set(&DataKey::ApprovedAssets, &assets);
        }
        Ok(())
    }

    /// Deploys a new drip-pool instance deterministically at the address
    /// derived from `(this factory, salt)`. Rejects a salt already used
    /// (duplicate pool id), an asset not on the approved list, or a
    /// wasm_hash other than the currently-approved build.
    pub fn deploy_pool(
        env: Env,
        caller: Address,
        salt: BytesN<32>,
        pool_admin: Address,
        asset: Address,
    ) -> Result<Address, Error> {
        Self::require_admin(&env, &caller)?;

        if env.storage().instance().has(&DataKey::PoolMeta(salt.clone())) {
            return Err(Error::SaltAlreadyUsed);
        }

        let approved_assets = Self::get_approved_assets(&env);
        if !approved_assets.contains(&asset) {
            return Err(Error::AssetNotApproved);
        }

        let wasm_hash: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ApprovedWasmHash)
            .ok_or(Error::NotInitialized)?;

        // Deterministic deployment: the resulting address is derived from
        // (this contract's address, salt) — the same salt can never
        // produce a different address, and a salt already used is caught
        // by the storage check above before we even reach this point.
        let deployed_address = env
            .deployer()
            .with_current_contract(salt.clone())
            .deploy_v2(wasm_hash.clone(), ());

        // Initialize the freshly-deployed drip-pool instance: `create`
        // then `set_token`, mirroring exactly the two-step init sequence
        // an operator would otherwise perform manually (see
        // contracts/drip-pool/src/lib.rs's `create`/`set_token`).
        env.invoke_contract::<()>(
            &deployed_address,
            &symbol_short!("create"),
            soroban_sdk::vec![&env, pool_admin.clone().into_val(&env)],
        );
        env.invoke_contract::<()>(
            &deployed_address,
            &symbol_short!("set_token"),
            soroban_sdk::vec![&env, pool_admin.clone().into_val(&env), asset.clone().into_val(&env)],
        );

        let metadata = PoolMetadata {
            pool_address: deployed_address.clone(),
            admin: pool_admin,
            asset,
            wasm_hash,
            deployed_at_ledger: env.ledger().sequence(),
            active: true,
        };
        env.storage()
            .instance()
            .set(&DataKey::PoolMeta(salt.clone()), &metadata);

        let mut pool_ids = Self::get_pool_ids(&env);
        pool_ids.push_back(salt.clone());
        env.storage().instance().set(&DataKey::PoolIds, &pool_ids);

        env.events().publish(
            (FACTORY_POOL_DEPLOYED_TOPIC,),
            PoolDeployedEvent {
                salt,
                pool_address: deployed_address.clone(),
                admin: metadata.admin.clone(),
                asset: metadata.asset.clone(),
                wasm_hash: metadata.wasm_hash.clone(),
            },
        );

        Ok(deployed_address)
    }

    /// Marks a pool inactive in the registry (does not pause or otherwise
    /// touch the pool contract itself — that's the pool's own admin
    /// action via drip-pool's `pause_protocol`/emergency controls).
    pub fn deactivate_pool(env: Env, caller: Address, salt: BytesN<32>) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        let mut meta = Self::get_pool(env.clone(), salt.clone())?;
        meta.active = false;
        env.storage().instance().set(&DataKey::PoolMeta(salt), &meta);
        Ok(())
    }

    /// Read-only view of a single pool's registry metadata.
    pub fn get_pool(env: Env, salt: BytesN<32>) -> Result<PoolMetadata, Error> {
        env.storage()
            .instance()
            .get(&DataKey::PoolMeta(salt))
            .ok_or(Error::PoolNotFound)
    }

    /// Paginated list of every pool id ever deployed (including inactive
    /// ones — callers filter on `get_pool(id).active` as needed).
    pub fn list_pool_ids(env: Env, offset: u32, limit: u32) -> Vec<BytesN<32>> {
        let all = Self::get_pool_ids(&env);
        let mut out = Vec::new(&env);
        let start = offset as usize;
        let end = core::cmp::min(all.len() as usize, start + limit as usize);
        let mut i = start;
        while i < end {
            out.push_back(all.get(i as u32).unwrap());
            i += 1;
        }
        out
    }

    // ── Internals ────────────────────────────────────────────────────────

    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        caller.require_auth();
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if admin != *caller {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn get_approved_assets(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::ApprovedAssets)
            .unwrap_or(Vec::new(env))
    }

    fn get_pool_ids(env: &Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&DataKey::PoolIds)
            .unwrap_or(Vec::new(env))
    }
}

#[cfg(test)]
mod test;
