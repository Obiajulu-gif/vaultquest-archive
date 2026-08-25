//! Transparent proxy contract for vault logic upgrades.
//! Stores the logic contract hash in proxy storage and gates every upgrade
//! through the canonical pool's multisig governance.
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
//! ## Multisig-gated upgrades with an execution delay (#531)
//!
//! A single admin previously registered and executed upgrades unilaterally,
//! bypassing pool governance entirely. The proxy now has no admin of its
//! own: every authorization check reads the *live* signer set, threshold
//! and governance epoch straight from the canonical `DripPool` contract via
//! cross-contract calls, so proxy governance always tracks pool governance.
//!
//! Upgrades follow a propose → approve → (timelock) → execute lifecycle,
//! mirroring the pool's own high-risk proposal timelock (#533):
//! - `propose_upgrade` snapshots the pool's current admin set, threshold,
//!   governance epoch and current logic contract. A breaking upgrade still
//!   requires a prior `register_migration` record for the exact transition.
//! - `approve_upgrade` only counts approvals from addresses in that frozen
//!   snapshot, so a later admin rotation can't stuff extra votes in. It
//!   auto-executes once threshold is met *and* the delay has elapsed.
//! - `execute_upgrade` lets any current signer trigger execution once the
//!   delay has elapsed for a proposal that reached threshold early.
//! - Both re-check, at execution time: the governance epoch hasn't moved on
//!   (admins/threshold rotated) and the current logic contract still
//!   matches what was proposed against — a stale approval can never fire
//!   against a changed target.
//! - `cancel_upgrade` lets any *single* current pool signer cancel a pending
//!   upgrade at any time — an intentional asymmetry: one signer can block a
//!   bad upgrade immediately, but never execute one alone.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, Env, Vec,
};

use crate::DripPoolClient;

// ── Storage keys ────────────────────────────────────────────────────────────
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    PoolContract,             // Address of the DripPool contract that governs this proxy (#531)
    LogicContract,            // Address of the current logic contract
    LogicGeneration,          // u32 — bumped on every executed upgrade (#531)
    Migration(MigrationKey),  // marker: this specific (from -> to) transition was reviewed
    UpgradeProposal(u32),     // pending/executed/cancelled upgrade proposal, by id (#531)
    UpgradeNonce,             // u32 — next upgrade proposal id (#531)
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

/// Lifecycle status of an upgrade proposal (#531).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum UpgradeStatus {
    Pending,
    Executed,
    Cancelled,
    Expired,
}

/// A pending (or resolved) proxy upgrade, gated by pool multisig governance
/// and a ledger-based execution delay (#531).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct UpgradeProposal {
    pub new_logic: Address,
    pub breaking: bool,
    pub approvals: Vec<Address>,
    pub approver_snapshot: Vec<Address>, // pool admin set frozen at proposal creation
    pub threshold_snapshot: u32,         // pool threshold frozen at proposal creation
    pub epoch_snapshot: u32,             // pool governance epoch frozen at proposal creation
    pub current_logic_snapshot: Address, // logic contract at proposal creation (informational)
    pub logic_generation_snapshot: u32,  // logic generation at proposal creation — the actual
    // staleness guard: bumped on every executed upgrade (including a
    // rollback to a previously-used address), so a stale proposal can never
    // match again even if the logic address later cycles back (#531)
    pub proposed_at: u32,                // ledger sequence
    pub ready_at: u32,                   // proposed_at + delay; cannot execute before this
    pub expires_at: u32,                 // cannot execute after this
    pub status: UpgradeStatus,
    pub executed_at: Option<u32>,
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
    /// A breaking upgrade was proposed but no migration record exists for
    /// the `(current_logic -> new_logic)` pair. Call `register_migration` first.
    MigrationRequired = 5,
    ProposalNotFound = 6,
    AlreadySigned = 7,
    ThresholdNotMet = 8,
    TimelockNotElapsed = 9,
    ProposalExpired = 10,
    /// The pool's admin set, threshold or governance epoch changed since
    /// this upgrade was proposed — it cannot be revived, only re-proposed (#531).
    GovernanceConfigChanged = 11,
    /// The proxy's current logic contract changed since this upgrade was
    /// proposed — executing against a stale snapshot is rejected (#531).
    CurrentLogicChanged = 12,
}

// ── Contract ────────────────────────────────────────────────────────────────
#[contract]
pub struct VaultProxy;

#[contractimpl]
impl VaultProxy {
    // ── Internal helpers ───────────────────────────────────────────────────

