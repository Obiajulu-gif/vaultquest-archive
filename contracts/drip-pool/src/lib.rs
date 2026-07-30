#![no_std]

//! # Canonical contract (#495)
//!
//! This is the **authoritative** contract for VaultQuest pool state: principal,
//! rewards/yield, round/draw state, pause, and winner settlement all live here.
//! `contracts/vault` is a deprecated, incompatible skeleton (single-admin, no
//! rounds/lockups/claim-deadlines, no real token custody) and MUST NOT be used
//! for new deployments — see `contracts/CONTRACT_BOUNDARY.md` for the full
//! decision record and legacy-deployment compatibility path. The backend,
//! wallet package, and `lib/deployment-manifest.ts` all bind to this contract
//! via `contracts/drip-pool/canonical-spec.ts`, which is the single generated
//! spec cross-checked by `contracts/drip-pool/tests/cross-stack-conformance.test.ts`.
//!
//! Drip pool contract — hardened with multi-sig admin controls (#140),
//! reentrancy lock guards and lockup enforcement (#139).
//!
//! #376 Real SAC token custody: deposits transfer tokens from the caller into
//! the contract; withdrawals transfer tokens back. Failed transfers revert all
//! storage changes and leave the reentrancy guard clean.
//!
//! #382 Yield-backed lockup multipliers
//! - `withdraw` returns principal + yield_accrued, never principal × multiplier.
//! - Multipliers are reward weights; yield is credited by admins from realized reserves.
//! - `add_yield` and `credit_yield` govern distributable yield.
//!
//! #383 Multisig-only admin mutations
//! - `add_admin` and `remove_admin` are removed as direct single-signer calls.
//! - `seed_admin` allows bootstrap additions while admin count < threshold.
//! - `RemoveAdmin` proposals are rejected when execution would leave fewer
//!   signers than the configured threshold.
//! - `SetThreshold` is a new proposal action; threshold is stored and governed.
//! - Proposals carry an `expires_at` ledger sequence; stale proposals are purged.
//! - `cancel_proposal` lets any snapshot signer abort a pending proposal.
//!
//! #384 Payload validation and reserve checks
//! - `ReleaseEscrow` amounts are validated (> 0, <= total_deposited) at propose time
//!   and re-validated at execution time against current reserves.
//! - `SetThreshold` values are validated against current signer count.
//! - Each Proposal records the admin snapshot at creation; only those signers may approve.
//!
//! #385 Comprehensive TTL renewal
//! - All instance reads/writes extend instance TTL.
//! - All persistent reads/writes extend participant TTL.
//! - `renew_participant` and `renew_instance` are operator maintenance entrypoints.
//!
//! #440 Claim deadline and unclaimed reward handling
//! - `Pool.claim_deadline` is an optional ledger timestamp, set per pool via
//!   `set_claim_deadline`. `claim`/`claim_reward` succeed while
//!   `timestamp <= claim_deadline` and revert with `ClaimDeadlinePassed` once
//!   `timestamp > claim_deadline` — the deadline instant itself is claimable.
//! - `sweep_unclaimed` lets a signer move a participant's unclaimed reward
//!   (yield_accrued + prize − claimed_reward) to the pool admin (treasury)
//!   once the deadline has strictly passed. It reuses the same `transfer_tokens`
//!   SAC path as `withdraw`, so it is a no-op transfer when no token is
//!   configured. `Pool.unclaimed_swept` flips to `true` on first sweep.
//! - `claim_deadline`, `claim_deadline_passed` and `unclaimed_swept` are public
//!   views so the frontend can read deadline/status without decoding `Pool`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, Env, Vec,
};
use vaultquest_common::YieldStrategyClient;

pub mod proxy;
pub mod strategy_adapter;
pub mod vault;

// ── Lockup duration (ledgers, ~7 days at 5 s/ledger) ──────────────────────
const LOCKUP_LEDGERS: u32 = 120_960;

// ── TTL thresholds (ledgers) ───────────────────────────────────────────────
const INSTANCE_TTL_THRESHOLD: u32 = 500;
const INSTANCE_TTL_EXTEND: u32 = 100_000;
const PERSISTENT_TTL_THRESHOLD: u32 = 100_000;
const PERSISTENT_TTL_EXTEND: u32 = 500_000;

// ── Proposal expiry (~30 days at 5 s/ledger) ──────────────────────────────
const PROPOSAL_EXPIRY_LEDGERS: u32 = 17_280 * 30;

// ── Default multi-sig threshold ────────────────────────────────────────────
const DEFAULT_THRESHOLD: u32 = 2;

