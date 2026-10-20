## Description

Apply conservative, overflow-safe rounding to proportional contract allocations. Track cumulative round-claim dust in an inspectable view and add adversarial multi-depositor and multi-round regression coverage.

## Type of Change

- [ ] Bug fix
- [x] New feature
- [ ] Breaking change
- [x] Documentation update

## Files Modified

- `contracts/drip-pool/src/lib.rs` — conservative wide multiplication/division, cumulative remainder state and view, and checked round accounting.
- `contracts/drip-pool/src/test.rs` — wide-product, adversarial-depositor, long-running-round, and persistence tests.
- `contracts/drip-pool/canonical-spec.json`
- `contracts/drip-pool/canonical-spec.ts`
- `contracts/drip-pool/golden-fixtures/errors.json`
- `contracts/drip-pool/golden-fixtures/events.json`
- `contracts/drip-pool/golden-fixtures/structs.json`
- `contracts/drip-pool/tests/cross-stack-conformance.test.ts`
- `contracts/docs/ROUNDING_POLICY.md`
- `contracts/README.md`

## Testing

- [x] Tested locally — focused contract-method/schema conformance tests passed.
- [x] Added unit tests — includes 2,000 simulated depositors across 300 rounds.
- [ ] Tested on Stellar Testnet (for wallet/contract changes)

## Code Quality checks

- `git diff --check` passed.
- Focused conformance tests passed (3).
- Cargo tests were attempted in Ubuntu WSL but are blocked before test execution by the existing Soroban ABI name-length error in `finalize_round_randomness_fallback`.
- The full conformance suite reports five pre-existing error-code/backend-action mapping failures.
- Documentation validation reports existing broken links outside this change.

# Behavioural Changes

- Pro-rata token payouts round down in the vault's favor.
- Exact fractional claim remainders accumulate per round and can be inspected using `round_rounding_remainder`.
- Emergency withdrawals use overflow-safe floor arithmetic; their unallocated assets remain in the reported reserve.

## Related Issues

Closes #
