//! Governed yield-strategy interface (#496).
//!
//! Any contract that wants to receive deployed pool principal implements
//! `YieldStrategy`. Consumers (e.g. `drip-pool`) MUST check
//! `interface_version()` against `STRATEGY_INTERFACE_VERSION` before trusting
//! a strategy address — this is the capability/version check the scope calls
//! for, and it is what lets a governed admin action reject an incompatible or
//! malicious strategy before ever moving funds into it.
//!
//! Accounting contract for implementers:
//! - `deposit`/`redeem` move real SAC tokens; they must never fabricate
//!   balances that don't correspond to an actual token transfer.
//! - `harvest` reconciles tracked principal against the strategy's *actual*
//!   on-chain token balance and reports the realized delta as yield (balance
//!   grew) or loss (balance shrank) — it must never report yield that isn't
//!   backed by a real balance increase.
//! - `total_assets` must equal `TokenClient::balance(&strategy_address)` for
//!   the given asset; callers use it to reconcile after every operation.

use soroban_sdk::{contractclient, contracttype, Address, Env};

use crate::ContractError;

/// Bump this when the interface shape changes in a way old strategies can't
/// safely serve. Consumers reject any strategy that doesn't report a match.
pub const STRATEGY_INTERFACE_VERSION: u32 = 1;

/// Result of a `harvest` call. Exactly one of `realized_yield` / `realized_loss`
/// is non-zero (both zero means "no change since last harvest").
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyReport {
    pub realized_yield: i128,
    pub realized_loss: i128,
    /// Strategy's real token balance at the time of this report, for the
    /// caller to reconcile against its own bookkeeping.
    pub total_assets: i128,
}

#[contractclient(name = "YieldStrategyClient")]
pub trait YieldStrategy {
    /// Capability/version check — callers must reject anything but the
    /// version they were built against before deploying funds.
    fn interface_version(env: Env) -> u32;

    /// Pull `amount` of `asset` from `from` into the strategy's custody.
    /// `from` must authorize the call.
    fn deposit(env: Env, from: Address, asset: Address, amount: i128) -> Result<(), ContractError>;

    /// Send up to `amount` of `asset` to `to` from the strategy's custody.
    /// Returns the amount actually redeemed, which may be less than
    /// requested (partial redeem / slippage / prior loss) — callers must use
    /// the return value, never assume the full amount moved.
    fn redeem(env: Env, to: Address, asset: Address, amount: i128) -> Result<i128, ContractError>;

    /// Realize any accrued gain or loss since the last harvest by comparing
    /// tracked principal to the strategy's actual token balance.
    fn harvest(env: Env, asset: Address) -> Result<StrategyReport, ContractError>;

    /// Strategy's current real token balance for `asset`.
    fn total_assets(env: Env, asset: Address) -> i128;
}