// ── Storage keys ──────────────────────────────────────────────────────────
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Admins,    // Vec<Address> — approved signers
    Threshold, // u32 — current multisig threshold
    Pool,
    Participant(Address),   // V2 participant storage (#377)
    ParticipantV1(Address), // legacy V1 participant storage (migration source)
    Proposal(u32),          // pending admin proposal
    Token,                  // Address — accepted Stellar Asset Contract address (#376)
}

// ── Errors ─────────────────────────────────────────────────────────────────
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    AlreadyJoined = 3,
    NotJoined = 4,
    InvalidAmount = 5,
    Locked = 6,          // reentrancy
    LockupActive = 7,    // withdrawal before lockup ends
    Unauthorized = 8,    // not an approved signer
    ThresholdNotMet = 9, // not enough signatures
    AlreadySigned = 10,  // signer already approved this proposal
    ProposalNotFound = 11,
    ProposalExpired = 12,         // proposal ledger deadline passed
    InvalidAction = 13,           // payload fails reserve or signer-count checks
    TokenNotConfigured = 14,      // no accepted asset configured (#376)
    AssetMismatch = 15,           // caller sent a different asset than the configured one (#376)
    TransferFailed = 16,          // token transfer failed (#376)
    ClaimDeadlinePassed = 17,     // claim attempted after the pool's claim deadline (#440)
    ClaimDeadlineNotReached = 18, // sweep attempted before the deadline has passed (#440)
    NoClaimDeadline = 19,         // sweep attempted but no deadline was ever configured (#440)
    InvalidDeadline = 20,         // deadline must be strictly in the future (#440)
    InEmergency = 21,             // action blocked while in emergency mode (#512)
    NotInEmergency = 22,          // emergency exit blocked while not in emergency mode (#512)
    Insolvent = 23,               // principal coverage below policy (#512)
}

