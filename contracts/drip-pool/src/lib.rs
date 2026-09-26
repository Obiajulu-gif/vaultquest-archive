#![no_std]

//! # Canonical contract (#495)
//!
//! This is the **authoritative** contract for VaultQuest pool state: principal,
//! rewards/yield, round/draw state, pause, and winner settlement all live here.
//! `contracts/_deprecated/vault` is a deprecated, incompatible skeleton (single-admin, no
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

// Host-side test only: the draw-auditability fixture emitter writes a JSON
// file (std::fs) so the standalone TS verifier can consume real contract
// event data in CI (#718). The wasm target never sees this.
#[cfg(any(test, feature = "testutils"))]
extern crate std;

// soroban-sdk 27 dropped the Val conversion impls for `u8` (only u32/i32
// remain), which broke the pre-existing `token_decimals` entrypoints (#599).
// The entrypoints now use u32 end-to-end (see set_token_decimals).
fn decimals_to_val(decimals: u32) -> u32 {
    decimals
}

use soroban_sdk::{
    bytes, contract, contracterror, contractimpl, contracttype, symbol_short, vec, Address, Bytes,
    BytesN, Env, Vec,
};
use vaultquest_common::YieldStrategyClient;

pub mod draw_audit;
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
const MAX_RENEWAL_ITEMS: u32 = 32;
const ROUND_PERMISSIONLESS_FINALIZE_DELAY_SECONDS: u64 = 7 * 24 * 60 * 60;

// ── Time-weighted round tickets (#719) ─────────────────────────────────────
// A `round_deposit`'s exposure to that round's draw is prorated by how much
// of this window remained at deposit time — full weight for a deposit made
// the instant a round opens, decaying toward `ROUND_MIN_TICKET_WEIGHT_BPS`
// for one made just before an expected close. This is independent of when
// `lock_round` actually fires; it just makes tickets track time-in-round
// instead of end-of-round balance, so a same-block deposit-then-withdraw
// around close can win a vanishingly small share of the draw rather than a
// full one. See `round_deposit` for the formula.
const ROUND_TICKET_WEIGHT_WINDOW_SECONDS: u64 = 7 * 24 * 60 * 60;
const ROUND_MIN_TICKET_WEIGHT_BPS: u32 = 500; // 5% floor — late deposits still get a stake
const BPS_DENOMINATOR: u32 = 10_000;

// ── Manipulation-resistant round-winner randomness (#715) ─────────────────
// Full spec, threat model, and independent-verification recipe:
// `contracts/docs/RANDOMNESS.md`. If nobody reveals a committed seed within
// this many seconds of a round locking, `finalize_round_randomness_fallback`
// may be called by anyone to resolve the draw using host PRNG alone (no
// committed seed contributes), so a withheld reveal can never stall a round
// or bias its outcome — it only forfeits the withholder's own influence.
const ROUND_REVEAL_WINDOW_SECONDS: u64 = 24 * 60 * 60;

// ── Draw auditability (#718) ───────────────────────────────────────────────
// Canonical byte serialization for every draw-audit hash input. A hash input
// is always `domain_tag ++ 8-byte big-endian round id ++ payload`, so hashes
// are stable across contract upgrades, SDK versions, and verifiers.
// Domain tags and canonical hash-input serialization live in
// `draw_audit.rs` — the single source of truth for verifiers.

// ── Proposal expiry (~30 days at 5 s/ledger) ──────────────────────────────
const PROPOSAL_EXPIRY_LEDGERS: u32 = 17_280 * 30;

// ── Timelock delay for high-risk governance actions (~24h at 5 s/ledger,
// #533). Applies to fund release, emergency transitions, signer removal,
// threshold changes, and strategy rotation — see `is_high_risk`.
pub(crate) const HIGH_RISK_DELAY_LEDGERS: u32 = 17_280;

// ── Default multi-sig threshold ────────────────────────────────────────────
const DEFAULT_THRESHOLD: u32 = 2;

const CONFIG_SCHEMA_VERSION: u32 = 1;

// ── Storage keys ──────────────────────────────────────────────────────────
#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Admins,    // Vec<Address> — approved signers
    Threshold, // u32 — current multisig threshold
    Pool,
    Participant(Address),       // V2 participant storage (#377)
    ParticipantV1(Address),     // legacy V1 participant storage (migration source)
    Proposal(u32),              // pending admin proposal
    Token,                      // Address — accepted Stellar Asset Contract address (#376)
    ConfigVersion,              // u32 — configuration schema version (#441)
    ProposedStrategy,           // Option<Address> — candidate strategy proposed for rotation (#532)
    StrategyExposureCap,        // i128 — maximum allowable deposit for active strategy (#532)
    ProposedExposureCap,        // i128 — exposure cap for candidate strategy (#532)
    StrategyRotationPhase,      // StrategyRotationPhase — phase of current rotation (#532)
    StrategyRotationReadyAt, // u32 — ledger sequence when the pending rotation may activate (#533)
    GovernanceEpoch,         // u32 — bumped on every Admins/Threshold change (#533)
    MinIdleReserve, // i128 — minimum idle principal governance must leave undeployed (#529)
    WithdrawalQueueHead, // u32 — next withdrawal request id to fulfill (#529)
    WithdrawalQueueTail, // u32 — next withdrawal request id to assign (#529)
    WithdrawalRequest(u32), // queued withdrawal request, by id (#529)
    ParticipantQueue(Address), // Address -> pending request id, prevents duplicate queuing (#529)
    RoundNonce,     // u32 — next round id to assign (#508)
    Round(u32),     // Round — round-scoped state, by round id (#508)
    RoundDeposit(Address, u32), // i128 — a participant's principal snapshotted into a
    // specific round; keyed per (address, round_id) rather than a Vec on
    // Participant to avoid unbounded per-participant storage growth (#508)
    TokenDecimals, // u8 — token decimal precision for exact unit handling (#599)
    AllowedStrategyCodeHashes, // Vec<BytesN<32>> — allowlisted strategy WASM hashes (#602)
    MaxWalletDeposit, // i128 — per-wallet cap on cumulative Participant.deposited; 0 = uncapped (#643)
    MaxPoolDeposit,   // i128 — protocol-wide cap on pool.total_deposited; 0 = uncapped (#643)
    // ── Round-winner randomness (#715) ────────────────────────────────────
    RoundCommitters(u32), // Vec<Address> — signers who committed a randomness seed for this round, in commit order
    RoundCommitment(Address, u32), // BytesN<32> — sha256(seed) a signer committed for a round
    RoundRevealedSeed(Address, u32), // BytesN<32> — seed a signer revealed for a round, once verified
    RoundRandomness(u32), // RoundRandomness — the resolved winning ticket + provenance, set exactly once
    RoundSelectionCursor(u32), // i128 — cumulative weighted deposit processed so far by select_round_winner
    RoundSelectionSeq(u32), // u32 — last-processed canonical ordering position (see RoundParticipantSeq)
    RoundWinner(u32),       // Address — the depositor whose ticket range contained the winning ticket
    RoundParticipantSeq(Address, u32), // u32 — canonical, deposit-arrival-order position of an address within a round;
    // assigned once, at an address's first `round_deposit` into that round. Used only to give
    // `select_round_winner` a submitter-proof processing order — nobody choosing which addresses to
    // submit, or in what batches, can change an address's own canonical position (#715).
    RoundParticipantSeqNonce(u32), // u32 — next RoundParticipantSeq value to assign for a round
    // ── Draw auditability (#718) ───────────────────────────────────────────
    RoundDrawCommit(u32), // RoundDrawCommit — seed commitment + snapshot Merkle root, frozen at lock (#718)
    RoundDrawResult(u32), // RoundDrawResult — revealed seed, winner index, and winner (#718)
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
    IncompatibleConfig = 24,      // configuration schema version mismatch (#441)
    GovernanceEpochChanged = 25,  // admin/threshold set changed since proposal creation (#533)
    TimelockNotElapsed = 26,      // high-risk proposal executed before its delay (#533)
    StrategyNotSet = 51,
    StrategyVersionUnsupported = 52,
    StrategyPaused = 53,
    RedeemFailed = 54,
    DepositFailed = 55,
    StrategyRotationPending = 56,
    StrategyRotationNotInProgress = 57,
    StrategyUnreconciledPrincipal = 58,
    ExposureCapExceeded = 59,
    StrategyAssetMismatch = 60,
    StrategyRotationDelayNotElapsed = 61, // activate_strategy before timelock elapses (#533)
    InsufficientIdleReserve = 62,         // deploy_to_strategy would breach the idle buffer (#529)
    WithdrawalAlreadyQueued = 64, // participant already has a pending queued withdrawal (#529)
    WithdrawalRequestNotFound = 65,
    WithdrawalRequestNotOwned = 66,
    WithdrawalRequestNotPending = 67,
    RoundNotFound = 68,       // referenced round id has no stored Round (#508)
    RoundNotOpen = 69,        // round_deposit into a round that isn't Open (#508)
    RoundNotLocked = 70,      // settle_round called on a round that isn't Locked (#508)
    RoundAlreadySettled = 71, // settle_round/round_claim called twice on the same round (#508)
    RoundAccountingViolation = 72, // a round-scoped invariant would be broken by this mutation (#508)
    RenewalLimitExceeded = 73,     // permissionless TTL renewal request exceeds bounded work budget
    RoundFinalizationTooEarly = 74, // permissionless finalization before objective deadline
    TokenDecimalsNotConfigured = 75, // token decimals not set (#599)
    StrategyCodeHashNotAllowed = 76, // strategy code hash not on allowlist (#602)
    BalanceVerificationFailed = 77, // strategy reported values not backed by real balance (#601)
    RoundHasOutstandingDeposits = 78, // prune_round called but participants still have unclaimed deposits (#558)
    WalletDepositCapExceeded = 80, // deposit would push Participant.deposited above MaxWalletDeposit (#643)
    PoolDepositCapExceeded = 81, // deposit would push pool.total_deposited above MaxPoolDeposit (#643)
    RandomnessAlreadyCommitted = 82, // this signer already committed a randomness seed for this round (#715)
    RandomnessNotCommitted = 83, // reveal attempted but this signer never committed for this round (#715)
    RandomnessCommitmentMismatch = 84, // sha256(revealed seed) != the stored commitment (#715)
    RandomnessSeedAlreadyRevealed = 85, // this signer already revealed their seed for this round (#715)
    RandomnessAlreadyResolved = 86, // this round's winning ticket has already been derived (#715)
    RevealWindowNotElapsed = 87, // fallback randomness requested before the reveal grace period passed (#715)
    RandomnessNotResolved = 88, // select_round_winner called before a winning ticket was derived (#715)
    CanonicalOrderViolation = 89, // candidates submitted out of canonical order, or duplicated (#715)
    NotRoundParticipant = 90, // candidate address never made a round_deposit into this round (#715)
    RoundWinnerNotSelected = 91, // draw_winner called before select_round_winner found a winner (#715)
    RoundDrawSeedMismatch = 92,  // revealed seed does not match the committed seed hash (#718)
    RoundDrawNotLocked = 93,     // round_commit_draw called on a round that isn't Locked (#718)
    RoundDrawAlreadyCommitted = 94, // round_commit_draw called twice for the same round (#718)
    RoundDrawNotSettled = 95,    // round_draw called on a round that isn't Settled (#718)
    RoundDrawWinnerNotInSnapshot = 96, // Merkle proof does not verify for this round's snapshot root (#718)
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
    pub strategy: Option<Address>, // active yield strategy address (#496)
    pub principal_in_strategy: i128, // principal currently deployed in strategy (#496)
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
    pub threshold_snapshot: u32, // approvals required, frozen at creation — a later
    // SetThreshold can never raise or lower what THIS proposal needs (#533)
    pub epoch_snapshot: u32, // governance epoch at creation; a later Admins/Threshold
    // change bumps the epoch and makes this proposal stale (#533)
    pub ready_at: u32, // ledger sequence at/after which this proposal may execute;
                       // `created_at + HIGH_RISK_DELAY_LEDGERS` for high-risk actions,
                       // `created_at` (immediate) otherwise (#533)
}

