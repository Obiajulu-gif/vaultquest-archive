//! Standardized VaultQuest contract error codes.
//!
//! All Soroban contracts in this workspace share a single `ContractError` enum
//! so clients can decode failures consistently across drip-pool, vault, and
//! proxy deployments.
//!
//! ## Code ranges
//! | Range | Category |
//! |-------|----------|
//! | 1–10  | Common (initialization, auth, amounts) |
//! | 11–20 | Drip-pool (participants, lockup, reentrancy) |
//! | 21–30 | Multi-sig governance |
//! | 31–40 | Vault pause / circuit breaker |
//! | 41–50 | Proxy upgrade |

use soroban_sdk::contracterror;

/// Unified contract error enum for all VaultQuest Soroban contracts.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    // ── Common (1–10) ──────────────────────────────────────────────────────
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    InsufficientBalance = 5,

    // ── Drip-pool (11–20) ──────────────────────────────────────────────────
    AlreadyJoined = 11,
    NotJoined = 12,
    Locked = 13,
    LockupActive = 14,

    // ── Multi-sig governance (21–30) ───────────────────────────────────────
    ThresholdNotMet = 21,
    AlreadySigned = 22,
    ProposalNotFound = 23,

    // ── Vault pause / circuit breaker (31–40) ──────────────────────────────
    NotAdmin = 31,
    AlreadyPaused = 32,
    NotPaused = 33,
    ProtocolPaused = 34,

    // ── Proxy upgrade (41–50) ──────────────────────────────────────────────
    InvalidAddress = 41,

    // ── Yield strategy (51–60) ─────────────────────────────────────────────
    StrategyNotSet = 51,
    StrategyVersionUnsupported = 52,
    StrategyPaused = 53,
    RedeemFailed = 54,
    DepositFailed = 55,
}

impl ContractError {
    /// Stable human-readable message for logging and client display.
    pub fn message(self) -> &'static str {
        match self {
            ContractError::NotInitialized => "contract is not initialized",
            ContractError::AlreadyInitialized => "contract is already initialized",
            ContractError::Unauthorized => "caller is not authorized",
            ContractError::InvalidAmount => "amount must be greater than zero",
            ContractError::InsufficientBalance => "insufficient balance",
            ContractError::AlreadyJoined => "participant has already joined",
            ContractError::NotJoined => "participant has not joined",
            ContractError::Locked => "contract is locked (reentrancy guard)",
            ContractError::LockupActive => "withdrawal blocked until lockup ends",
            ContractError::ThresholdNotMet => "multi-sig threshold not met",
            ContractError::AlreadySigned => "signer has already approved this proposal",
            ContractError::ProposalNotFound => "proposal not found",
            ContractError::NotAdmin => "caller is not the admin",
            ContractError::AlreadyPaused => "protocol is already paused",
            ContractError::NotPaused => "protocol is not paused",
            ContractError::ProtocolPaused => "protocol is paused",
            ContractError::InvalidAddress => "invalid contract address",
            ContractError::StrategyNotSet => "no yield strategy configured",
            ContractError::StrategyVersionUnsupported => "strategy interface version is unsupported",
            ContractError::StrategyPaused => "strategy is paused",
            ContractError::RedeemFailed => "strategy redeem returned less than the caller-verifiable balance",
            ContractError::DepositFailed => "strategy deposit failed",
        }
    }

    /// Numeric error code exposed on-chain.
    pub fn code(self) -> u32 {
        self as u32
    }
}

#[cfg(test)]
mod tests {
    use super::ContractError;

    #[test]
    fn common_errors_have_stable_codes() {
        assert_eq!(ContractError::NotInitialized.code(), 1);
        assert_eq!(ContractError::AlreadyInitialized.code(), 2);
        assert_eq!(ContractError::Unauthorized.code(), 3);
        assert_eq!(ContractError::InvalidAmount.code(), 4);
        assert_eq!(ContractError::InsufficientBalance.code(), 5);
        assert_eq!(ContractError::AlreadyJoined.code(), 11);
        assert_eq!(ContractError::NotJoined.code(), 12);
        assert_eq!(ContractError::Locked.code(), 13);
        assert_eq!(ContractError::LockupActive.code(), 14);
        assert_eq!(ContractError::ThresholdNotMet.code(), 21);
        assert_eq!(ContractError::AlreadySigned.code(), 22);
        assert_eq!(ContractError::ProposalNotFound.code(), 23);
        assert_eq!(ContractError::NotAdmin.code(), 31);
        assert_eq!(ContractError::AlreadyPaused.code(), 32);
        assert_eq!(ContractError::NotPaused.code(), 33);
        assert_eq!(ContractError::ProtocolPaused.code(), 34);
        assert_eq!(ContractError::InvalidAddress.code(), 41);
    }

    #[test]
    fn error_messages_are_non_empty() {
        let variants = [
            ContractError::NotInitialized,
            ContractError::AlreadyInitialized,
            ContractError::Unauthorized,
            ContractError::InvalidAmount,
            ContractError::InsufficientBalance,
            ContractError::AlreadyJoined,
            ContractError::NotJoined,
            ContractError::Locked,
            ContractError::LockupActive,
            ContractError::ThresholdNotMet,
            ContractError::AlreadySigned,
            ContractError::ProposalNotFound,
            ContractError::NotAdmin,
            ContractError::AlreadyPaused,
            ContractError::NotPaused,
            ContractError::ProtocolPaused,
            ContractError::InvalidAddress,
        ];
        for err in variants {
            assert!(!err.message().is_empty());
        }
    }
}