// ── Structs ────────────────────────────────────────────────────────────────
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Pool {
    pub admin: Address,
    pub total_drips: u64,
    pub total_deposited: i128,
    pub created_at: u64,
    pub locked: bool,
    pub proposal_nonce: u32,
    pub distributable_yield: i128, // realized yield available for distribution (#382)
    pub claim_deadline: Option<u64>, // ledger timestamp after which claims revert (#440)
    pub unclaimed_swept: bool,     // true once an unclaimed-reward sweep has executed (#440)
    pub is_emergency: bool,        // true when loss circuit breaker triggered (#512)
    pub emergency_assets: i128,    // available assets recorded for pro-rata exit (#512)
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct ParticipantV1 {
    pub joined_at: u64,
    pub deposited: i128,
    pub claimable: i128,
    pub locked_until: u32,
    pub lockup_multiplier: u32,
    pub yield_accrued: i128,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Participant {
    pub joined_at: u64,
    pub deposited: i128, // total principal deposited
    pub locked_until: u32,
    pub lockup_multiplier: u32, // reward weight in bps — not a principal multiplier
    pub yield_accrued: i128,    // realized yield credited by admin (#382)
    pub prize: i128,            // prize winnings from draw_winner (#377)
    pub claimed_reward: i128,   // cumulative rewards already claimed (#377)
    pub withdrawn_principal: i128, // cumulative principal already withdrawn (#377)
}

/// A pending admin action that requires multi-sig approval.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub action: ProposalAction,
    pub approvals: Vec<Address>,
    pub expires_at: u32, // ledger sequence; approvals rejected after this (#383)
    pub approver_snapshot: Vec<Address>, // admin set frozen at proposal creation (#384)
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum ProposalAction {
    ReleaseEscrow(Address, i128), // recipient, amount
    AddAdmin(Address),
    RemoveAdmin(Address),
    SetThreshold(u32), // change the approval threshold (#383)
    TriggerEmergency(i128), // enter emergency mode with available asset amount (#512)
    Recapitalize(i128),     // inject capital into emergency pool (#512)
    ResumeNormal,           // return to normal operations (#512)
}

// ── Contract ───────────────────────────────────────────────────────────────
#[contract]
pub struct DripPool;

#[contractimpl]
impl DripPool {
    // ── Internal helpers ───────────────────────────────────────────────────
    fn acquire_lock(pool: &mut Pool) -> Result<(), Error> {
        if pool.locked {
            return Err(Error::Locked);
        }
        pool.locked = true;
        Ok(())
    }

    fn release_lock(pool: &mut Pool) {
        pool.locked = false;
    }

    fn require_signer(env: &Env, signer: &Address) -> Result<(), Error> {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![env]);
        if !admins.contains(signer) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }

    fn get_threshold(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(DEFAULT_THRESHOLD)
    }

    fn get_admins(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Admins)
            .unwrap_or(vec![env])
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND);
    }

    fn bump_participant(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    // ── Participant migration helpers (#377) ─────────────────────────────

    /// Load a V2 participant, migrating from V1 on first access.
    fn load_participant(env: &Env, who: &Address) -> Result<Participant, Error> {
        let key = DataKey::Participant(who.clone());
        if let Some(p) = env.storage().persistent().get::<DataKey, Participant>(&key) {
            Self::bump_participant(env, &key);
            return Ok(p);
        }
        let v1_key = DataKey::ParticipantV1(who.clone());
        if let Some(old) = env
            .storage()
            .persistent()
            .get::<DataKey, ParticipantV1>(&v1_key)
        {
            let new_p = Participant {
                joined_at: old.joined_at,
                deposited: old.deposited,
                locked_until: old.locked_until,
                lockup_multiplier: old.lockup_multiplier,
                yield_accrued: old.yield_accrued,
                prize: 0,
                claimed_reward: 0,
                withdrawn_principal: 0,
            };
            env.storage().persistent().set(&key, &new_p);
            env.storage().persistent().remove(&v1_key);
            Self::bump_participant(env, &key);
            return Ok(new_p);
        }
        Err(Error::NotJoined)
    }

    /// Save a V2 participant and clean up any legacy V1 key.
    fn save_participant(env: &Env, who: &Address, p: &Participant) {
        let key = DataKey::Participant(who.clone());
        env.storage().persistent().set(&key, p);
        env.storage()
            .persistent()
            .remove(&DataKey::ParticipantV1(who.clone()));
        Self::bump_participant(env, &key);
    }

    /// Check if a participant exists (V2 or V1 legacy) without loading the full struct.
    fn has_participant(env: &Env, who: &Address) -> bool {
        let key = DataKey::Participant(who.clone());
        if env.storage().persistent().has(&key) {
            return true;
        }
        env.storage()
            .persistent()
            .has(&DataKey::ParticipantV1(who.clone()))
    }

    // ── Token helpers (#376) ──────────────────────────────────────────────

    /// Check if a token address is configured.
    fn has_token_configured(env: &Env) -> bool {
        env.storage().instance().has(&DataKey::Token)
    }

    /// Get the configured token address. Returns Err if not configured.
    fn get_token_address(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::TokenNotConfigured)
    }

    /// Transfer tokens from `from` to `to` via the configured SAC.
    /// If no token is configured, this is a no-op (backward compatibility).
    /// Returns Ok(()) on success, Err(TransferFailed) on failure.
    fn transfer_tokens(
        env: &Env,
        from: &Address,
        to: &Address,
        amount: &i128,
    ) -> Result<(), Error> {
        if !Self::has_token_configured(env) {
            return Ok(());
        }
        let token_addr = Self::get_token_address(env)?;

        // The token client's transfer() will trap on failure.
        // We don't have a try_ version, so we rely on the contract's
        // own reentrancy guard + storage snapshot for safety.
        let token = soroban_sdk::token::TokenClient::new(env, &token_addr);
        token.transfer(from, to, amount);

        Ok(())
    }
    // Atomic helper that performs a token transfer and then runs a closure to update accounting.
    fn atomic_transfer_and<F>(env: &Env, from: &Address, to: &Address, amount: i128, accounting_update: F) -> Result<(), Error>
    where
        F: FnOnce() -> Result<(), Error>,
    {
        // Perform token transfer first.
        Self::transfer_tokens(env, from, to, &amount)?;
        // Apply accounting changes.
        accounting_update()
    }

    // ── Initialise ─────────────────────────────────────────────────────────
    pub fn create(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        if env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::AlreadyInitialized);
        }
        let pool = Pool {
            admin: admin.clone(),
            total_drips: 0,
            total_deposited: 0,
            created_at: env.ledger().timestamp(),
            locked: false,
            proposal_nonce: 0,
            distributable_yield: 0,
            claim_deadline: None,
            unclaimed_swept: false,
            is_emergency: false,
            emergency_assets: 0,
        };
        let admins: Vec<Address> = vec![&env, admin.clone()];
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &DEFAULT_THRESHOLD);
        env.storage().instance().set(&DataKey::Pool, &pool);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("created")), admin);
        Ok(())
    }

    /// Configure the accepted Stellar Asset Contract address.
    /// Only callable by an authorized signer.
    pub fn set_token(env: Env, caller: Address, token: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        env.storage().instance().set(&DataKey::Token, &token);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("token_set")), token);
        Ok(())
    }

    /// Bootstrap: directly add a signer while admin count is strictly below threshold.
    /// Once the admin set reaches the threshold, all mutations must go through proposals.
    pub fn seed_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut admins = Self::get_admins(&env);
        let threshold = Self::get_threshold(&env);
        // Prevent direct bypass once threshold is reachable
        if admins.len() >= threshold {
            return Err(Error::Unauthorized);
        }
        if !admins.contains(&new_admin) {
            admins.push_back(new_admin);
            env.storage().instance().set(&DataKey::Admins, &admins);
        }
        Self::bump_instance(&env);
        Ok(())
    }

    // ── Multi-sig: propose an admin action ─────────────────────────────────
    pub fn propose(env: Env, signer: Address, action: ProposalAction) -> Result<u32, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        // Validate action payload before creating the proposal (#384)
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        match &action {
            ProposalAction::ReleaseEscrow(_recipient, amount) => {
                if *amount <= 0 {
                    return Err(Error::InvalidAmount);
                }
                if *amount > pool.total_deposited {
                    return Err(Error::InvalidAction);
                }
            }
            ProposalAction::SetThreshold(t) => {
                let admins = Self::get_admins(&env);
                if *t == 0 || *t > admins.len() {
                    return Err(Error::InvalidAction);
                }
            }
            ProposalAction::TriggerEmergency(assets) => {
                if *assets < 0 {
                    return Err(Error::InvalidAmount);
                }
            }
            ProposalAction::Recapitalize(amount) => {
                if *amount <= 0 {
                    return Err(Error::InvalidAmount);
                }
            }
            ProposalAction::ResumeNormal => {
                if pool.emergency_assets < pool.total_deposited {
                    return Err(Error::Insolvent);
                }
            }
            _ => {}
        }

        let mut pool = pool;
        let nonce = pool.proposal_nonce;
        pool.proposal_nonce += 1;
        env.storage().instance().set(&DataKey::Pool, &pool);

        // Snapshot the current admin set; only these addresses may approve (#384)
        let snapshot = Self::get_admins(&env);
        let expires_at = env.ledger().sequence() + PROPOSAL_EXPIRY_LEDGERS;

        let proposal = Proposal {
            action,
            approvals: vec![&env, signer],
            expires_at,
            approver_snapshot: snapshot,
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(nonce), &proposal);
        Self::bump_instance(&env);
        Ok(nonce)
    }

    /// Approve an existing proposal. Executes automatically when threshold met.
    pub fn approve(env: Env, signer: Address, proposal_id: u32) -> Result<bool, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let mut proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        // Reject expired proposals and clean them up (#383)
        if env.ledger().sequence() > proposal.expires_at {
            env.storage()
                .instance()
                .remove(&DataKey::Proposal(proposal_id));
            return Err(Error::ProposalExpired);
        }

        // Approvers must be in the snapshot from proposal creation (#384)
        if !proposal.approver_snapshot.contains(&signer) {
            return Err(Error::Unauthorized);
        }

        if proposal.approvals.contains(&signer) {
            return Err(Error::AlreadySigned);
        }
        proposal.approvals.push_back(signer);

        let threshold = Self::get_threshold(&env);
        let threshold_met = proposal.approvals.len() >= threshold;
        if threshold_met {
            Self::execute_proposal(&env, &proposal)?;
            env.storage()
                .instance()
                .remove(&DataKey::Proposal(proposal_id));
        } else {
            env.storage()
                .instance()
                .set(&DataKey::Proposal(proposal_id), &proposal);
        }
        Self::bump_instance(&env);
        Ok(threshold_met)
    }

    /// Cancel a pending proposal. Any signer present in the proposal's snapshot may cancel.
    pub fn cancel_proposal(env: Env, signer: Address, proposal_id: u32) -> Result<(), Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;

        let proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if !proposal.approver_snapshot.contains(&signer) {
            return Err(Error::Unauthorized);
        }

        env.storage()
            .instance()
            .remove(&DataKey::Proposal(proposal_id));
        Self::bump_instance(&env);
        Ok(())
    }

    fn execute_proposal(env: &Env, proposal: &Proposal) -> Result<(), Error> {
        match proposal.action.clone() {
            ProposalAction::AddAdmin(addr) => {
                let mut admins = Self::get_admins(env);
                if !admins.contains(&addr) {
                    admins.push_back(addr);
                    env.storage().instance().set(&DataKey::Admins, &admins);
                }
            }
            ProposalAction::RemoveAdmin(addr) => {
                let admins = Self::get_admins(env);
                let threshold = Self::get_threshold(env);
                // Liveness guard: cannot reduce admin count to below threshold (#383)
                if admins.len() <= threshold {
                    return Err(Error::InvalidAction);
                }
                let mut new_admins: Vec<Address> = Vec::new(env);
                for a in admins.iter() {
                    if a != addr {
                        new_admins.push_back(a);
                    }
                }
                env.storage().instance().set(&DataKey::Admins, &new_admins);
            }
            ProposalAction::ReleaseEscrow(recipient, amount) => {
                let mut pool: Pool = env
                    .storage()
                    .instance()
                    .get(&DataKey::Pool)
                    .ok_or(Error::NotInitialized)?;
                // Re-validate at execution; reserves may have changed since proposal (#384)
                if amount > pool.total_deposited {
                    return Err(Error::InvalidAction);
                }
                // Perform atomic token transfer from contract to the bound recipient.
                let contract_addr = env.current_contract_address();
                Self::atomic_transfer_and(
                    &env,
                    &contract_addr,
                    &recipient,
                    amount,
                    || {
                        // Update free-reserve bucket only (total_deposited reflects locked principal).
                        // We decrement total_deposited to reflect the escrow payout.
                        pool.total_deposited = pool.total_deposited.saturating_sub(amount);
                        env.storage().instance().set(&DataKey::Pool, &pool);
                        Ok(())
                    },
                )?;
            }
            ProposalAction::SetThreshold(t) => {
                let admins = Self::get_admins(env);
                if t == 0 || t > admins.len() {
                    return Err(Error::InvalidAction);
                }
                env.storage().instance().set(&DataKey::Threshold, &t);
            }
            ProposalAction::TriggerEmergency(assets) => {
                let mut pool: Pool = env
                    .storage()
                    .instance()
                    .get(&DataKey::Pool)
                    .ok_or(Error::NotInitialized)?;
                pool.is_emergency = true;
                pool.emergency_assets = assets;
                env.storage().instance().set(&DataKey::Pool, &pool);
                env.events().publish(
                    (symbol_short!("emergency"), symbol_short!("triggered")),
                    assets,
                );
            }
            ProposalAction::Recapitalize(amount) => {
                if amount <= 0 {
                    return Err(Error::InvalidAmount);
                }
                // Transfer tokens from the caller (funder) into the contract.
                let contract_addr = env.current_contract_address();
                Self::atomic_transfer_and(
                    &env,
                    &caller,
                    &contract_addr,
                    amount,
                    || {
                        let mut pool: Pool = env
                            .storage()
                            .instance()
                            .get(&DataKey::Pool)
                            .ok_or(Error::NotInitialized)?;
                        pool.emergency_assets = pool.emergency_assets.saturating_add(amount);
                        env.storage().instance().set(&DataKey::Pool, &pool);
                        env.events().publish(
                            (symbol_short!("emergency"), symbol_short!("recap")),
                            amount,
                        );
                        Ok(())
                    },
                )?;
            }
            ProposalAction::ResumeNormal => {
                let mut pool: Pool = env
                    .storage()
                    .instance()
                    .get(&DataKey::Pool)
                    .ok_or(Error::NotInitialized)?;
                if pool.emergency_assets < pool.total_deposited {
                    return Err(Error::Insolvent);
                }
                pool.is_emergency = false;
                env.storage().instance().set(&DataKey::Pool, &pool);
                env.events().publish(
                    (symbol_short!("emergency"), symbol_short!("resumed")),
                    pool.total_deposited,
                );
            }
        }
        Ok(())
    }

    // ── Join ───────────────────────────────────────────────────────────────
    pub fn join(env: Env, who: Address) -> Result<(), Error> {
        who.require_auth();
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        if pool.is_emergency {
            return Err(Error::InEmergency);
        }
        if Self::has_participant(&env, &who) {
            return Err(Error::AlreadyJoined);
        }
        let p = Participant {
            joined_at: env.ledger().timestamp(),
            deposited: 0,
            locked_until: env.ledger().sequence() + LOCKUP_LEDGERS,
            lockup_multiplier: 100,
            yield_accrued: 0,
            prize: 0,
            claimed_reward: 0,
            withdrawn_principal: 0,
        };
        Self::save_participant(&env, &who, &p);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("joined")), who);
        Ok(())
    }

    // ── Deposit / drip (#376: real token custody) ──────────────────────────
    pub fn drip(env: Env, who: Address, amount: i128) -> Result<(), Error> {
        Self::deposit(env, who, amount)
    }

    pub fn deposit(env: Env, who: Address, amount: i128) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let old_pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        if old_pool.is_emergency {
            return Err(Error::InEmergency);
        }

        let old_participant: Option<Participant> = {
            let key = DataKey::Participant(who.clone());
            env.storage().persistent().get(&key)
        };

        // Transfer tokens from caller to this contract (#376)
        let contract_addr = env.current_contract_address();
        Self::transfer_tokens(&env, &who, &contract_addr, &amount)?;

        // Update participant state — deposit only adds to principal (#377)
        let mut p = old_participant.unwrap_or(Participant {
            joined_at: env.ledger().timestamp(),
            deposited: 0,
            locked_until: env.ledger().sequence() + LOCKUP_LEDGERS,
            lockup_multiplier: 100,
            yield_accrued: 0,
            prize: 0,
            claimed_reward: 0,
            withdrawn_principal: 0,
        });

        p.deposited += amount;
        Self::save_participant(&env, &who, &p);

        // Update pool accounting
        let mut pool: Pool = old_pool;
        pool.total_drips += 1;
        pool.total_deposited += amount;
        env.storage().instance().set(&DataKey::Pool, &pool);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("deposit")),
            (who, amount, pool.total_deposited),
        );
        Ok(())
    }

    /// Deposit with an explicit lockup duration. Caller must be joined.
    /// The lockup_multiplier records the reward weight; it is not applied to principal.
    pub fn deposit_with_duration(
        env: Env,
        who: Address,
        amount: i128,
        lockup_days: u32,
    ) -> Result<(), Error> {
        who.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if !env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::NotInitialized);
        }

        // Transfer tokens from caller to this contract (#376)
        let contract_addr = env.current_contract_address();
        Self::transfer_tokens(&env, &who, &contract_addr, &amount)?;

        vault::apply_time_locked_deposit(&env, &who, amount, lockup_days)?;

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        pool.total_drips += 1;
        pool.total_deposited += amount;
        env.storage().instance().set(&DataKey::Pool, &pool);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Withdraw a time-locked deposit. Returns principal + accrued yield.
    pub fn withdraw_locked(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Self::acquire_lock(&mut pool)?;
        env.storage().instance().set(&DataKey::Pool, &pool);

        let principal = vault::apply_withdrawal(&env, &who)?;

        // Transfer tokens from contract to caller (#376)
        let contract_addr = env.current_contract_address();
        let transfer_result = Self::transfer_tokens(&env, &contract_addr, &who, &principal);

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Self::release_lock(&mut pool);

        if let Err(e) = transfer_result {
            // Rollback: re-insert the participant with original principal
            let p = Participant {
                joined_at: env.ledger().timestamp(),
                deposited: principal,
                locked_until: env.ledger().sequence() + LOCKUP_LEDGERS,
                lockup_multiplier: 100,
                yield_accrued: 0,
                prize: 0,
                claimed_reward: 0,
                withdrawn_principal: 0,
            };
            Self::save_participant(&env, &who, &p);
            env.storage().instance().set(&DataKey::Pool, &pool);
            Self::bump_instance(&env);
            return Err(e);
        }

        env.storage().instance().set(&DataKey::Pool, &pool);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("withdrawn")),
            (who, principal),
        );
        Ok(principal)
    }

    // ── Claim ──────────────────────────────────────────────────────────────
    pub fn claim(env: Env, who: Address) -> Result<i128, Error> {
        Self::claim_reward(env, who)
    }

    pub fn claim_reward(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();

        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        // The deadline instant itself is still claimable; only strictly-later
        // timestamps revert (#440).
        if let Some(deadline) = pool.claim_deadline {
            if env.ledger().timestamp() > deadline {
                return Err(Error::ClaimDeadlinePassed);
            }
        }

        let mut p = Self::load_participant(&env, &who)?;
        let available = (p.yield_accrued + p.prize) - p.claimed_reward;
        p.claimed_reward += available;
        Self::save_participant(&env, &who, &p);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("claimed")),
            (who, available),
        );
        Ok(available)
    }

    // ── Claim deadline & unclaimed reward sweep (#440) ─────────────────────

    /// Configure (or update) the pool's claim deadline as a ledger timestamp.
    /// Only callable by an approved signer. The deadline must be strictly in
    /// the future.
    pub fn set_claim_deadline(env: Env, caller: Address, deadline: u64) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if deadline <= env.ledger().timestamp() {
            return Err(Error::InvalidDeadline);
        }

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        pool.claim_deadline = Some(deadline);
        env.storage().instance().set(&DataKey::Pool, &pool);
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("pool"), symbol_short!("deadline")), deadline);
        Ok(())
    }

    /// Sweep a participant's unclaimed reward (yield_accrued + prize −
    /// claimed_reward) to the pool admin (treasury) once the claim deadline
    /// has strictly passed. Only callable by an approved signer. Reuses the
    /// SAC transfer path from `withdraw`, so it is a no-op transfer when no
    /// token is configured. Marks the participant's reward as fully claimed
    /// so it cannot be swept or claimed twice.
    pub fn sweep_unclaimed(env: Env, caller: Address, who: Address) -> Result<i128, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        let deadline = pool.claim_deadline.ok_or(Error::NoClaimDeadline)?;
        if env.ledger().timestamp() <= deadline {
            return Err(Error::ClaimDeadlineNotReached);
        }

        let mut p = Self::load_participant(&env, &who)?;
        let unclaimed = (p.yield_accrued + p.prize) - p.claimed_reward;
        if unclaimed <= 0 {
            return Ok(0);
        }
        p.claimed_reward += unclaimed;
        Self::save_participant(&env, &who, &p);

        // Transfer first; roll back the participant's claimed_reward on
        // failure so a failed sweep never silently burns the reward (#440,
        // mirrors the withdraw/withdraw_locked rollback pattern from #376).
        let contract_addr = env.current_contract_address();
        if let Err(e) = Self::transfer_tokens(&env, &contract_addr, &pool.admin, &unclaimed) {
            let mut p = Self::load_participant(&env, &who)?;
            p.claimed_reward -= unclaimed;
            Self::save_participant(&env, &who, &p);
            return Err(e);
        }

        pool.unclaimed_swept = true;
        env.storage().instance().set(&DataKey::Pool, &pool);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("swept")),
            (who, pool.admin.clone(), unclaimed),
        );
        Ok(unclaimed)
    }

    // ── Withdraw (#376: real token custody) ────────────────────────────────
    pub fn withdraw(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();

        let mut p = Self::load_participant(&env, &who)?;

        if env.ledger().sequence() < p.locked_until {
            return Err(Error::LockupActive);
        }

        // Reentrancy lock via Pool field
        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Self::acquire_lock(&mut pool)?;
        env.storage().instance().set(&DataKey::Pool, &pool);

        // Withdraw only unwithdrawn principal, not rewards (#377)
        let available = p.deposited - p.withdrawn_principal;
        p.withdrawn_principal += available;
        Self::save_participant(&env, &who, &p);

        // Transfer tokens from contract to caller (#376)
        let contract_addr = env.current_contract_address();
        let transfer_result = Self::transfer_tokens(&env, &contract_addr, &who, &available);

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Self::release_lock(&mut pool);

        if let Err(e) = transfer_result {
            // Rollback: revert withdrawn_principal
            let mut p = Self::load_participant(&env, &who)?;
            p.withdrawn_principal -= available;
            Self::save_participant(&env, &who, &p);
            env.storage().instance().set(&DataKey::Pool, &pool);
            Self::bump_instance(&env);
            return Err(e);
        }

        env.storage().instance().set(&DataKey::Pool, &pool);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("withdrawn")),
            (who, available),
        );
        Ok(available)
    }

    // ── Yield management (#382) ────────────────────────────────────────────

    /// Admin deposits realized yield into the distributable pool.
    pub fn add_yield(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        // Transfer tokens from caller to this contract, then update accounting atomically.
        let self_addr = env.current_contract_address();
        Self::atomic_transfer_and(&env, &caller, &self_addr, amount, || {
            let mut pool: Pool = env
                .storage()
                .instance()
                .get(&DataKey::Pool)
                .ok_or(Error::NotInitialized)?;
            if pool.is_emergency {
                return Err(Error::InEmergency);
            }
            pool.distributable_yield += amount;
            env.storage().instance().set(&DataKey::Pool, &pool);
            Self::bump_instance(&env);
            Ok(())
        })
    }

    /// Admin credits yield from the distributable pool to a specific participant.
    /// Amount must not exceed pool.distributable_yield.
    pub fn credit_yield(
        env: Env,
        caller: Address,
        who: Address,
        amount: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        if pool.is_emergency {
            return Err(Error::InEmergency);
        }
        if amount > pool.distributable_yield {
            return Err(Error::InvalidAction);
        }
        pool.distributable_yield -= amount;
        env.storage().instance().set(&DataKey::Pool, &pool);

        let mut p = Self::load_participant(&env, &who)?;
        p.yield_accrued += amount;
        Self::save_participant(&env, &who, &p);
        Self::bump_instance(&env);
        Ok(())
    }

    // ── Yield strategy (#496) ───────────────────────────────────────────────
    // See `strategy_adapter` module docs for why `withdraw`/`withdraw_locked`
    // deliberately never call into the strategy.

    /// Governed: bind a yield strategy after a capability/version check.
    pub fn set_strategy(env: Env, caller: Address, strategy: Address) -> Result<(), Error> {
        strategy_adapter::set_strategy(&env, &caller, &strategy)
    }

    /// Governed: deploy idle principal into the configured strategy.
    pub fn deploy_to_strategy(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        strategy_adapter::deploy_to_strategy(&env, &caller, amount)
    }

    /// Governed: recall up to `amount` of principal from the strategy.
    /// Returns the amount actually recalled (may be partial).
    pub fn recall_from_strategy(env: Env, caller: Address, amount: i128) -> Result<i128, Error> {
        strategy_adapter::recall_from_strategy(&env, &caller, amount)
    }

    /// Governed: reconcile the strategy's real balance, crediting realized
    /// yield to `distributable_yield` and absorbing realized loss against
    /// `principal_in_strategy`. Returns (realized_yield, realized_loss).
    pub fn harvest_strategy(env: Env, caller: Address) -> Result<(i128, i128), Error> {
        strategy_adapter::harvest_strategy(&env, &caller)
    }

    /// Governed: force-recall the strategy's entire balance regardless of
    /// cached bookkeeping. For use when a strategy is misbehaving.
    pub fn emergency_recall_strategy(env: Env, caller: Address) -> Result<i128, Error> {
        strategy_adapter::emergency_recall_strategy(&env, &caller)
    }

    // ── TTL maintenance (#385) ─────────────────────────────────────────────

    /// Extend TTL for a participant's persistent storage entry.
    pub fn renew_participant(env: Env, who: Address) -> Result<(), Error> {
        if !Self::has_participant(&env, &who) {
            return Err(Error::NotJoined);
        }
        Self::bump_participant(&env, &DataKey::Participant(who));
        Self::bump_instance(&env);
        Ok(())
    }

    /// Extend TTL for all instance storage (pool state, admins, proposals).
    pub fn renew_instance(env: Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::NotInitialized);
        }
        Self::bump_instance(&env);
        Ok(())
    }

    // ── Draw winner ────────────────────────────────────────────────────────
    pub fn draw_winner(env: Env, caller: Address, prize: i128) -> Result<Address, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if prize <= 0 {
            return Err(Error::InvalidAmount);
        }

        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        if pool.is_emergency {
            return Err(Error::InEmergency);
        }

        let winner = pool.admin.clone();

        // Auto-join the winner if they aren't yet a participant
        if !Self::has_participant(&env, &winner) {
            let p = Participant {
                joined_at: env.ledger().timestamp(),
                deposited: 0,
                locked_until: env.ledger().sequence() + LOCKUP_LEDGERS,
                lockup_multiplier: 100,
                yield_accrued: 0,
                prize: 0,
                claimed_reward: 0,
                withdrawn_principal: 0,
            };
            Self::save_participant(&env, &winner, &p);
        }

        // Credit prize to the winner's prize balance (#377)
        let mut p = Self::load_participant(&env, &winner)?;
        p.prize += prize;
        Self::save_participant(&env, &winner, &p);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("payout")),
            (winner.clone(), prize),
        );
        Ok(winner)
    }

    // ── Emergency Pro-rata Exit (#512) ────────────────────────────────────
    pub fn emergency_withdraw(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();

        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        if !pool.is_emergency {
            return Err(Error::NotInEmergency);
        }

        let mut p = Self::load_participant(&env, &who)?;
        let unwithdrawn = p.deposited - p.withdrawn_principal;
        if unwithdrawn <= 0 {
            return Err(Error::InvalidAmount);
        }

        let payout = if pool.total_deposited > 0 && pool.emergency_assets > 0 {
            (unwithdrawn.saturating_mul(pool.emergency_assets)) / pool.total_deposited
        } else {
            0
        };

        pool.total_deposited = pool.total_deposited.saturating_sub(unwithdrawn);
        pool.emergency_assets = pool.emergency_assets.saturating_sub(payout);
        env.storage().instance().set(&DataKey::Pool, &pool);

        p.withdrawn_principal += unwithdrawn;
        Self::save_participant(&env, &who, &p);

        let contract_addr = env.current_contract_address();
        if payout > 0 {
            let _ = Self::transfer_tokens(&env, &contract_addr, &who, &payout);
        }

        env.events().publish(
            (symbol_short!("emergency"), symbol_short!("withdraw")),
            (who, unwithdrawn, payout),
        );

        Ok(payout)
    }

    pub fn is_emergency(env: Env) -> Result<bool, Error> {
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Ok(pool.is_emergency)
    }

    pub fn emergency_assets(env: Env) -> Result<i128, Error> {
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Ok(pool.emergency_assets)
    }

    // ── Views ──────────────────────────────────────────────────────────────
    pub fn pool(env: Env) -> Result<Pool, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)
    }

    pub fn savings(env: Env, who: Address) -> Result<Participant, Error> {
        Self::load_participant(&env, &who)
    }

    pub fn admins(env: Env) -> Vec<Address> {
        Self::get_admins(&env)
    }

    pub fn threshold(env: Env) -> u32 {
        Self::get_threshold(&env)
    }

    /// View the configured token address (#376).
    pub fn token(env: Env) -> Result<Address, Error> {
        Self::get_token_address(&env)
    }

    /// View the configured claim deadline, if any (#440).
    pub fn claim_deadline(env: Env) -> Result<Option<u64>, Error> {
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Ok(pool.claim_deadline)
    }

    /// True once a configured claim deadline has strictly passed. Returns
    /// false when no deadline has been set (#440).
    pub fn claim_deadline_passed(env: Env) -> Result<bool, Error> {
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Ok(match pool.claim_deadline {
            Some(deadline) => env.ledger().timestamp() > deadline,
            None => false,
        })
    }

    /// True once at least one unclaimed-reward sweep has executed for this
    /// pool (#440).
    pub fn unclaimed_swept(env: Env) -> Result<bool, Error> {
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        Ok(pool.unclaimed_swept)
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod benchmarks;