/// Lifecycle status of a queued withdrawal request (#529).
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum WithdrawalRequestStatus {
    Pending,
    Fulfilled,
    Cancelled,
    Expired,
}

/// A FIFO withdrawal request created when idle liquidity cannot cover an
/// immediate withdrawal because principal is deployed to a strategy (#529).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct WithdrawalRequest {
    pub who: Address,
    pub amount: i128, // remaining amount still owed via this request
    pub requested_at: u32,
    pub expires_at: u32,
    pub status: WithdrawalRequestStatus,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum ProposalAction {
    ReleaseEscrow(Address, i128), // recipient, amount
    AddAdmin(Address),
    RemoveAdmin(Address),
    SetThreshold(u32),      // change the approval threshold (#383)
    TriggerEmergency(i128), // enter emergency mode with available asset amount (#512)
    Recapitalize(i128),     // inject capital into emergency pool (#512)
    ResumeNormal,           // return to normal operations (#512)
}

/// Lifecycle status of a round (#508).
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum RoundStatus {
    Open,    // accepting round_deposit
    Locked,  // principal_snapshot frozen; deposits rejected
    Settled, // realized_yield/prize_reserve fixed; round_claim enabled
}

/// Round-scoped accounting (#508). Isolates yield/prize computed for one
/// round from every other round: `principal_snapshot` is frozen at
/// `lock_round`, `realized_yield`/`prize_reserve` are fixed once at
/// `settle_round`, and neither can be mutated afterward. This is what
/// prevents a late deposit from diluting an already-locked round's snapshot,
/// and prevents yield settled for round N from being double-counted into
/// round N+1.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Round {
    pub id: u32,
    pub status: RoundStatus,
    pub opened_at: u64,           // ledger timestamp when opened
    pub locked_at: Option<u64>,   // ledger timestamp when locked
    pub settled_at: Option<u64>,  // ledger timestamp when settled
    pub principal_snapshot: i128, // sum of round_deposit amounts at lock time
    pub realized_yield: i128,     // set once, at settlement; 0 until then
    pub prize_reserve: i128,      // set once, at settlement; 0 until then
    pub claimed: i128,            // running total paid out via round_claim
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum RenewalKey {
    Participant(Address),
    Round(u32),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum BlockingKey {
    /// No renewal is blocked.
    Unblocked,
    Participant(Address),
    Round(u32),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RenewalReport {
    pub requested: u32,
    pub renewed: u32,
    pub skipped: u32,
    pub required_budget: u32,
    // soroban-sdk 27 cannot generate ScVal conversions for Option<T> where T
    // is itself a contracttype, so absence of a blocker is represented by
    // the explicit `Unblocked` variant instead of Option::None.
    pub blocking_key: BlockingKey,
}

/// A single node in the Merkle proof for one participant of a round (#718).
/// `position` is `false` when `hash` is the left sibling at this depth,
/// `true` when it is the right sibling.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct MerkleProofEntry {
    pub hash: BytesN<32>,
    pub position: bool, // false = left sibling, true = right sibling
}

/// Draw-audit commitment stored when a round is locked (#718). From this
/// point the seed is pinned: whichever admin reveals it in `round_draw` must
/// present a preimage of `seed_hash`, and the participant snapshot that
/// determines every ticket weight is pinned by `snapshot_root`.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RoundDrawCommit {
    /// SHA-256(DRAW_SEED_DOMAIN || round_id_be8 || seed) — commitment to the
    /// hidden seed chosen by the admin at lock time.
    pub seed_hash: BytesN<32>,
    /// Merkle root over the participant snapshot: one leaf per participant
    /// with a non-zero round deposit, sorted by address strkey ascending.
    pub snapshot_root: BytesN<32>,
    /// Number of leaves covered by `snapshot_root` (ticket count).
    pub leaf_count: u32,
    /// Ledger sequence at which this commitment was stored.
    pub committed_at_ledger: u32,
}

/// Draw-audit result stored when the draw executes (#718). Together with
/// `RoundDrawCommit` and the `round_draw` event, this is everything an
/// independent auditor needs to recompute the winner from public data only.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RoundDrawResult {
    /// The revealed seed — SHA-256 preimage of `RoundDrawCommit.seed_hash`.
    pub seed: BytesN<32>,
    /// Winner's leaf index in the address-sorted snapshot.
    pub winner_index: u32,
    /// The winning participant's address.
    pub winner: Address,
    /// Ledger sequence at which the draw executed.
    pub drawn_at_ledger: u32,
}

/// Caller-supplied evidence for `round_draw` (#718): the revealed seed, the
/// winner address, the winner's frozen round deposit, and the winner's
/// Merkle proof path under the committed snapshot root. Every field is
/// verified against on-chain state before the draw is accepted.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct DrawEvidence {
    /// Revealed 32-byte seed — must hash to the committed `seed_hash`.
    pub seed: BytesN<32>,
    /// The winning participant's address.
    pub winner: Address,
    /// The winner's frozen per-round deposit (leaf-hash witness).
    pub deposit: i128,
    /// Merkle proof path for the winner's leaf, bottom-up.
    pub proof: Vec<MerkleProofEntry>,
}

/// Provenance of a round's resolved winning ticket (#715).
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
pub enum RandomnessSource {
    /// Derived from sha256 of every committer's revealed seed, concatenated
    /// in commit order. Secure as long as at least one committer kept their
    /// seed secret until reveal.
    CommitReveal,
    /// Derived from the host PRNG alone (no committed seed contributes).
    /// Used only when no committer revealed within `ROUND_REVEAL_WINDOW_SECONDS`
    /// of the round locking, so the round is never stuck forever.
    PrngFallback,
}

