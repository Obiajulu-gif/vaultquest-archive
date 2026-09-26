# Quest Payout Trust Boundary

This document maps the first pass of VaultQuest's quest, escrow, and transaction-signing trust boundaries. The goal is to make every funds-moving rule explicit before it is implemented or tested in deeper concurrency harnesses.

## Enforcement Matrix

| Rule | Current preferred enforcement | Why it matters |
| --- | --- | --- |
| Quest eligibility | Both service and contract | The service can provide UX guidance, but payout safety must not rely on a mutable backend decision only. |
| Quest completion evidence | Service validates evidence; contract validates payout authorization | Evidence parsing may stay off-chain, while payout release must require a contract-verifiable authorization or claim state. |
| Reward pool availability | Contract | Scarce funds must be decremented atomically on-chain so simultaneous completions cannot over-commit the pool. |
| Escrow balance availability | Contract | Contract balance and reserved liabilities are the canonical source of truth. |
| Round boundary state | Contract | Deposits, withdrawals, and quest claims near round close must serialize through contract state transitions. |
| Duplicate claim prevention | Contract, mirrored in service | The backend can pre-check for fast feedback, but the contract must reject duplicate claims authoritatively. |

## Signing Intent Safeguards

Every wallet signing request should be generated from a structured intent before XDR construction. The intent should include:

- operation type, such as deposit, withdrawal, quest claim, or escrow payout;
- source account;
- destination account or contract;
- asset code and issuer;
- amount or maximum amount;
- quest id, escrow id, or round id when applicable.

Before handing a transaction to the wallet, decode the XDR and show the user a plain-language summary derived from the decoded transaction, not from UI form state. After signing, decode the signed transaction again and compare it with the original intent before submission.

## Concurrency Follow-Up

The multi-actor test harness should cover two collision classes first:

1. Several users claim against the last available reward slots in the same pool.
2. Several users submit deposits or withdrawals while a round transitions from open to closed.

A passing test must prove the final on-chain accounting is consistent and that rejected actors receive a clear, authoritative failure rather than a stale off-chain success.

## Remediation Priority

1. Move any funds-gating scarcity check to contract state.
2. Treat service-layer pre-checks as advisory only.
3. Add pre-signing and post-signing intent verification around wallet-connect calls.
4. Build the multi-actor e2e harness after the contract-level rejection path exists.