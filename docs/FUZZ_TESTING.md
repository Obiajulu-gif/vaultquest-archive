# Fuzz Testing for Malformed and Boundary Inputs (#1175)

## Overview

The VaultQuest protocol and backend services implement rigorous fuzz testing to ensure resilience against adversarial, boundary, and malformed inputs. Tests cover both on-chain smart contracts (`contracts/drip-pool/src/fuzz_tests.rs`) and backend ingestion/parsing services (`backend/tests/fuzzBoundaryAmounts.spec.ts`).

---

## On-Chain Contract Fuzz Suite (`contracts/drip-pool/src/fuzz_tests.rs`)

The Soroban smart contract fuzz harness tests every entry-point against boundary conditions and adversarial payloads:

### 1. Zero & Negative Amounts
- **Test**: `fuzz_zero_and_negative_amounts_rejected`
- Exercises `deposit`, `withdraw`, and round allocation functions with `0`, `-1`, `-100`, and minimum representable values (`i128::MIN`).
- Invariant: Transactions must revert cleanly with `Error::InvalidAmount` or equivalent domain errors, never panicking or corrupting storage balances.

### 2. Numerical Extremes & Overflow Bounds
- Tests arithmetic operations with `i128::MAX` and near-maximum quantities.
- Probes math operations in ticket weighting and pool share distribution to guarantee overflow safety and invariant preservation.

### 3. Boundary Ledger Sequences & Expiry
- **Test**: `fuzz_boundary_ledger_sequences`
- Probes round finalization, claim redemption, and withdrawal processing exactly at deadline ledgers (`deadline - 1`, `deadline`, `deadline + 1`).
- Asserts that actions strictly obey round lifecycle states and cannot be replayed past expiry.

### 4. Uninitialized State Guards
- **Test**: `fuzz_uninitialized_pool_calls_rejected`
- Verifies that calling any mutating entry point before `create()` or without token registration fails safely with `Error::NotInitialized`.

### 5. Access Control & Non-Participant Operations
- **Tests**: `fuzz_non_participant_operations_rejected`, `fuzz_self_transfer_ownership_rejected`
- Probes unauthorized addresses invoking admin-only functions, non-participants attempting claims or withdrawals, and self-transfer ownership attempts.

### 6. Queue & Duplicate State Boundaries
- **Test**: `fuzz_withdrawal_queue_boundary_and_duplicates`
- Probes duplicate withdrawal requests, boundary capacities, and queue ordering.

---

## Backend Boundary & Mutation Fuzzing (`backend/tests/fuzzBoundaryAmounts.spec.ts`)

The backend test suite uses seeded pseudo-random mutations to fuzz amount parsers, string processors, and payload decoders:

- **Malformed Character Injections**: Injects null bytes (`\u0000`), control characters (`\t`, `\n`), scientific notation (`e`, `E`), and signs (`+`, `-`) into decimal inputs.
- **Precision Extremes**: Tests inputs exceeding 7 decimal places (Stellar stroop limit), extreme string lengths (>30 digits), and NaN representations.
- **Invariant**: All invalid or corrupted inputs are rejected deterministically with `InvalidAmountError` or RFC 7807 problem details, avoiding unhandled exceptions or service crashes.

---

## Operational Verification

Run on-chain contract fuzz tests:
```bash
cd contracts/drip-pool
cargo +stable test --lib fuzz_tests
```

Run backend fuzz tests:
```bash
npx vitest run backend/tests/fuzzBoundaryAmounts.spec.ts
```