    fn get_pool(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::PoolContract)
            .ok_or(Error::NotInitialized)
    }

    fn pool_admins(env: &Env, pool: &Address) -> Vec<Address> {
        DripPoolClient::new(env, pool).admins()
    }

    fn pool_threshold(env: &Env, pool: &Address) -> u32 {
        DripPoolClient::new(env, pool).threshold()
    }

    fn pool_epoch(env: &Env, pool: &Address) -> u32 {
        DripPoolClient::new(env, pool).governance_epoch()
    }

    fn require_pool_signer(env: &Env, pool: &Address, signer: &Address) -> Result<(), Error> {
        if !Self::pool_admins(env, pool).contains(signer) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn get_generation(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::LogicGeneration)
            .unwrap_or(0)
    }

    /// Applies the upgrade if — and only if — nothing has executed since
    /// this proposal was made. A Soroban contract invocation that returns
    /// `Err` rolls back every storage write it made, so a stale proposal
    /// can't be durably "cancelled" on this failing path; instead the
    /// generation check below is what makes it permanently unexecutable,
    /// with no persisted state required (#531).
    fn apply_upgrade(env: &Env, proposal: &mut UpgradeProposal) -> Result<(), Error> {
        let generation = Self::get_generation(env);
        if generation != proposal.logic_generation_snapshot {
            return Err(Error::CurrentLogicChanged);
        }
        env.storage()
            .instance()
            .set(&DataKey::LogicContract, &proposal.new_logic);
        env.storage()
            .instance()
            .set(&DataKey::LogicGeneration, &(generation + 1));
        proposal.status = UpgradeStatus::Executed;
        proposal.executed_at = Some(env.ledger().sequence());
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("upgraded")),
            (proposal.new_logic.clone(), proposal.breaking),
        );
        Ok(())
    }

    // ── Initialise ─────────────────────────────────────────────────────────

    /// Bind this proxy to the canonical pool contract that governs it.
    /// Callable only by a current signer of that pool (#531).
    pub fn create(
        env: Env,
        caller: Address,
        pool_contract: Address,
        logic_contract: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        if env.storage().instance().has(&DataKey::PoolContract) {
            return Err(Error::AlreadyInitialized);
        }
        Self::require_pool_signer(&env, &pool_contract, &caller)?;

        env.storage()
            .instance()
            .set(&DataKey::PoolContract, &pool_contract);
        env.storage()
            .instance()
            .set(&DataKey::LogicContract, &logic_contract);
        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("created")),
            (pool_contract, logic_contract),
        );
        Ok(())
    }

    /// Record that a current pool signer has reviewed and prepared a
    /// migration for the specific `from -> to` logic-contract transition.
    /// Required before a `breaking` upgrade to `to` can be proposed while
    /// the current logic contract is `from`.
    pub fn register_migration(
        env: Env,
        caller: Address,
        from: Address,
        to: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        let pool = Self::get_pool(&env)?;
        Self::require_pool_signer(&env, &pool, &caller)?;
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

    // ── Upgrade governance: propose / approve / execute / cancel (#531) ───

    /// Propose an upgrade to `new_logic`. Snapshots the pool's current
    /// admin set, threshold, governance epoch and current logic contract;
    /// only that snapshot governs this proposal from here on.
    pub fn propose_upgrade(
        env: Env,
        caller: Address,
        new_logic: Address,
        breaking: bool,
    ) -> Result<u32, Error> {
        caller.require_auth();
        let pool = Self::get_pool(&env)?;
        Self::require_pool_signer(&env, &pool, &caller)?;

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

        let threshold_snapshot = Self::pool_threshold(&env, &pool);
        let epoch_snapshot = Self::pool_epoch(&env, &pool);
        let approver_snapshot = Self::pool_admins(&env, &pool);
        let now = env.ledger().sequence();

        let nonce: u32 = env.storage().instance().get(&DataKey::UpgradeNonce).unwrap_or(0);
        let logic_generation_snapshot = Self::get_generation(&env);
        let proposal = UpgradeProposal {
            new_logic: new_logic.clone(),
            breaking,
            approvals: vec![&env, caller],
            approver_snapshot,
            threshold_snapshot,
            epoch_snapshot,
            current_logic_snapshot: current_logic,
            logic_generation_snapshot,
            proposed_at: now,
            ready_at: now + crate::HIGH_RISK_DELAY_LEDGERS,
            expires_at: now + crate::PROPOSAL_EXPIRY_LEDGERS,
            status: UpgradeStatus::Pending,
            executed_at: None,
        };
        env.storage()
            .instance()
            .set(&DataKey::UpgradeProposal(nonce), &proposal);
        env.storage().instance().set(&DataKey::UpgradeNonce, &(nonce + 1));

        env.events().publish(
            (symbol_short!("proxy"), symbol_short!("propose")),
            (nonce, new_logic, breaking),
        );
        Ok(nonce)
    }

    /// Approve a pending upgrade. Only counts approvals from the frozen
    /// approver snapshot. Auto-executes once threshold is met and the
    /// timelock delay has elapsed; otherwise the approval is recorded and
    /// `execute_upgrade` must be called later. Returns whether it executed.
    pub fn approve_upgrade(env: Env, caller: Address, upgrade_id: u32) -> Result<bool, Error> {
        caller.require_auth();
        let pool = Self::get_pool(&env)?;

        let mut proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeProposal(upgrade_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != UpgradeStatus::Pending {
            return Err(Error::ProposalNotFound);
        }
        if env.ledger().sequence() > proposal.expires_at {
            proposal.status = UpgradeStatus::Expired;
            env.storage()
                .instance()
                .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
            return Err(Error::ProposalExpired);
        }
        if proposal.epoch_snapshot != Self::pool_epoch(&env, &pool) {
            proposal.status = UpgradeStatus::Cancelled;
            env.storage()
                .instance()
                .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
            return Err(Error::GovernanceConfigChanged);
        }
        if !proposal.approver_snapshot.contains(&caller) {
            return Err(Error::Unauthorized);
        }
        if proposal.approvals.contains(&caller) {
            return Err(Error::AlreadySigned);
        }
        proposal.approvals.push_back(caller);

        let threshold_met = proposal.approvals.len() >= proposal.threshold_snapshot;
        if threshold_met && env.ledger().sequence() >= proposal.ready_at {
            Self::apply_upgrade(&env, &mut proposal)?;
            env.storage()
                .instance()
                .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
            Ok(true)
        } else {
            env.storage()
                .instance()
                .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
            Ok(false)
        }
    }

    /// Execute an upgrade proposal that already met threshold but whose
    /// delay had not yet elapsed. Any current pool signer may trigger it
    /// once the delay passes and before expiry.
    pub fn execute_upgrade(env: Env, caller: Address, upgrade_id: u32) -> Result<(), Error> {
        caller.require_auth();
        let pool = Self::get_pool(&env)?;
        Self::require_pool_signer(&env, &pool, &caller)?;

        let mut proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeProposal(upgrade_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.status != UpgradeStatus::Pending {
            return Err(Error::ProposalNotFound);
        }
        if proposal.epoch_snapshot != Self::pool_epoch(&env, &pool) {
            proposal.status = UpgradeStatus::Cancelled;
            env.storage()
                .instance()
                .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
            return Err(Error::GovernanceConfigChanged);
        }
        if env.ledger().sequence() > proposal.expires_at {
            proposal.status = UpgradeStatus::Expired;
            env.storage()
                .instance()
                .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
            return Err(Error::ProposalExpired);
        }
        if (proposal.approvals.len() as u32) < proposal.threshold_snapshot {
            return Err(Error::ThresholdNotMet);
        }
        if env.ledger().sequence() < proposal.ready_at {
            return Err(Error::TimelockNotElapsed);
        }

        Self::apply_upgrade(&env, &mut proposal)?;
        env.storage()
            .instance()
            .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
        Ok(())
    }

    /// Cancel a pending upgrade. Any single *current* pool signer may
    /// cancel at any time — deliberately easier than approving, so a bad
    /// upgrade can always be blocked quickly without ever letting a single
    /// signer execute one (#531).
    pub fn cancel_upgrade(env: Env, caller: Address, upgrade_id: u32) -> Result<(), Error> {
        caller.require_auth();
        let pool = Self::get_pool(&env)?;

        let mut proposal: UpgradeProposal = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeProposal(upgrade_id))
            .ok_or(Error::ProposalNotFound)?;
        if proposal.status != UpgradeStatus::Pending {
            return Err(Error::ProposalNotFound);
        }

        let is_current_signer = Self::pool_admins(&env, &pool).contains(&caller);
        let in_snapshot = proposal.approver_snapshot.contains(&caller);
        if !is_current_signer && !in_snapshot {
            return Err(Error::Unauthorized);
        }

        proposal.status = UpgradeStatus::Cancelled;
        env.storage()
            .instance()
            .set(&DataKey::UpgradeProposal(upgrade_id), &proposal);
        env.events()
            .publish((symbol_short!("proxy"), symbol_short!("upcancel")), upgrade_id);
        Ok(())
    }

    // ── Views ──────────────────────────────────────────────────────────────

    /// Get the current logic contract address.
    pub fn logic_contract(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::LogicContract)
            .ok_or(Error::NotInitialized)
    }

    /// Get the pool contract that governs this proxy.
    pub fn pool_contract(env: Env) -> Result<Address, Error> {
        Self::get_pool(&env)
    }

    /// View an upgrade proposal (pending or resolved) by id.
    pub fn pending_upgrade(env: Env, upgrade_id: u32) -> Result<UpgradeProposal, Error> {
        env.storage()
            .instance()
            .get(&DataKey::UpgradeProposal(upgrade_id))
            .ok_or(Error::ProposalNotFound)
    }

    pub fn upgrade_nonce(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::UpgradeNonce).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DripPool;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    fn setup() -> (Env, VaultProxyClient<'static>, DripPoolClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let pool_id = env.register_contract(None, DripPool);
        let pool_client = DripPoolClient::new(&env, &pool_id);
        let admin = Address::generate(&env);
        pool_client.create(&admin);

        let proxy_id = env.register(VaultProxy, ());
        let client = VaultProxyClient::new(&env, &proxy_id);

        let logic_v1 = Address::generate(&env);
        client.create(&admin, &pool_id, &logic_v1);

        (env, client, pool_client, admin, logic_v1)
    }

    fn skip_delay(env: &Env) {
        let current = env.ledger().sequence();
        env.ledger().set_sequence_number(current + crate::HIGH_RISK_DELAY_LEDGERS + 1);
    }

    #[test]
    fn create_binds_pool_and_logic() {
        let (_env, client, _pool, _admin, logic_v1) = setup();
        assert_eq!(client.logic_contract(), logic_v1);
    }

    #[test]
    fn create_by_non_pool_signer_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let pool_id = env.register_contract(None, DripPool);
        let pool_client = DripPoolClient::new(&env, &pool_id);
        let admin = Address::generate(&env);
        pool_client.create(&admin);

        let proxy_id = env.register(VaultProxy, ());
        let client = VaultProxyClient::new(&env, &proxy_id);
        let impostor = Address::generate(&env);
        let logic_v1 = Address::generate(&env);

        assert_eq!(
            client.try_create(&impostor, &pool_id, &logic_v1),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn single_sig_cannot_execute_upgrade_when_threshold_above_one() {
        let (env, client, pool, admin, logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2); // 2 admins, threshold 2

        let logic_v2 = Address::generate(&env);
        let uid = client.propose_upgrade(&admin, &logic_v2, &false);

        // Single approval (the proposer's own) never reaches threshold=2.
        assert_eq!(client.logic_contract(), logic_v1);
        skip_delay(&env);
        assert_eq!(
            client.try_execute_upgrade(&admin, &uid),
            Err(Ok(Error::ThresholdNotMet))
        );
        assert_eq!(client.logic_contract(), logic_v1);
    }

    #[test]
    fn upgrade_cannot_execute_before_delay() {
        let (env, client, pool, admin, _logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);

        let logic_v2 = Address::generate(&env);
        let uid = client.propose_upgrade(&admin, &logic_v2, &false);
        let executed = client.approve_upgrade(&signer2, &uid);
        assert!(!executed, "threshold met but delay must still block execution");

        assert_eq!(
            client.try_execute_upgrade(&signer2, &uid),
            Err(Ok(Error::TimelockNotElapsed))
        );
    }

    #[test]
    fn upgrade_executes_after_delay_once_threshold_met() {
        let (env, client, pool, admin, _logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);

        let logic_v2 = Address::generate(&env);
        let uid = client.propose_upgrade(&admin, &logic_v2, &false);
        client.approve_upgrade(&signer2, &uid);

        skip_delay(&env);
        client.execute_upgrade(&signer2, &uid);
        assert_eq!(client.logic_contract(), logic_v2);
    }

    #[test]
    fn upgrade_after_expiry_fails() {
        let (env, client, pool, admin, _logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);

        let logic_v2 = Address::generate(&env);
        let uid = client.propose_upgrade(&admin, &logic_v2, &false);
        client.approve_upgrade(&signer2, &uid);

        let current = env.ledger().sequence();
        env.ledger().set_sequence_number(current + crate::PROPOSAL_EXPIRY_LEDGERS + 1);

        assert_eq!(
            client.try_execute_upgrade(&signer2, &uid),
            Err(Ok(Error::ProposalExpired))
        );
    }

    #[test]
    fn breaking_upgrade_without_migration_fails_at_proposal() {
        let (env, client, pool, admin, logic_v1) = setup();
        let _ = logic_v1;
        let signer2 = Address::generate(&env);
        let logic_v2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);

        assert_eq!(
            client.try_propose_upgrade(&admin, &logic_v2, &true),
            Err(Ok(Error::MigrationRequired))
        );
    }

    #[test]
    fn breaking_upgrade_with_registered_migration_succeeds() {
        let (env, client, pool, admin, logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);
        let logic_v2 = Address::generate(&env);

        client.register_migration(&admin, &logic_v1, &logic_v2);
        assert!(client.has_migration(&logic_v1, &logic_v2));

        let uid = client.propose_upgrade(&admin, &logic_v2, &true);
        client.approve_upgrade(&signer2, &uid);
        skip_delay(&env);
        client.execute_upgrade(&signer2, &uid);
        assert_eq!(client.logic_contract(), logic_v2);
    }

    #[test]
    fn epoch_change_invalidates_pending_upgrade() {
        let (env, client, pool, admin, _logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2); // 2 admins, threshold 2 -> epoch bumps

        let logic_v2 = Address::generate(&env);
        let uid = client.propose_upgrade(&admin, &logic_v2, &false);

        // Rotate governance: lower threshold via the pool's own proposal flow,
        // which bumps the pool's governance epoch (#533) after its own delay.
        let pid = pool.propose(&admin, &crate::ProposalAction::SetThreshold(1));
        let current = env.ledger().sequence();
        env.ledger().set_sequence_number(current + crate::HIGH_RISK_DELAY_LEDGERS + 1);
        pool.approve(&signer2, &pid);
        assert_eq!(pool.threshold(), 1);

        assert_eq!(
            client.try_approve_upgrade(&signer2, &uid),
            Err(Ok(Error::GovernanceConfigChanged))
        );
    }

    #[test]
    fn any_current_signer_can_cancel_pending_upgrade() {
        let (env, client, pool, admin, logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);

        let logic_v2 = Address::generate(&env);
        let uid = client.propose_upgrade(&admin, &logic_v2, &false);

        // signer2 never approved, but as a current pool signer can still cancel.
        client.cancel_upgrade(&signer2, &uid);

        skip_delay(&env);
        assert_eq!(
            client.try_approve_upgrade(&admin, &uid),
            Err(Ok(Error::ProposalNotFound))
        );
        assert_eq!(client.logic_contract(), logic_v1);
    }

    #[test]
    fn stale_current_logic_blocks_execution() {
        let (env, client, pool, admin, logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);

        let logic_v2 = Address::generate(&env);
        let logic_v3 = Address::generate(&env);
        let uid = client.propose_upgrade(&admin, &logic_v2, &false);

        // A second, independent upgrade lands first and changes current logic.
        let uid2 = client.propose_upgrade(&admin, &logic_v3, &false);
        client.approve_upgrade(&signer2, &uid2);
        skip_delay(&env);
        client.execute_upgrade(&signer2, &uid2);
        assert_eq!(client.logic_contract(), logic_v3);

        // The first proposal was snapshotted against logic generation 0, but
        // executing uid2 already bumped it to 1. Threshold is already met
        // and the delay already elapsed, so `approve_upgrade` itself
        // attempts (and rejects) the stale execution.
        assert_eq!(
            client.try_approve_upgrade(&signer2, &uid),
            Err(Ok(Error::CurrentLogicChanged))
        );
        // A failed top-level call rolls back all of its own storage writes —
        // including signer2's just-added approval — so the proposal is back
        // to exactly its pre-call state (1 of 2 approvals). signer2's vote
        // can never durably land: any approval that would cross the
        // threshold immediately re-attempts (and re-fails) the same stale
        // execution, forever. The proposal is permanently stuck rather than
        // ever reviving, even if a later rollback made `logic_contract()`
        // equal `logic_v1` again.
        assert_eq!(
            client.try_execute_upgrade(&signer2, &uid),
            Err(Ok(Error::ThresholdNotMet))
        );
        let _ = logic_v1;
    }

    #[test]
    fn pending_upgrade_is_queryable() {
        let (env, client, pool, admin, _logic_v1) = setup();
        let signer2 = Address::generate(&env);
        pool.seed_admin(&admin, &signer2);
        let logic_v2 = Address::generate(&env);

        let uid = client.propose_upgrade(&admin, &logic_v2, &false);
        let proposal = client.pending_upgrade(&uid);
        assert_eq!(proposal.new_logic, logic_v2);
        assert_eq!(proposal.status, UpgradeStatus::Pending);

        client.approve_upgrade(&signer2, &uid);
        skip_delay(&env);
        client.execute_upgrade(&signer2, &uid);

        let executed = client.pending_upgrade(&uid);
        assert_eq!(executed.status, UpgradeStatus::Executed);
        assert!(executed.executed_at.is_some());
    }
}
