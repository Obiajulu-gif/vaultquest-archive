# Cross-Stack Conformance Tests

This directory contains cross-stack conformance tests that validate the Rust contract, backend TypeScript, and wallet package types remain in sync.

## Quick Start

```bash
# Run conformance tests
pnpm test:conformance

# Or from the drip-pool directory
cd contracts/drip-pool && npx vitest run

# Regenerate golden fixtures
pnpm fixtures:regenerate
```

## Architecture

### Canonical Spec (`canonical-spec.json` / `canonical-spec.ts`)

The source of truth for contract types. Contains:
- Error codes (Rust Error enum values)
- Event shapes (topics and data)
- Struct shapes (Pool, Participant, Proposal)
- Method signatures
- Cross-stack type mappings (contract ↔ backend ↔ wallet)

### Golden Fixtures (`golden-fixtures/`)

Pre-validated JSON files used by tests:
- `events.json` - Event topic and data shapes
- `errors.json` - Error code mappings
- `structs.json` - Struct field definitions

### Conformance Tests (`tests/cross-stack-conformance.test.ts`)

44 tests covering:
1. **Error Code Conformance** - All contract errors map correctly to backend and wallet errors
2. **Method Conformance** - All public contract methods are in the canonical spec
3. **Event Topic Conformance** - Event shapes match across stacks
4. **Type Mapping Conformance** - Action types map correctly between contract/backend/wallet
5. **XDR Decode Conformance** - Backend indexer can decode all event types
6. **Lifecycle Conformance** - Full create → join → deposit → claim → withdraw lifecycle
7. **Wallet Error Conformance** - Wallet error kinds are consistent
8. **Struct Field Conformance** - All required fields are documented
9. **Proxy Conformance** - Proxy contract error codes and methods
10. **Fixture Regeneration** - Version and ordering stability

## Adding New Contract Features

1. Update the Rust contract in `src/lib.rs`
2. Update `canonical-spec.json` and `canonical-spec.ts` with new types
3. Run `pnpm fixtures:regenerate` to update golden fixtures
4. Update backend types in `backend/src/constants.ts` and `backend/src/types.ts`
5. Update wallet types in `stellar-wallet-connect/src/vault/contract/types.ts`
6. Run `pnpm test:conformance` to verify everything stays in sync
7. Document intentional breaking changes in your commit message

## CI Integration

The `.github/workflows/conformance.yml` and `.github/workflows/storage-abi-spec-diff.yml` workflows run on:
- Changes to contract source files (`contracts/drip-pool/src/**`, `contracts/common/src/**`, `contracts/vault-factory/src/**`)
- Changes to canonical spec or golden fixtures
- Changes to backend constants/types/indexer
- Changes to wallet contract types

## Proxy Upgrade Pipeline & Verification

### 1. Storage & ABI Spec Diff Check (Issue #551)
Enforced in CI via `.github/workflows/storage-abi-spec-diff.yml`. Validates that storage layout (`DataKey`) variants or public `#[contractimpl]` entrypoints are not silently removed or changed without registering an explicit on-chain migration record or migration documentation.

### 2. Populated-State Upgrade Rehearsal (Issue #552)
Tested via `test_populated_state_upgrade_rehearsal` in `contracts/drip-pool/src/test.rs`. Seeds realistic populated state (multiple participants, lockup tiers, queued `WithdrawalRequest`s, open rounds) before executing the full upgrade lifecycle (`propose_upgrade` → `approve_upgrade` → timelock -> `execute_upgrade`). Asserts that all participant balances, queue ordering, and round data remain byte-identical and uncorrupted post-upgrade.

### 3. Post-Upgrade Smoke Tests (Issue #553)
Provided via reusable helper `run_post_upgrade_smoke_tests(...)` in `contracts/drip-pool/src/test.rs`. Exercises `join`, `deposit`, `withdraw`, multisig proposal workflows, and view functions (`pool`, `savings`) immediately following an upgrade to ensure newly upgraded logic contracts function properly.

### 4. Fail Closed Token Custody Security Guard (Issue #524)
`transfer_tokens` returns `Err(Error::TokenNotConfigured)` when unconfigured, preventing no-custody pools from executing synthetic accounting or false claims. `set_token` fails with `Error::AlreadyInitialized` if a token is already configured, preventing post-deposit asset switching.

## Intentional Breaking Changes

When making breaking changes to the contract:

1. Update the canonical spec with the new types
2. Run `pnpm fixtures:regenerate`
3. Update the version in `canonical-spec.json`
4. Document the breaking change in your commit message
5. The CI will fail until backend and wallet types are updated

## Event Topics Reference

| Event | Topics | Data Fields |
|-------|--------|-------------|
| pool/created | ["pool", "created"] | address (admin) |
| pool/joined | ["pool", "joined"] | address (participant) |
| pool/deposit | ["pool", "deposit"] | who, amount, total_deposited |
| pool/withdrawn | ["pool", "withdrawn"] | who, amount |
| pool/claimed | ["pool", "claimed"] | who, amount |
| pool/payout | ["pool", "payout"] | winner, prize |

## Error Code Reference

| Contract Error | Code | Backend Error | Wallet Error Kind |
|----------------|------|---------------|-------------------|
| AlreadyInitialized | 1 | INVALID_PAYLOAD | contract_error |
| NotInitialized | 2 | INVALID_PAYLOAD | contract_error |
| AlreadyJoined | 3 | INVALID_PAYLOAD | contract_error |
| NotJoined | 4 | NOT_FOUND | contract_error |
| InvalidAmount | 5 | INVALID_PAYLOAD | contract_error |
| Locked | 6 | REVERTED_ON_CHAIN | contract_error |
| LockupActive | 7 | REVERTED_ON_CHAIN | contract_error |
| Unauthorized | 8 | UNAUTHORIZED | signature_rejected |
| ThresholdNotMet | 9 | FORBIDDEN | contract_error |
| AlreadySigned | 10 | INVALID_PAYLOAD | contract_error |
| ProposalNotFound | 11 | NOT_FOUND | contract_error |
| ProposalExpired | 12 | INVALID_PAYLOAD | contract_error |
| InvalidAction | 13 | INVALID_PAYLOAD | contract_error |
