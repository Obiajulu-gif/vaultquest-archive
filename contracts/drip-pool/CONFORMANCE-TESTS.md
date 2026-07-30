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

The `.github/workflows/conformance.yml` workflow runs on:
- Changes to contract source files
- Changes to canonical spec or golden fixtures
- Changes to backend constants/types/indexer
- Changes to wallet contract types

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