/// A round's resolved randomness (#715). Set exactly once per round, by
/// either `reveal_round_randomness` (once every committer has revealed) or
/// `finalize_round_randomness_fallback` (once the reveal window has passed).
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct RoundRandomness {
    pub winning_ticket: i128, // in [0, round.principal_snapshot) at resolution time
    pub source: RandomnessSource,
    pub resolved_at: u64,
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

    fn require_compatible_config(env: &Env) -> Result<(), Error> {
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ConfigVersion)
            .unwrap_or(1);
        if version != CONFIG_SCHEMA_VERSION {
            return Err(Error::IncompatibleConfig);
        }
        Ok(())
    }

    // ── Governance epoch & timelock helpers (#533) ────────────────────────

    fn get_epoch(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::GovernanceEpoch)
            .unwrap_or(0)
    }

    /// Bump the governance epoch. Called whenever the admin set or threshold
    /// changes, so proposals snapshotted under the old rules become stale
    /// (#533) instead of being silently approved/executed under new ones.
    fn bump_epoch(env: &Env) {
        let epoch = Self::get_epoch(env) + 1;
        env.storage()
            .instance()
            .set(&DataKey::GovernanceEpoch, &epoch);
    }

    /// High-risk actions get a ledger-based execution delay after the
    /// approval threshold is met, so they can never execute immediately even
    /// when fully approved (#533).
    fn is_high_risk(action: &ProposalAction) -> bool {
        matches!(
            action,
            ProposalAction::ReleaseEscrow(_, _)
                | ProposalAction::RemoveAdmin(_)
                | ProposalAction::SetThreshold(_)
                | ProposalAction::TriggerEmergency(_)
                | ProposalAction::ResumeNormal
        )
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
    /// Fails closed with TokenNotConfigured if no token is configured (#524).
    /// Returns Ok(()) on success, Err(TransferFailed) on failure.
    fn transfer_tokens(
        env: &Env,
        from: &Address,
        to: &Address,
        amount: &i128,
    ) -> Result<(), Error> {
        if !Self::has_token_configured(env) {
            return Err(Error::TokenNotConfigured);
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
    fn atomic_transfer_and<F>(
        env: &Env,
        from: &Address,
        to: &Address,
        amount: i128,
        accounting_update: F,
    ) -> Result<(), Error>
    where
        F: FnOnce() -> Result<(), Error>,
    {
        // Perform token transfer first.
        Self::transfer_tokens(env, from, to, &amount)?;
        // Apply accounting changes.
        accounting_update()
    }

    // ── Withdrawal queue helpers (#529) ────────────────────────────────────

    /// Real spendable custody: the contract's own SAC balance. When no token
    /// is configured, return 0 idle liquidity (#524).
    fn idle_liquidity(env: &Env) -> i128 {
        if !Self::has_token_configured(env) {
            return 0;
        }
        let token_addr = match Self::get_token_address(env) {
            Ok(a) => a,
            Err(_) => return 0,
        };
        let contract_addr = env.current_contract_address();
        soroban_sdk::token::TokenClient::new(env, &token_addr).balance(&contract_addr)
    }

    /// Push a new FIFO withdrawal request. Bounded and ordered by assignment
    /// order — the queue can only be processed head-first (#529).
    fn enqueue_withdrawal(env: &Env, who: &Address, amount: i128) -> u32 {
        let tail: u32 = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawalQueueTail)
            .unwrap_or(0);
        let request = WithdrawalRequest {
            who: who.clone(),
            amount,
            requested_at: env.ledger().sequence(),
            expires_at: env.ledger().sequence() + PROPOSAL_EXPIRY_LEDGERS,
            status: WithdrawalRequestStatus::Pending,
        };
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalRequest(tail), &request);
        env.storage()
            .instance()
            .set(&DataKey::ParticipantQueue(who.clone()), &tail);
        // u32 wrapping advance is intentional: the queue id space wraps at
        // u32::MAX (covered by the #579 boundary tests).
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalQueueTail, &tail.wrapping_add(1));
        Self::bump_instance(env);
        tail
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
            strategy: None,
            principal_in_strategy: 0,
        };
        let admins: Vec<Address> = vec![&env, admin.clone()];
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Admins, &admins);
        env.storage()
            .instance()
            .set(&DataKey::Threshold, &DEFAULT_THRESHOLD);
        env.storage().instance().set(&DataKey::Pool, &pool);
        env.storage()
            .instance()
            .set(&DataKey::ConfigVersion, &CONFIG_SCHEMA_VERSION);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("created")), admin);
        Ok(())
    }

    /// Admin-only: migrate the configuration version to a new schema version.
    pub fn update_config_version(
        env: Env,
        caller: Address,
        expected_version: u32,
        new_version: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;

        let current = env
            .storage()
            .instance()
            .get(&DataKey::ConfigVersion)
            .unwrap_or(1);
        if current != expected_version {
            return Err(Error::IncompatibleConfig);
        }

        env.storage()
            .instance()
            .set(&DataKey::ConfigVersion, &new_version);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("config"), symbol_short!("ver_chg")),
            (expected_version, new_version),
        );

        Ok(())
    }

    /// Configure the accepted Stellar Asset Contract address.
    /// Only callable by an authorized signer. Fails if already configured (#524).
    pub fn set_token(env: Env, caller: Address, token: Address) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
        if Self::has_token_configured(&env) {
            return Err(Error::AlreadyInitialized);
        }
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
        Self::require_compatible_config(&env)?;
        let mut admins = Self::get_admins(&env);
        let threshold = Self::get_threshold(&env);
        // Prevent direct bypass once threshold is reachable
        if admins.len() >= threshold {
            return Err(Error::Unauthorized);
        }
        if !admins.contains(&new_admin) {
            admins.push_back(new_admin);
            env.storage().instance().set(&DataKey::Admins, &admins);
            Self::bump_epoch(&env);
        }
        Self::bump_instance(&env);
        Ok(())
    }

    // ── Multi-sig: propose an admin action ─────────────────────────────────
    pub fn propose(env: Env, signer: Address, action: ProposalAction) -> Result<u32, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;
        Self::require_compatible_config(&env)?;

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

        // Snapshot the current admin set, threshold and governance epoch;
        // only this snapshot governs whether/when this proposal can execute,
        // regardless of later Admins/Threshold changes (#384, #533).
        let snapshot = Self::get_admins(&env);
        let threshold_snapshot = Self::get_threshold(&env);
        let epoch_snapshot = Self::get_epoch(&env);
        let now = env.ledger().sequence();
        let ready_at = if Self::is_high_risk(&action) {
            now + HIGH_RISK_DELAY_LEDGERS
        } else {
            now
        };
        let expires_at = now + PROPOSAL_EXPIRY_LEDGERS;

        let proposal = Proposal {
            action,
            approvals: vec![&env, signer],
            expires_at,
            approver_snapshot: snapshot,
            threshold_snapshot,
            epoch_snapshot,
            ready_at,
        };
        env.storage()
            .instance()
            .set(&DataKey::Proposal(nonce), &proposal);
        Self::bump_instance(&env);
        Ok(nonce)
    }

    /// Approve an existing proposal. Executes automatically once the
    /// proposal's own snapshotted threshold is met AND (for high-risk
    /// actions) its timelock delay has elapsed — never before (#533).
    /// Returns whether the action executed as part of this call.
    pub fn approve(env: Env, signer: Address, proposal_id: u32) -> Result<bool, Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;
        Self::require_compatible_config(&env)?;

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

        // A later Admins/Threshold change invalidates proposals snapshotted
        // under the old epoch — they cannot be revived, only re-proposed (#533).
        if proposal.epoch_snapshot != Self::get_epoch(&env) {
            env.storage()
                .instance()
                .remove(&DataKey::Proposal(proposal_id));
            return Err(Error::GovernanceEpochChanged);
        }

        // Approvers must be in the snapshot from proposal creation (#384)
        if !proposal.approver_snapshot.contains(&signer) {
            return Err(Error::Unauthorized);
        }

        if proposal.approvals.contains(&signer) {
            return Err(Error::AlreadySigned);
        }
        proposal.approvals.push_back(signer);

        // Threshold is always evaluated against the snapshot taken at
        // creation, never the live value (#533).
        let threshold_met = proposal.approvals.len() >= proposal.threshold_snapshot;
        let executed = if threshold_met && env.ledger().sequence() >= proposal.ready_at {
            Self::apply_proposal_action(&env, &proposal)?;
            env.storage()
                .instance()
                .remove(&DataKey::Proposal(proposal_id));
            true
        } else {
            env.storage()
                .instance()
                .set(&DataKey::Proposal(proposal_id), &proposal);
            false
        };
        Self::bump_instance(&env);
        Ok(executed)
    }

    /// Execute a proposal whose threshold was already met by `approve` but
    /// whose timelock delay had not yet elapsed. Any current signer may
    /// trigger it once the delay passes and before expiry (#533).
    pub fn execute_proposal(env: Env, caller: Address, proposal_id: u32) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;

        let proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        if proposal.epoch_snapshot != Self::get_epoch(&env) {
            env.storage()
                .instance()
                .remove(&DataKey::Proposal(proposal_id));
            return Err(Error::GovernanceEpochChanged);
        }

        if env.ledger().sequence() > proposal.expires_at {
            env.storage()
                .instance()
                .remove(&DataKey::Proposal(proposal_id));
            return Err(Error::ProposalExpired);
        }

        if proposal.approvals.len() < proposal.threshold_snapshot {
            return Err(Error::ThresholdNotMet);
        }

        if env.ledger().sequence() < proposal.ready_at {
            return Err(Error::TimelockNotElapsed);
        }

        Self::apply_proposal_action(&env, &proposal)?;
        env.storage()
            .instance()
            .remove(&DataKey::Proposal(proposal_id));
        Self::bump_instance(&env);
        Ok(())
    }

    /// Cancel a pending proposal. Any signer present in the proposal's
    /// snapshot may cancel. Once the governance epoch has moved on, any
    /// *current* signer may also cancel — otherwise a rotated-out signer set
    /// could leave a stale proposal permanently stuck (#533).
    pub fn cancel_proposal(env: Env, signer: Address, proposal_id: u32) -> Result<(), Error> {
        signer.require_auth();
        Self::require_compatible_config(&env)?;

        let proposal: Proposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
            .ok_or(Error::ProposalNotFound)?;

        let is_current_signer = Self::get_admins(&env).contains(&signer);
        let in_snapshot = proposal.approver_snapshot.contains(&signer);
        let epoch_stale = proposal.epoch_snapshot != Self::get_epoch(&env);

        let authorized = if epoch_stale {
            is_current_signer || in_snapshot
        } else {
            is_current_signer && in_snapshot
        };
        if !authorized {
            return Err(Error::Unauthorized);
        }

        env.storage()
            .instance()
            .remove(&DataKey::Proposal(proposal_id));
        Self::bump_instance(&env);
        Ok(())
    }

    fn apply_proposal_action(env: &Env, proposal: &Proposal) -> Result<(), Error> {
        match proposal.action.clone() {
            ProposalAction::AddAdmin(addr) => {
                let mut admins = Self::get_admins(env);
                if !admins.contains(&addr) {
                    admins.push_back(addr);
                    env.storage().instance().set(&DataKey::Admins, &admins);
                    Self::bump_epoch(env);
                }
            }
            ProposalAction::RemoveAdmin(addr) => {
                let admins = Self::get_admins(env);
                let threshold = Self::get_threshold(env);
                // Liveness guard: cannot reduce admin count to below threshold
                // (#383). Checked against the CURRENT threshold at execution
                // time, since this is a live safety invariant rather than
                // something frozen by the approval-count snapshot (#533).
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
                Self::bump_epoch(env);
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
                Self::atomic_transfer_and(&env, &contract_addr, &recipient, amount, || {
                    // Update free-reserve bucket only (total_deposited reflects locked principal).
                    // We decrement total_deposited to reflect the escrow payout.
                    pool.total_deposited = pool.total_deposited.saturating_sub(amount);
                    env.storage().instance().set(&DataKey::Pool, &pool);
                    Ok(())
                })?;
            }
            ProposalAction::SetThreshold(t) => {
                let admins = Self::get_admins(env);
                if t == 0 || t > admins.len() {
                    return Err(Error::InvalidAction);
                }
                env.storage().instance().set(&DataKey::Threshold, &t);
                Self::bump_epoch(env);
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
                // Transfer tokens from the proposal creator (funder) into the contract.
                let funder = proposal.approvals.get(0).unwrap();
                let contract_addr = env.current_contract_address();
                Self::atomic_transfer_and(&env, &funder, &contract_addr, amount, || {
                    let mut pool: Pool = env
                        .storage()
                        .instance()
                        .get(&DataKey::Pool)
                        .ok_or(Error::NotInitialized)?;
                    pool.emergency_assets = pool.emergency_assets.saturating_add(amount);
                    env.storage().instance().set(&DataKey::Pool, &pool);
                    env.events()
                        .publish((symbol_short!("emergency"), symbol_short!("recap")), amount);
                    Ok(())
                })?;
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
        Self::require_compatible_config(&env)?;
        if !Self::has_token_configured(&env) {
            return Err(Error::TokenNotConfigured);
        }
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
        Self::require_compatible_config(&env)?;
        if !Self::has_token_configured(&env) {
            return Err(Error::TokenNotConfigured);
        }
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

        // Deposit concentration limits (#643) — checked against the
        // pre-transfer state, before any tokens move, so a capped deposit
        // never transfers funds it's about to reject.
        Self::check_deposit_caps(
            &env,
            old_participant.as_ref().map(|p| p.deposited).unwrap_or(0),
            old_pool.total_deposited,
            amount,
        )?;

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
        Self::require_compatible_config(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let old_pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        // Deposit concentration limits (#643) — same check as `deposit`,
        // against pre-transfer state. `apply_time_locked_deposit` below
        // requires an existing Participant record (this path is documented
        // as "caller must already be joined"), so loading it here to read
        // the current deposited amount is safe.
        let current_wallet_deposited = Self::load_participant(&env, &who)?.deposited;
        Self::check_deposit_caps(
            &env,
            current_wallet_deposited,
            old_pool.total_deposited,
            amount,
        )?;

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
        Self::require_compatible_config(&env)?;
        if !Self::has_token_configured(&env) {
            return Err(Error::TokenNotConfigured);
        }

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
        Self::require_compatible_config(&env)?;
        if !Self::has_token_configured(&env) {
            return Err(Error::TokenNotConfigured);
        }

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
        if available <= 0 {
            return Ok(0);
        }
        p.claimed_reward += available;
        Self::save_participant(&env, &who, &p);

        // Transfer first; roll back claimed_reward on failure so a failed
        // claim never silently burns the reward and can be retried (#526,
        // mirrors the withdraw/sweep_unclaimed rollback pattern from #376/#440).
        let contract_addr = env.current_contract_address();
        if let Err(e) = Self::transfer_tokens(&env, &contract_addr, &who, &available) {
            let mut p = Self::load_participant(&env, &who)?;
            p.claimed_reward -= available;
            Self::save_participant(&env, &who, &p);
            return Err(e);
        }

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
        Self::require_compatible_config(&env)?;
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
        Self::require_compatible_config(&env)?;

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

    /// Withdraw unwithdrawn principal. Returns the amount paid out
    /// immediately. If idle custody can't cover it (principal is deployed
    /// to a strategy), returns `Ok(0)` and enqueues a FIFO withdrawal
    /// request instead of reverting — a Soroban top-level call that returns
    /// `Err` rolls back all of its own storage writes, so signaling "queued"
    /// via an error would silently discard the just-created queue entry.
    /// Callers should check `withdrawal_request_of` to distinguish a
    /// genuine zero balance from a queued request (#529).
    pub fn withdraw(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        Self::require_compatible_config(&env)?;
        if !Self::has_token_configured(&env) {
            return Err(Error::TokenNotConfigured);
        }

        let mut p = Self::load_participant(&env, &who)?;

        if env.ledger().sequence() < p.locked_until {
            return Err(Error::LockupActive);
        }

        if env
            .storage()
            .instance()
            .has(&DataKey::ParticipantQueue(who.clone()))
        {
            return Err(Error::WithdrawalAlreadyQueued);
        }

        // Reentrancy lock via Pool field
        let mut pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;

        // Never trap on insufficient real custody — queue the request for
        // governed strategy recall instead (#529). This must return Ok,
        // not Err: a failing top-level call rolls back everything it wrote,
        // including the queue entry just created.
        let available = p.deposited - p.withdrawn_principal;
        let idle = Self::idle_liquidity(&env);
        if available > 0 && available > idle {
            let qid = Self::enqueue_withdrawal(&env, &who, available);
            env.events().publish(
                (symbol_short!("wq"), symbol_short!("queued")),
                (who, available, qid),
            );
            return Ok(0);
        }

        Self::acquire_lock(&mut pool)?;
        env.storage().instance().set(&DataKey::Pool, &pool);

        // Withdraw only unwithdrawn principal, not rewards (#377)
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

    // ── Liquidity buffer & withdrawal queue (#529) ─────────────────────────

    /// Governed: set the minimum idle principal `deploy_to_strategy` must
    /// leave undeployed, so normal withdrawals always have custody to draw
    /// from without depending on strategy recall.
    pub fn set_min_idle_reserve(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MinIdleReserve, &amount);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("idlecfg")), amount);
        Ok(())
    }

    /// View the configured minimum idle reserve (#529).
    pub fn min_idle_reserve(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MinIdleReserve)
            .unwrap_or(0)
    }

    // ── Deposit concentration limits (#643) ────────────────────────────────

    /// Governed: set the maximum cumulative principal a single wallet may
    /// hold in this pool (`Participant.deposited`, checked in `deposit` and
    /// `deposit_with_duration`). `0` means uncapped — the default, so an
    /// unconfigured pool behaves exactly as it did before this cap existed.
    pub fn set_max_wallet_deposit(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxWalletDeposit, &amount);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("walletcap")), amount);
        Ok(())
    }

    /// View the configured per-wallet deposit cap. `0` means uncapped (#643).
    pub fn max_wallet_deposit(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxWalletDeposit)
            .unwrap_or(0)
    }

    /// Governed: set the maximum protocol-wide principal this pool may hold
    /// (`pool.total_deposited`, checked in `deposit` and
    /// `deposit_with_duration`). `0` means uncapped — the default.
    pub fn set_max_pool_deposit(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
        if amount < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MaxPoolDeposit, &amount);
        Self::bump_instance(&env);
        env.events()
            .publish((symbol_short!("pool"), symbol_short!("poolcap")), amount);
        Ok(())
    }

    /// View the configured protocol-wide deposit cap. `0` means uncapped (#643).
    pub fn max_pool_deposit(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MaxPoolDeposit)
            .unwrap_or(0)
    }

    /// Remaining per-wallet capacity for `who`, in the same units as
    /// `deposit`'s `amount`. `i128::MAX` when uncapped, so a caller doesn't
    /// need to special-case "no cap" separately from "very large headroom"
    /// (#643).
    pub fn remaining_wallet_capacity(env: Env, who: Address) -> i128 {
        let cap = Self::max_wallet_deposit(env.clone());
        if cap == 0 {
            return i128::MAX;
        }
        let deposited: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Participant(who))
            .map(|p: Participant| p.deposited)
            .unwrap_or(0);
        cap.saturating_sub(deposited).max(0)
    }

    /// Remaining protocol-wide capacity, in the same units as `deposit`'s
    /// `amount`. `i128::MAX` when uncapped (#643).
    pub fn remaining_pool_capacity(env: Env) -> i128 {
        let cap = Self::max_pool_deposit(env.clone());
        if cap == 0 {
            return i128::MAX;
        }
        let total_deposited: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .map(|p: Pool| p.total_deposited)
            .unwrap_or(0);
        cap.saturating_sub(total_deposited).max(0)
    }

    /// Shared cap-enforcement check for every entry point that increases
    /// `Participant.deposited`/`pool.total_deposited`
    /// (`deposit`/`deposit_with_duration`). Reads both caps and both current
    /// totals fresh from storage on every call — Soroban applies
    /// transactions to a contract sequentially within a ledger close, so a
    /// check against storage read at the top of this call, in the same
    /// invocation that then writes the updated totals, cannot be raced by a
    /// concurrently-submitted deposit the way a client-side pre-check could
    /// (#643).
    fn check_deposit_caps(
        env: &Env,
        current_wallet_deposited: i128,
        current_pool_deposited: i128,
        amount: i128,
    ) -> Result<(), Error> {
        let wallet_cap: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxWalletDeposit)
            .unwrap_or(0);
        if wallet_cap > 0 && current_wallet_deposited.saturating_add(amount) > wallet_cap {
            return Err(Error::WalletDepositCapExceeded);
        }

        let pool_cap: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MaxPoolDeposit)
            .unwrap_or(0);
        if pool_cap > 0 && current_pool_deposited.saturating_add(amount) > pool_cap {
            return Err(Error::PoolDepositCapExceeded);
        }

        Ok(())
    }

    /// Governed: pay out pending withdrawal requests from the head of the
    /// FIFO queue, in order, up to `max_requests` and up to currently idle
    /// liquidity. A request blocking on insufficient liquidity is paid
    /// partially and stays at the head — later, smaller requests are never
    /// paid out of order (#529). Returns the total amount paid.
    pub fn fulfill_withdrawal_queue(
        env: Env,
        caller: Address,
        max_requests: u32,
    ) -> Result<i128, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;

        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        if pool.is_emergency {
            return Err(Error::InEmergency);
        }

        let mut head: u32 = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawalQueueHead)
            .unwrap_or(0);
        let tail: u32 = env
            .storage()
            .instance()
            .get(&DataKey::WithdrawalQueueTail)
            .unwrap_or(0);

        let mut total_paid: i128 = 0;
        let mut processed: u32 = 0;
        let contract_addr = env.current_contract_address();

        // Pending count uses wrapping subtraction: the queue id space wraps
        // at u32::MAX (#579), so head=MAX-1/tail=0 still means 2 pending.
        let pending = tail.wrapping_sub(head);
        let mut iterated: u32 = 0;

        while iterated < pending && processed < max_requests {
            let key = DataKey::WithdrawalRequest(head);
            let mut request: WithdrawalRequest = match env.storage().instance().get(&key) {
                Some(r) => r,
                None => {
                    head = head.wrapping_add(1);
                    iterated += 1;
                    continue;
                }
            };

            if request.status != WithdrawalRequestStatus::Pending {
                head = head.wrapping_add(1);
                iterated += 1;
                continue;
            }

            if env.ledger().sequence() > request.expires_at {
                request.status = WithdrawalRequestStatus::Expired;
                env.storage().instance().set(&key, &request);
                env.storage()
                    .instance()
                    .remove(&DataKey::ParticipantQueue(request.who.clone()));
                head = head.wrapping_add(1);
                iterated += 1;
                processed += 1;
                continue;
            }

            let idle = Self::idle_liquidity(&env);
            if idle <= 0 {
                break;
            }

            let pay = if request.amount <= idle {
                request.amount
            } else {
                idle
            };

            Self::transfer_tokens(&env, &contract_addr, &request.who, &pay)?;

            let mut p = Self::load_participant(&env, &request.who)?;
            p.withdrawn_principal += pay;
            Self::save_participant(&env, &request.who, &p);

            request.amount -= pay;
            total_paid += pay;

            if request.amount == 0 {
                request.status = WithdrawalRequestStatus::Fulfilled;
                env.storage().instance().set(&key, &request);
                env.storage()
                    .instance()
                    .remove(&DataKey::ParticipantQueue(request.who.clone()));
                head = head.wrapping_add(1);
                iterated += 1;
                processed += 1;
            } else {
                // Partial payment — liquidity exhausted; stop without
                // skipping ahead to a later, smaller request (#529).
                env.storage().instance().set(&key, &request);
                break;
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::WithdrawalQueueHead, &head);
        Self::bump_instance(&env);

        if total_paid > 0 {
            env.events().publish(
                (symbol_short!("wq"), symbol_short!("fulfill")),
                (head, total_paid),
            );
        }
        Ok(total_paid)
    }

    /// Cancel the caller's own pending withdrawal request. The un-paid
    /// remaining amount was never counted as withdrawn, so the participant's
    /// claim is preserved and `withdraw` can be called again later (#529).
    pub fn cancel_withdrawal_request(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        Self::require_compatible_config(&env)?;

        let qid: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ParticipantQueue(who.clone()))
            .ok_or(Error::WithdrawalRequestNotFound)?;
        let key = DataKey::WithdrawalRequest(qid);
        let mut request: WithdrawalRequest = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(Error::WithdrawalRequestNotFound)?;

        if request.who != who {
            return Err(Error::WithdrawalRequestNotOwned);
        }
        if request.status != WithdrawalRequestStatus::Pending {
            return Err(Error::WithdrawalRequestNotPending);
        }

        let remaining = request.amount;
        request.status = WithdrawalRequestStatus::Cancelled;
        env.storage().instance().set(&key, &request);
        env.storage()
            .instance()
            .remove(&DataKey::ParticipantQueue(who));
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("wq"), symbol_short!("cancel")),
            (qid, remaining),
        );
        Ok(remaining)
    }

    /// View a withdrawal request by id (#529).
    pub fn withdrawal_request(env: Env, request_id: u32) -> Result<WithdrawalRequest, Error> {
        env.storage()
            .instance()
            .get(&DataKey::WithdrawalRequest(request_id))
            .ok_or(Error::WithdrawalRequestNotFound)
    }

    /// View the caller's active queued request id, if any (#529).
    pub fn withdrawal_request_of(env: Env, who: Address) -> Option<u32> {
        env.storage()
            .instance()
            .get(&DataKey::ParticipantQueue(who))
    }

    pub fn withdrawal_queue_head(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::WithdrawalQueueHead)
            .unwrap_or(0)
    }

    pub fn withdrawal_queue_tail(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::WithdrawalQueueTail)
            .unwrap_or(0)
    }

    // ── Yield management (#382) ────────────────────────────────────────────

    /// Admin deposits realized yield into the distributable pool.
    pub fn add_yield(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
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
        Self::require_compatible_config(&env)?;
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
        Self::require_compatible_config(&env)?;
        strategy_adapter::set_strategy(&env, &caller, &strategy)
    }

    /// Governed: propose a new strategy candidate for rotation (#532).
    pub fn propose_strategy(
        env: Env,
        caller: Address,
        strategy: Address,
        exposure_cap: i128,
    ) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::propose_strategy(&env, &caller, &strategy, exposure_cap)
    }

    /// Governed: validate the proposed strategy (#532).
    pub fn validate_strategy(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::validate_strategy(&env, &caller)
    }

    /// Governed: drain principal from active strategy during rotation (#532).
    pub fn drain_strategy(env: Env, caller: Address, amount: i128) -> Result<i128, Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::drain_strategy(&env, &caller, amount)
    }

    /// Governed: reconcile active strategy principal to 0 during rotation (#532).
    pub fn reconcile_strategy(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::reconcile_strategy(&env, &caller)
    }

    /// Governed: activate proposed strategy after full reconciliation (#532).
    pub fn activate_strategy(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::activate_strategy(&env, &caller)
    }

    /// Governed: cancel pending strategy rotation (#532).
    pub fn cancel_strategy_rotation(env: Env, caller: Address) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::cancel_strategy_rotation(&env, &caller)
    }

    /// Governed: deploy idle principal into the configured strategy.
    pub fn deploy_to_strategy(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::deploy_to_strategy(&env, &caller, amount)
    }

    /// Governed: recall up to `amount` of principal from the strategy.
    /// Returns the amount actually recalled (may be partial).
    pub fn recall_from_strategy(env: Env, caller: Address, amount: i128) -> Result<i128, Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::recall_from_strategy(&env, &caller, amount)
    }

    /// Governed: reconcile the strategy's real balance, crediting realized
    /// yield to `distributable_yield` and absorbing realized loss against
    /// `principal_in_strategy`. Returns (realized_yield, realized_loss).
    pub fn harvest_strategy(env: Env, caller: Address) -> Result<(i128, i128), Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::harvest_strategy(&env, &caller)
    }

    /// Governed: force-recall the strategy's entire balance regardless of
    /// cached bookkeeping. For use when a strategy is misbehaving.
    pub fn emergency_recall_strategy(env: Env, caller: Address) -> Result<i128, Error> {
        Self::require_compatible_config(&env)?;
        strategy_adapter::emergency_recall_strategy(&env, &caller)
    }

    // ── TTL maintenance (#385) ─────────────────────────────────────────────

    /// Extend TTL for a participant's persistent storage entry.
    pub fn renew_participant(env: Env, who: Address) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        if !Self::has_participant(&env, &who) {
            return Err(Error::NotJoined);
        }
        Self::bump_participant(&env, &DataKey::Participant(who));
        Self::bump_instance(&env);
        Ok(())
    }

    /// Extend TTL for all instance storage (pool state, admins, proposals).
    pub fn renew_instance(env: Env) -> Result<(), Error> {
        Self::require_compatible_config(&env)?;
        if !env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::NotInitialized);
        }
        Self::bump_instance(&env);
        Ok(())
    }

    /// Permissionless bounded TTL maintenance. Each item costs one renewal
    /// unit; callers must provide a per-call cap so a griefing transaction
    /// cannot force unbounded storage work (#606).
    pub fn renew_storage(
        env: Env,
        participants: Vec<Address>,
        round_ids: Vec<u32>,
        max_items: u32,
    ) -> Result<RenewalReport, Error> {
        Self::require_compatible_config(&env)?;
        if !env.storage().instance().has(&DataKey::Pool) {
            return Err(Error::NotInitialized);
        }

        let requested = participants.len() + round_ids.len();
        if requested > max_items || max_items > MAX_RENEWAL_ITEMS {
            return Err(Error::RenewalLimitExceeded);
        }

        let mut renewed: u32 = 0;
        let mut skipped: u32 = 0;
        let mut blocking_key = BlockingKey::Unblocked;

        for i in 0..participants.len() {
            let who = participants.get(i).unwrap();
            let key = DataKey::Participant(who.clone());
            if env.storage().persistent().has(&key) {
                Self::bump_participant(&env, &key);
                renewed += 1;
            } else {
                skipped += 1;
                if matches!(blocking_key, BlockingKey::Unblocked) {
                    blocking_key = BlockingKey::Participant(who);
                }
            }
        }

        for i in 0..round_ids.len() {
            let round_id = round_ids.get(i).unwrap();
            let key = DataKey::Round(round_id);
            if env.storage().persistent().has(&key) {
                Self::bump_round(&env, &key);
                renewed += 1;
            } else {
                skipped += 1;
                if matches!(blocking_key, BlockingKey::Unblocked) {
                    blocking_key = BlockingKey::Round(round_id);
                }
            }
        }

        Self::bump_instance(&env);
        Ok(RenewalReport {
            requested,
            renewed,
            skipped,
            required_budget: requested,
            blocking_key,
        })
    }

    // ── Draw winner ────────────────────────────────────────────────────────
    /// Pays `prize` to `round_id`'s already-resolved winner (#715). The
    /// winner must have been derived via the manipulation-resistant
    /// commit-reveal process — `commit_round_randomness`,
    /// `reveal_round_randomness` (or `finalize_round_randomness_fallback`),
    /// then `select_round_winner` — never a hardcoded or admin-chosen
    /// address.
    pub fn draw_winner(
        env: Env,
        caller: Address,
        round_id: u32,
        prize: i128,
    ) -> Result<Address, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
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

        let winner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::RoundWinner(round_id))
            .ok_or(Error::RoundWinnerNotSelected)?;

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
            (winner.clone(), round_id, prize),
        );
        Ok(winner)
    }

    // ── Draw auditability: commit/reveal + snapshot commitment (#718) ────
    //
    // The legacy `draw_winner` above credits a prize but provides no
    // verifiable link between the winner and the documented selection
    // algorithm. These additive entrypoints close that gap for round-scoped
    // draws without touching any existing path:
    //
    // 1. `round_commit_draw` (signer, at/after `lock_round`): publishes and
    //    stores the seed commitment plus the Merkle root over the frozen
    //    participant snapshot. From here the seed is pinned — the admin has
    //    committed to exactly one seed value via a hash, exactly like the
    //    two-phase lock/reveal documented in
    //    VAULTQUEST_ARCHITECTURE_DESIGN.md.
    // 2. `round_draw` (signer, after `settle_round`): reveals the seed and
    //    the winner's Merkle proof. The contract verifies the reveal against
    //    the commitment, recomputes `winner_index` from
    //    `randomness = H(seed || round_id || drawn_at_ledger)` with the
    //    documented `randomness % eligible_participant_count` formula, checks
    //    the supplied proof against the committed snapshot root, and emits a
    //    single self-contained `round drawn` event.
    // 3. The standalone verifier (`tools/draw-verifier`) rebuilds the winner
    //    from chain data alone (events + contract storage) and fails loudly
    //    on any mismatch.
    //
    // The legacy `draw_winner` path is intentionally left untouched so
    // existing integrations keep their exact behavior; round-scoped draws
    // use `round_draw` instead.

    /// Signer-only: commit the draw inputs for a `Locked` round. Publishes
    /// `round committed` with `(round_id, seed_hash, snapshot_root,
    /// leaf_count)` and stores the commitment. The seed itself is NEVER
    /// stored on-chain; it exists only in the committer's head until
    /// `round_draw` reveals it, so the draw outcome is fixed before any
    /// settlement yield is known but the seed stays hidden until reveal.
    pub fn round_commit_draw(
        env: Env,
        caller: Address,
        round_id: u32,
        seed_hash: BytesN<32>,
        snapshot_root: BytesN<32>,
        leaf_count: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
        if leaf_count == 0 {
            return Err(Error::InvalidAmount);
        }

        let round = Self::load_round(&env, round_id)?;
        if round.status != RoundStatus::Locked {
            return Err(Error::RoundDrawNotLocked);
        }
        if round.principal_snapshot <= 0 {
            return Err(Error::InvalidAmount);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::RoundDrawCommit(round_id))
        {
            return Err(Error::RoundDrawAlreadyCommitted);
        }

        // Bind the caller's raw Merkle root (over address-sorted leaf
        // hashes) to this round and ticket count. The enveloped root is
        // what gets stored AND published, so event and storage always
        // agree and evidence can never be replayed across rounds.
        let snapshot_root =
            draw_audit::envelope_snapshot_root(&env, round_id, leaf_count, &snapshot_root);
        let commit = RoundDrawCommit {
            seed_hash: seed_hash.clone(),
            snapshot_root: snapshot_root.clone(),
            leaf_count,
            committed_at_ledger: env.ledger().sequence(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::RoundDrawCommit(round_id), &commit);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("committed")),
            (round_id, seed_hash, snapshot_root, leaf_count),
        );
        Ok(())
    }

    /// Signer-only: reveal the committed seed and execute the draw for a
    /// `Settled` round. Verifies (1) the revealed seed hashes to the
    /// lock-time commitment, (2) the winner's Merkle proof verifies against
    /// the committed snapshot root, and (3) the winner index equals the
    /// documented `randomness % eligible_participant_count` recomputation —
    /// then credits the prize through the same participant-prize bookkeeping
    /// the legacy `draw_winner` uses and emits the self-contained
    /// `round drawn` audit event.
    ///
    /// `evidence` carries everything the caller must prove: the revealed
    /// seed, the winner address, a witness of the winner's frozen round
    /// deposit (cross-checked against `RoundDeposit` storage), and the
    /// winner's Merkle proof path. The winner is never taken on faith — the
    /// index is recomputed from the revealed seed and the proof must place
    /// that address's leaf at the recomputed index under the committed
    /// snapshot root.
    pub fn round_draw(
        env: Env,
        caller: Address,
        round_id: u32,
        evidence: DrawEvidence,
        prize: i128,
    ) -> Result<Address, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
        if prize <= 0 {
            return Err(Error::InvalidAmount);
        }

        let round = Self::load_round(&env, round_id)?;
        if round.status != RoundStatus::Settled {
            return Err(Error::RoundDrawNotSettled);
        }
        let pool: Pool = env
            .storage()
            .instance()
            .get(&DataKey::Pool)
            .ok_or(Error::NotInitialized)?;
        if pool.is_emergency {
            return Err(Error::InEmergency);
        }
        let commit: RoundDrawCommit = env
            .storage()
            .persistent()
            .get(&DataKey::RoundDrawCommit(round_id))
            .ok_or(Error::RoundDrawNotLocked)?;

        // The deposit witness must match the frozen on-chain deposit; a
        // lying witness changes the leaf hash and the proof check below
        // fails, but the explicit check makes the failure mode obvious.
        let deposit: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::RoundDeposit(evidence.winner.clone(), round_id))
            .unwrap_or(0);
        if deposit <= 0 || deposit != evidence.deposit {
            return Err(Error::RoundDrawWinnerNotInSnapshot);
        }

        // (1) seed reveal matches the lock-time commitment.
        if draw_audit::seed_hash(&env, round_id, &evidence.seed) != commit.seed_hash {
            return Err(Error::RoundDrawSeedMismatch);
        }

        // (2) winner index is exactly the documented recomputation from the
        // revealed seed — the caller cannot choose the index.
        let drawn_at_ledger = env.ledger().sequence();
        let randomness =
            draw_audit::draw_randomness(&env, round_id, &evidence.seed, drawn_at_ledger);
        let winner_index = draw_audit::winner_index_from_randomness(&randomness, commit.leaf_count);

        // (3) the Merkle proof must place this address's leaf under the
        // committed snapshot root: recompute the raw root from the proof,
        // then apply the same round/leaf-count envelope the commit stored.
        let leaf = draw_audit::leaf_hash(&env, round_id, &evidence.winner, &evidence.deposit);
        let proof_root = draw_audit::compute_merkle_root(&env, &leaf, &evidence.proof);
        if draw_audit::envelope_snapshot_root(&env, round_id, commit.leaf_count, &proof_root)
            != commit.snapshot_root
        {
            return Err(Error::RoundDrawWinnerNotInSnapshot);
        }

        let result = RoundDrawResult {
            seed: evidence.seed.clone(),
            winner_index,
            winner: evidence.winner.clone(),
            drawn_at_ledger,
        };
        env.storage()
            .persistent()
            .set(&DataKey::RoundDrawResult(round_id), &result);

        // Credit the prize through the same bookkeeping path the legacy
        // `draw_winner` uses (#377): auto-join the winner if needed, then
        // add to their participant prize balance.
        if !Self::has_participant(&env, &result.winner) {
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
            Self::save_participant(&env, &result.winner, &p);
        }
        let mut p = Self::load_participant(&env, &result.winner)?;
        p.prize = p.prize.saturating_add(prize);
        Self::save_participant(&env, &result.winner, &p);

        // Legacy-compatible payout event for the existing indexer.
        env.events().publish(
            (symbol_short!("pool"), symbol_short!("payout")),
            (result.winner.clone(), prize),
        );

        // Self-contained audit event (#718): seed commitment, revealed
        // seed, snapshot root, leaf count, derived randomness, winner index
        // and winner — enough to recompute the winner from chain data alone.
        env.events().publish(
            (symbol_short!("round"), symbol_short!("drawn")),
            draw_audit::draw_event_fields(&env, round_id, &commit, &result),
        );

        Ok(result.winner)
    }

    /// View: the stored draw commitment for a round (#718), if any.
    pub fn round_draw_commit(env: Env, round_id: u32) -> Option<RoundDrawCommit> {
        env.storage()
            .persistent()
            .get(&DataKey::RoundDrawCommit(round_id))
    }

    /// View: the stored draw result for a round (#718), if any.
    pub fn round_draw_result(env: Env, round_id: u32) -> Option<RoundDrawResult> {
        env.storage()
            .persistent()
            .get(&DataKey::RoundDrawResult(round_id))
    }

    // ── Emergency Pro-rata Exit (#512) ────────────────────────────────────
    pub fn emergency_withdraw(env: Env, who: Address) -> Result<i128, Error> {
        who.require_auth();
        Self::require_compatible_config(&env)?;

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

    // ── Round-scoped accounting (#508) ──────────────────────────────────────
    //
    // A parallel, additive accounting layer: it does not read or mutate
    // `Pool`/`Participant` at all, so it cannot regress the existing
    // single-pool deposit/claim/withdraw flows. Each round is independent
    // storage (`DataKey::Round(id)`), and a participant's contribution to a
    // given round is tracked separately (`DataKey::RoundDeposit(who, id)`)
    // from their lifetime `Participant.deposited` total.
    //
    // Lifecycle: Open -> Locked -> Settled.
    //   - `open_round`: admin-only, creates a new Open round.
    //   - `round_deposit`: any caller, only while the round is Open. Adds to
    //     the caller's per-round deposit and to the round's live total; the
    //     live total becomes `principal_snapshot` at lock time.
    //   - `lock_round`: admin-only, freezes `principal_snapshot` and flips to
    //     Locked. `round_deposit` is rejected for this round from this point
    //     on — a late deposit can never dilute an already-locked snapshot.
    //   - `settle_round`: admin-only (multi-sig signer), sets
    //     `realized_yield`/`prize_reserve` exactly once and flips to Settled.
    //     Rejected if the round isn't Locked or is already Settled, so yield
    //     can never be attributed twice or leak into a later round.
    //   - `round_claim`: pays a participant their pro-rata share of
    //     `realized_yield + prize_reserve` for one Settled round, based on
    //     their frozen per-round deposit versus `principal_snapshot`. Uses
    //     integer division; any dust remainder stays unclaimed in the round
    //     (never over-distributed) and is inspectable via `round.claimed`
    //     vs `round.realized_yield + round.prize_reserve`.

    /// Admin-only: open a new round. Returns the new round's id.
    pub fn open_round(env: Env, caller: Address) -> Result<u32, Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::RoundNonce)
            .unwrap_or(0);

        let round = Round {
            id,
            status: RoundStatus::Open,
            opened_at: env.ledger().timestamp(),
            locked_at: None,
            settled_at: None,
            principal_snapshot: 0,
            realized_yield: 0,
            prize_reserve: 0,
            claimed: 0,
        };
        env.storage().persistent().set(&DataKey::Round(id), &round);
        Self::bump_round(&env, &DataKey::Round(id));
        env.storage()
            .instance()
            .set(&DataKey::RoundNonce, &(id + 1));
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("round"), symbol_short!("opened")), id);
        Ok(id)
    }

    /// Deposit principal into a specific round. Only accepted while that
    /// round is `Open`; a round that is `Locked` or `Settled` rejects the
    /// deposit rather than silently misattributing it (#508). This does not
    /// move tokens or touch `Pool`/`Participant` — it is purely the
    /// round-scoped accounting ledger.
    pub fn round_deposit(env: Env, who: Address, round_id: u32, amount: i128) -> Result<(), Error> {
        who.require_auth();
        Self::require_compatible_config(&env)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut round = Self::load_round(&env, round_id)?;
        if round.status != RoundStatus::Open {
            return Err(Error::RoundNotOpen);
        }

        // Time-weighted ticket allocation (#719): a deposit's exposure to
        // this round's draw is prorated by how much of the round's
        // ticket-weighting window remains at deposit time — full weight at
        // `opened_at`, decaying linearly to `ROUND_MIN_TICKET_WEIGHT_BPS` by
        // `opened_at + ROUND_TICKET_WEIGHT_WINDOW_SECONDS`. This discourages
        // just-in-time sniping (a deposit made moments before close earns
        // only the floor weight) without rejecting genuine mid-round
        // deposits (they still earn a meaningful, smoothly-declining share)
        // and without touching withdrawability — it only affects how many
        // tickets/how much pro-rata share a deposit earns for *this round's*
        // `round_claim` and `select_round_winner`, never principal custody.
        let now = env.ledger().timestamp();
        let elapsed = now.saturating_sub(round.opened_at);
        let weight_bps: u32 = if elapsed >= ROUND_TICKET_WEIGHT_WINDOW_SECONDS {
            ROUND_MIN_TICKET_WEIGHT_BPS
        } else {
            let remaining = ROUND_TICKET_WEIGHT_WINDOW_SECONDS - elapsed;
            let bps = (remaining as u128 * BPS_DENOMINATOR as u128)
                / (ROUND_TICKET_WEIGHT_WINDOW_SECONDS as u128);
            core::cmp::max(bps as u32, ROUND_MIN_TICKET_WEIGHT_BPS)
        };
        let weighted: i128 =
            amount.saturating_mul(weight_bps as i128) / (BPS_DENOMINATOR as i128);

        let key = DataKey::RoundDeposit(who.clone(), round_id);
        let existing: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let updated = existing.saturating_add(weighted);
        env.storage().persistent().set(&key, &updated);
        Self::bump_round(&env, &key);

        // Assign a canonical, submitter-proof ordering position the first
        // time this address deposits into this round's ticket pool (#715).
        // `select_round_winner` later requires candidates to be processed in
        // this exact order, so no one can bias who "contains" the fixed
        // winning ticket by choosing candidate submission order — an
        // address's own position is fixed here, at deposit time, not chosen
        // by whoever later calls select_round_winner.
        let seq_key = DataKey::RoundParticipantSeq(who.clone(), round_id);
        if !env.storage().persistent().has(&seq_key) {
            let nonce_key = DataKey::RoundParticipantSeqNonce(round_id);
            let next_seq: u32 = env.storage().persistent().get(&nonce_key).unwrap_or(0);
            env.storage().persistent().set(&seq_key, &next_seq);
            Self::bump_round(&env, &seq_key);
            env.storage()
                .persistent()
                .set(&nonce_key, &(next_seq + 1));
            Self::bump_round(&env, &nonce_key);
        }

        round.principal_snapshot = round.principal_snapshot.saturating_add(weighted);
        Self::save_round(&env, &round);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("deposit")),
            (who.clone(), round_id, amount),
        );
        env.events().publish(
            (symbol_short!("round"), symbol_short!("tickets")),
            (who, round_id, weighted, weight_bps),
        );
        Ok(())
    }

    /// Admin-only: freeze a round's `principal_snapshot` and move it to
    /// `Locked`. After this call, `round_deposit` for this round always
    /// fails — this is the boundary that stops a late deposit from being
    /// counted in a round that has already closed for deposits (#508).
    pub fn lock_round(env: Env, caller: Address, round_id: u32) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;

        let mut round = Self::load_round(&env, round_id)?;
        if round.status != RoundStatus::Open {
            return Err(Error::RoundNotOpen);
        }
        round.status = RoundStatus::Locked;
        round.locked_at = Some(env.ledger().timestamp());
        Self::save_round(&env, &round);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("locked")),
            (round_id, round.principal_snapshot),
        );
        Ok(())
    }

    /// Admin-only (multi-sig signer): fix `realized_yield`/`prize_reserve`
    /// for a `Locked` round exactly once and move it to `Settled`. Rejects a
    /// round that isn't `Locked` yet, and rejects a round that is already
    /// `Settled` (idempotent no-op guard) — so yield can never be attributed
    /// twice to the same round, and settling round N can never reach into
    /// round N+1's state, because each round's storage is fully independent
    /// (#508).
    pub fn settle_round(
        env: Env,
        caller: Address,
        round_id: u32,
        realized_yield: i128,
        prize_reserve: i128,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;
        if realized_yield < 0 || prize_reserve < 0 {
            return Err(Error::InvalidAmount);
        }

        let mut round = Self::load_round(&env, round_id)?;
        match round.status {
            RoundStatus::Settled => return Err(Error::RoundAlreadySettled),
            RoundStatus::Open => return Err(Error::RoundNotLocked),
            RoundStatus::Locked => {}
        }

        round.realized_yield = realized_yield;
        round.prize_reserve = prize_reserve;
        round.status = RoundStatus::Settled;
        round.settled_at = Some(env.ledger().timestamp());
        Self::save_round(&env, &round);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("settled")),
            (round_id, realized_yield, prize_reserve),
        );
        Ok(())
    }

    /// Permissionless liveness fallback: after a locked round has remained
    /// unsettled past the objective deadline, any account may finalize it
    /// with zero realized yield/prize. The caller cannot choose a winner or
    /// payout, and duplicate calls hit the same settled-state guard (#604).
    pub fn finalize_round(env: Env, caller: Address, round_id: u32) -> Result<(), Error> {
        caller.require_auth();
        Self::require_compatible_config(&env)?;

        let mut round = Self::load_round(&env, round_id)?;
        match round.status {
            RoundStatus::Settled => return Err(Error::RoundAlreadySettled),
            RoundStatus::Open => return Err(Error::RoundNotLocked),
            RoundStatus::Locked => {}
        }

        let locked_at = round.locked_at.ok_or(Error::RoundNotLocked)?;
        if env.ledger().timestamp() < locked_at + ROUND_PERMISSIONLESS_FINALIZE_DELAY_SECONDS {
            return Err(Error::RoundFinalizationTooEarly);
        }

        round.realized_yield = 0;
        round.prize_reserve = 0;
        round.status = RoundStatus::Settled;
        round.settled_at = Some(env.ledger().timestamp());
        Self::save_round(&env, &round);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("finalize")),
            (caller, round_id),
        );
        Ok(())
    }

    /// Claim a participant's pro-rata share of a Settled round's
    /// `realized_yield + prize_reserve`, proportional to their frozen
    /// per-round deposit vs. `principal_snapshot`. Enforces
    /// `round.claimed <= round.realized_yield + round.prize_reserve` inline
    /// rather than trusting the division, returning
    /// `Error::RoundAccountingViolation` if a claim would ever push the
    /// round over its settled total (#508).
    pub fn round_claim(env: Env, who: Address, round_id: u32) -> Result<i128, Error> {
        who.require_auth();
        Self::require_compatible_config(&env)?;

        let mut round = Self::load_round(&env, round_id)?;
        if round.status != RoundStatus::Settled {
            return Err(Error::RoundNotLocked);
        }
        if round.principal_snapshot <= 0 {
            return Ok(0);
        }

        let key = DataKey::RoundDeposit(who.clone(), round_id);
        let deposit: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        if deposit <= 0 {
            return Ok(0);
        }

        let total_pool = round.realized_yield.saturating_add(round.prize_reserve);
        // Integer division: any dust remainder is left unclaimed in the
        // round rather than distributed, so total payouts can never exceed
        // `total_pool` (checked explicitly below regardless).
        let share = (total_pool.saturating_mul(deposit)) / round.principal_snapshot;

        let new_claimed = round.claimed.saturating_add(share);
        if new_claimed > total_pool {
            return Err(Error::RoundAccountingViolation);
        }

        round.claimed = new_claimed;
        Self::save_round(&env, &round);

        // Zero out this participant's per-round deposit so a second call
        // for the same round pays nothing (idempotent claim).
        env.storage().persistent().set(&key, &0i128);
        Self::bump_round(&env, &key);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("claimed")),
            (who, round_id, share),
        );
        Ok(share)
    }

    // ── Manipulation-resistant round-winner randomness (#715) ──────────────
    //
    // Soroban has no native VRF and no way for a contract to read another
    // ledger's hash, so a single-party "commit a hash, reveal a seed" scheme
    // is not enough on its own: whoever commits could grind through
    // candidate seeds against the already-known participant set before
    // publishing only the one that favors them. Instead this uses an
    // N-of-N *approved-signer* commit-reveal: every signer who wants to
    // contribute entropy commits `sha256(their own secret seed)` while the
    // round is still `Open` (§commit_round_randomness). Once the round is
    // `Locked` (principal_snapshot frozen — no further deposit can react to
    // anything revealed after this point), each committer reveals their
    // seed (§reveal_round_randomness); the contract checks it against their
    // commitment, so a committer can only ever publish the one seed they
    // already committed to, or withhold it entirely — they get no other
    // choice, hence no way to grind. Once *every* committer for a round has
    // revealed, the seeds are combined via `sha256(seed_1 || … || seed_n ||
    // round_id)` into a `winning_ticket` in `[0, principal_snapshot)`. This
    // is secure — unbiasable by any single party, including the contract's
    // own admin — as long as at least one committer keeps their seed secret
    // until reveal, the same threshold-honesty assumption this contract
    // already makes for multisig governance.
    //
    // Liveness: if any committer never reveals, `reveal_round_randomness`
    // can never reach "everyone revealed", so
    // `finalize_round_randomness_fallback` lets anyone resolve the round
    // `ROUND_REVEAL_WINDOW_SECONDS` after it locked using the host PRNG
    // alone — no committed seed contributes to this path at all. A
    // withholder therefore can never force a favorable *subset*
    // recombination (which would reintroduce a last-revealer bias): their
    // only real choice is "reveal the committed seed" or "the round falls
    // back to PRNG, and my seed counted for nothing either way."
    //
    // Verifiability: every commitment, every revealed seed, the round's
    // frozen `principal_snapshot`, and each depositor's `round_deposit`
    // amount are all public on-chain state/events. Anyone can independently
    // recompute `winning_ticket` from the revealed seeds (or confirm the
    // fallback was legitimately reached, i.e. the reveal window elapsed
    // with a committer unrevealed) and re-derive the winner by replaying
    // `select_round_winner`'s canonical-order walk over `round.deposit`
    // events — no private/off-chain state is ever load-bearing.

    /// An approved signer commits `sha256(seed)` for a round's randomness
    /// draw. Only accepted while the round is `Open` — before `lock_round`
    /// freezes `principal_snapshot` — so a commitment can never be chosen in
    /// reaction to a finalized participant set. Each signer may commit at
    /// most once per round.
    pub fn commit_round_randomness(
        env: Env,
        signer: Address,
        round_id: u32,
        commitment: BytesN<32>,
    ) -> Result<(), Error> {
        signer.require_auth();
        Self::require_signer(&env, &signer)?;
        Self::require_compatible_config(&env)?;

        let round = Self::load_round(&env, round_id)?;
        if round.status != RoundStatus::Open {
            return Err(Error::RoundNotOpen);
        }

        let commit_key = DataKey::RoundCommitment(signer.clone(), round_id);
        if env.storage().persistent().has(&commit_key) {
            return Err(Error::RandomnessAlreadyCommitted);
        }
        env.storage().persistent().set(&commit_key, &commitment);
        Self::bump_round(&env, &commit_key);

        let committers_key = DataKey::RoundCommitters(round_id);
        let mut committers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&committers_key)
            .unwrap_or(Vec::new(&env));
        committers.push_back(signer.clone());
        env.storage().persistent().set(&committers_key, &committers);
        Self::bump_round(&env, &committers_key);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("rcommit")),
            (round_id, signer),
        );
        Ok(())
    }

    /// A committer reveals the seed matching their earlier commitment. Only
    /// accepted once the round is `Locked`. Once every signer who committed
    /// for this round has revealed, the round's randomness is finalized
    /// immediately using the combined-seed formula (#715).
    pub fn reveal_round_randomness(
        env: Env,
        signer: Address,
        round_id: u32,
        seed: BytesN<32>,
    ) -> Result<(), Error> {
        signer.require_auth();
        Self::require_compatible_config(&env)?;

        let round = Self::load_round(&env, round_id)?;
        if round.status == RoundStatus::Open {
            return Err(Error::RoundNotLocked);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::RoundRandomness(round_id))
        {
            return Err(Error::RandomnessAlreadyResolved);
        }

        let commit_key = DataKey::RoundCommitment(signer.clone(), round_id);
        let commitment: BytesN<32> = env
            .storage()
            .persistent()
            .get(&commit_key)
            .ok_or(Error::RandomnessNotCommitted)?;

        let reveal_key = DataKey::RoundRevealedSeed(signer.clone(), round_id);
        if env.storage().persistent().has(&reveal_key) {
            return Err(Error::RandomnessSeedAlreadyRevealed);
        }

        let recomputed: BytesN<32> = env.crypto().sha256(&seed.to_bytes()).to_bytes();
        if recomputed != commitment {
            return Err(Error::RandomnessCommitmentMismatch);
        }

        env.storage().persistent().set(&reveal_key, &seed);
        Self::bump_round(&env, &reveal_key);

        env.events().publish(
            (symbol_short!("round"), symbol_short!("rreveal")),
            (round_id, signer),
        );

        let committers: Vec<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::RoundCommitters(round_id))
            .unwrap_or(Vec::new(&env));
        let mut all_revealed = committers.len() > 0;
        for c in committers.iter() {
            if !env
                .storage()
                .persistent()
                .has(&DataKey::RoundRevealedSeed(c.clone(), round_id))
            {
                all_revealed = false;
                break;
            }
        }

        if all_revealed {
            let mut data = Bytes::new(&env);
            for c in committers.iter() {
                let s: BytesN<32> = env
                    .storage()
                    .persistent()
                    .get(&DataKey::RoundRevealedSeed(c.clone(), round_id))
                    .ok_or(Error::RandomnessNotCommitted)?;
                data.extend_from_array(&s.to_array());
            }
            data.extend_from_array(&round_id.to_be_bytes());
            let digest: [u8; 32] = env.crypto().sha256(&data).to_array();
            Self::resolve_round_randomness(
                &env,
                round_id,
                &round,
                &digest,
                RandomnessSource::CommitReveal,
            )?;
        }
        Ok(())
    }

    /// Permissionless liveness fallback (#715): once
    /// `ROUND_REVEAL_WINDOW_SECONDS` has passed since a round locked without
    /// every committer revealing, anyone may resolve the round's randomness
    /// using the host PRNG alone. No committed seed contributes to this
    /// path, so a withheld reveal can never bias the outcome — it only
    /// forfeits the withholder's own influence.
    pub fn finalize_round_randomness_fallback(
        env: Env,
        caller: Address,
        round_id: u32,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_compatible_config(&env)?;

        let round = Self::load_round(&env, round_id)?;
        if round.status == RoundStatus::Open {
            return Err(Error::RoundNotLocked);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::RoundRandomness(round_id))
        {
            return Err(Error::RandomnessAlreadyResolved);
        }
        let locked_at = round.locked_at.ok_or(Error::RoundNotLocked)?;
        if env.ledger().timestamp() < locked_at + ROUND_REVEAL_WINDOW_SECONDS {
            return Err(Error::RevealWindowNotElapsed);
        }

        let beacon: [u8; 32] = env.prng().gen();
        Self::resolve_round_randomness(
            &env,
            round_id,
            &round,
            &beacon,
            RandomnessSource::PrngFallback,
        )?;

        env.events().publish(
            (symbol_short!("round"), symbol_short!("rfallbk")),
            (caller, round_id),
        );
        Ok(())
    }

    /// Reduces a 32-byte digest into `[0, round.principal_snapshot)` and
    /// stores it as the round's resolved randomness. Internal helper shared
    /// by the commit-reveal and PRNG-fallback paths (#715).
    fn resolve_round_randomness(
        env: &Env,
        round_id: u32,
        round: &Round,
        digest: &[u8; 32],
        source: RandomnessSource,
    ) -> Result<(), Error> {
        let ticket: i128 = if round.principal_snapshot <= 0 {
            0
        } else {
            let mut hi = [0u8; 16];
            hi.copy_from_slice(&digest[0..16]);
            let value = u128::from_be_bytes(hi);
            (value % (round.principal_snapshot as u128)) as i128
        };

        let info = RoundRandomness {
            winning_ticket: ticket,
            source,
            resolved_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::RoundRandomness(round_id), &info);
        Self::bump_round(env, &DataKey::RoundRandomness(round_id));

        env.events().publish(
            (symbol_short!("round"), symbol_short!("rticket")),
            (round_id, ticket),
        );
        Ok(())
    }

    /// Permissionless, bounded batch step (mirrors `renew_participant` /
    /// `prune_round`'s pattern) that maps a round's resolved
    /// `winning_ticket` to a specific depositor (#715). `candidates` is a
    /// caller-supplied batch of addresses, obtained off-chain from public
    /// `round.deposit` events; the contract processes them in the
    /// *canonical* order fixed at deposit time (`RoundParticipantSeq`,
    /// strictly increasing) rather than submission order, so no combination
    /// of candidate batches or ordering can change who ends up "containing"
    /// the fixed winning ticket. Safe to call repeatedly — by anyone, in any
    /// number of batches — until it returns `Some(winner)`; a call after the
    /// winner is already found just returns it again at no cost to
    /// correctness.
    pub fn select_round_winner(
        env: Env,
        caller: Address,
        round_id: u32,
        candidates: Vec<Address>,
    ) -> Result<Option<Address>, Error> {
        caller.require_auth();
        Self::require_compatible_config(&env)?;
        if candidates.len() > MAX_RENEWAL_ITEMS {
            return Err(Error::RenewalLimitExceeded);
        }

        let round = Self::load_round(&env, round_id)?;
        if round.status == RoundStatus::Open {
            return Err(Error::RoundNotLocked);
        }

        let existing_winner: Option<Address> = env
            .storage()
            .persistent()
            .get(&DataKey::RoundWinner(round_id));
        if let Some(existing) = existing_winner {
            return Ok(Some(existing));
        }

        let randomness: RoundRandomness = env
            .storage()
            .persistent()
            .get(&DataKey::RoundRandomness(round_id))
            .ok_or(Error::RandomnessNotResolved)?;

        let mut cursor: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::RoundSelectionCursor(round_id))
            .unwrap_or(0);
        let mut last_seq: Option<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::RoundSelectionSeq(round_id));

        let mut winner: Option<Address> = None;
        for who in candidates.iter() {
            let seq_key = DataKey::RoundParticipantSeq(who.clone(), round_id);
            let seq: u32 = env
                .storage()
                .persistent()
                .get(&seq_key)
                .ok_or(Error::NotRoundParticipant)?;
            if let Some(last) = last_seq {
                if seq <= last {
                    return Err(Error::CanonicalOrderViolation);
                }
            }
            last_seq = Some(seq);

            let deposit: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::RoundDeposit(who.clone(), round_id))
                .unwrap_or(0);
            if deposit > 0 {
                let segment_end = cursor.saturating_add(deposit);
                if randomness.winning_ticket >= cursor && randomness.winning_ticket < segment_end
                {
                    winner = Some(who.clone());
                }
                cursor = segment_end;
            }
            if winner.is_some() {
                break;
            }
        }

        env.storage()
            .persistent()
            .set(&DataKey::RoundSelectionCursor(round_id), &cursor);
        Self::bump_round(&env, &DataKey::RoundSelectionCursor(round_id));
        if let Some(s) = last_seq {
            env.storage()
                .persistent()
                .set(&DataKey::RoundSelectionSeq(round_id), &s);
            Self::bump_round(&env, &DataKey::RoundSelectionSeq(round_id));
        }

        if let Some(w) = winner.clone() {
            env.storage()
                .persistent()
                .set(&DataKey::RoundWinner(round_id), &w);
            Self::bump_round(&env, &DataKey::RoundWinner(round_id));
            env.events().publish(
                (symbol_short!("round"), symbol_short!("rwinner")),
                (round_id, w.clone()),
            );
        }

        Ok(winner)
    }

    /// View a round's resolved randomness, if any (#715).
    pub fn round_randomness(env: Env, round_id: u32) -> Option<RoundRandomness> {
        env.storage()
            .persistent()
            .get(&DataKey::RoundRandomness(round_id))
    }

    /// View the depositor selected as a round's winner, if resolved (#715).
    pub fn round_winner_of(env: Env, round_id: u32) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::RoundWinner(round_id))
    }

    /// Admin-only: prune `RoundDeposit` entries and the `Round` itself for
    /// a fully settled round whose participants have all claimed. Accepts a
    /// list of participant addresses whose deposits should be removed — each
    /// must have a zero `round_deposit_of` (already claimed). If all listed
    /// participants have claimed, the `Round` entry is also removed to
    /// reclaim persistent storage. Rejects pruning a round that still has
    /// outstanding unclaimed deposits (#558).
    pub fn prune_round(
        env: Env,
        caller: Address,
        round_id: u32,
        participants: Vec<Address>,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        Self::require_compatible_config(&env)?;

        let round = Self::load_round(&env, round_id)?;
        if round.status != RoundStatus::Settled {
            return Err(Error::RoundNotLocked);
        }

        for i in 0..participants.len() {
            let who = participants.get(i).unwrap();
            let deposit: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::RoundDeposit(who.clone(), round_id))
                .unwrap_or(0);
            if deposit > 0 {
                return Err(Error::RoundHasOutstandingDeposits);
            }
            env.storage()
                .persistent()
                .remove(&DataKey::RoundDeposit(who, round_id));
        }

        // Remove the round entry itself to reclaim storage.
        env.storage().persistent().remove(&DataKey::Round(round_id));
        Self::bump_instance(&env);

        env.events()
            .publish((symbol_short!("round"), symbol_short!("pruned")), round_id);
        Ok(())
    }

    fn load_round(env: &Env, round_id: u32) -> Result<Round, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Round(round_id))
            .ok_or(Error::RoundNotFound)
    }

    fn save_round(env: &Env, round: &Round) {
        let key = DataKey::Round(round.id);
        env.storage().persistent().set(&key, round);
        Self::bump_round(env, &key);
    }

    fn bump_round(env: &Env, key: &DataKey) {
        env.storage()
            .persistent()
            .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
    }

    // ── Token decimals (#599) ────────────────────────────────────────────────

    /// Configure the token's decimal precision. Must be called after
    /// `set_token` and before any deposits. Stored as u8 for compact
    /// on-chain representation; valid range 0–38 covers all Stellar
    /// assets. This value is used by the frontend and backend to
    /// convert between human-readable amounts and on-chain i128 units
    /// without lossy floating-point arithmetic (#599).
    pub fn set_token_decimals(env: Env, caller: Address, decimals: u32) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        if !Self::has_token_configured(&env) {
            return Err(Error::TokenNotConfigured);
        }
        if env.storage().instance().has(&DataKey::TokenDecimals) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage()
            .instance()
            .set(&DataKey::TokenDecimals, &decimals_to_val(decimals));
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("pool"), symbol_short!("decimals")),
            decimals_to_val(decimals),
        );
        Ok(())
    }

    /// View the configured token decimals (#599).
    /// Stored as u32 (soroban-sdk 27 removed u8 Val conversions); validated
    /// at the setter boundary to the 0–38 Stellar asset range.
    pub fn token_decimals(env: Env) -> Result<u32, Error> {
        env.storage()
            .instance()
            .get(&DataKey::TokenDecimals)
            .ok_or(Error::TokenDecimalsNotConfigured)
    }

    // ── Strategy code hash allowlist (#602) ────────────────────────────────

    /// Add a WASM hash to the strategy code hash allowlist. Only callable
    /// by an approved signer. Strategies deployed with code whose hash is
    /// not on this list cannot be proposed or activated (#602).
    pub fn allow_strategy_code_hash(
        env: Env,
        caller: Address,
        code_hash: BytesN<32>,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut hashes: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedStrategyCodeHashes)
            .unwrap_or(Vec::new(&env));
        if !hashes.contains(&code_hash) {
            hashes.push_back(code_hash.clone());
            env.storage()
                .instance()
                .set(&DataKey::AllowedStrategyCodeHashes, &hashes);
            Self::bump_instance(&env);

            env.events().publish(
                (symbol_short!("strat"), symbol_short!("hash_ok")),
                code_hash,
            );
        }
        Ok(())
    }

    /// Remove a WASM hash from the strategy code hash allowlist.
    pub fn disallow_strategy_code_hash(
        env: Env,
        caller: Address,
        code_hash: BytesN<32>,
    ) -> Result<(), Error> {
        caller.require_auth();
        Self::require_signer(&env, &caller)?;
        let mut hashes: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedStrategyCodeHashes)
            .unwrap_or(Vec::new(&env));
        let mut new_hashes: Vec<BytesN<32>> = Vec::new(&env);
        for h in hashes.iter() {
            if h != code_hash {
                new_hashes.push_back(h);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::AllowedStrategyCodeHashes, &new_hashes);
        Self::bump_instance(&env);
        Ok(())
    }

    /// View the strategy code hash allowlist (#602).
    pub fn allowed_strategy_code_hashes(env: Env) -> Vec<BytesN<32>> {
        env.storage()
            .instance()
            .get(&DataKey::AllowedStrategyCodeHashes)
            .unwrap_or(Vec::new(&env))
    }

    /// Check if a strategy's code hash is on the allowlist (#602).
    ///
    /// An allowlist that has never been configured accepts every hash
    /// (bootstrap mode): fresh deployments are not locked out of strategy
    /// setup, while allow/disallow manages the list from then on. Once at
    /// least one hash has been allowed, membership is required.
    pub fn is_strategy_code_hash_allowed(env: Env, code_hash: BytesN<32>) -> bool {
        let hashes: Vec<BytesN<32>> = env
            .storage()
            .instance()
            .get(&DataKey::AllowedStrategyCodeHashes)
            .unwrap_or(Vec::new(&env));
        hashes.is_empty() || hashes.contains(&code_hash)
    }

    // ── Views ──────────────────────────────────────────────────────────────
    pub fn config_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::ConfigVersion)
            .unwrap_or(1)
    }

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

    /// View the current governance epoch. Bumped on every Admins/Threshold
    /// change; proposals snapshotted under an earlier epoch cannot execute
    /// (#533).
    pub fn governance_epoch(env: Env) -> u32 {
        Self::get_epoch(&env)
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

    /// View a round's full state (#508).
    pub fn round(env: Env, round_id: u32) -> Result<Round, Error> {
        Self::load_round(&env, round_id)
    }

    /// View a participant's frozen deposit for a specific round (#508).
    /// Zero both before any `round_deposit` and after a successful
    /// `round_claim` for that round.
    pub fn round_deposit_of(env: Env, who: Address, round_id: u32) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::RoundDeposit(who, round_id))
            .unwrap_or(0)
    }

    /// The next round id that `open_round` will assign (#508).
    pub fn round_nonce(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RoundNonce)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;

#[cfg(test)]
mod benchmarks;
