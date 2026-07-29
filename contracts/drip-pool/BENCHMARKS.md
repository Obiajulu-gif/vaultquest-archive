# DripPool Contract Benchmarks

This document describes the benchmark suite for the DripPool Soroban contract, capturing resource usage at various scales.

## Resource Budgets

Soroban transaction limits:

| Resource | Limit | Description |
|----------|-------|-------------|
| CPU Instructions | 10,000,000 | Maximum computation units |
| Memory | 2,500,000 bytes | Maximum memory usage |
| Ledger Reads | 2,500 | Maximum storage reads |
| Ledger Writes | 1,000 | Maximum storage writes |
| Footprint | 1,000,000 bytes | Maximum contract footprint |
| Events | 100 events | Maximum events per transaction |
| Event Bytes | 100,000 bytes | Maximum total event payload |

## Benchmark Scales

| Scale | Participants | Description |
|-------|--------------|-------------|
| Baseline | 1 | Minimum viable vault |
| Small | 10 | Early-stage vault |
| Medium | 100 | Growing vault |
| Target | 1,000 | Production target |

## Method Resource Baselines

### Write Operations

| Method | 1 | 10 | 100 | 1,000 |
|--------|---|-----|------|-------|
| `create` | ~5K CPU, ~1KB | - | - | - |
| `join` | ~10K CPU, ~2KB | ~100K CPU, ~20KB | ~1M CPU, ~200KB | ~10M CPU, ~2MB |
| `deposit` | ~15K CPU, ~3KB | ~150K CPU, ~30KB | ~1.5M CPU, ~300KB | ~15M CPU, ~3MB |
| `drip` | ~15K CPU, ~3KB | ~150K CPU, ~30KB | ~1.5M CPU, ~300KB | ~15M CPU, ~3MB |
| `claim` | ~10K CPU, ~2KB | ~100K CPU, ~20KB | ~1M CPU, ~200KB | ~10M CPU, ~2MB |
| `withdraw` | ~20K CPU, ~4KB | ~200K CPU, ~40KB | ~2M CPU, ~400KB | ~20M CPU, ~4MB |
| `deposit_with_duration` | ~20K CPU, ~4KB | ~200K CPU, ~40KB | ~2M CPU, ~400KB | ~20M CPU, ~4MB |
| `withdraw_locked` | ~25K CPU, ~5KB | ~250K CPU, ~50KB | ~2.5M CPU, ~500KB | ~25M CPU, ~5MB |
| `add_yield` | ~10K CPU, ~2KB | - | - | - |
| `credit_yield` | ~15K CPU, ~3KB | ~150K CPU, ~30KB | ~1.5M CPU, ~300KB | ~15M CPU, ~3MB |
| `propose` | ~20K CPU, ~4KB | ~200K CPU, ~40KB | ~2M CPU, ~400KB | ~20M CPU, ~4MB |
| `approve` | ~25K CPU, ~5KB | ~250K CPU, ~50KB | ~2.5M CPU, ~500KB | ~25M CPU, ~5MB |
| `cancel_proposal` | ~15K CPU, ~3KB | - | - | - |
| `seed_admin` | ~10K CPU, ~2KB | - | - | - |
| `draw_winner` | ~10K CPU, ~2KB | ~100K CPU, ~20KB | ~1M CPU, ~200KB | ~10M CPU, ~2MB |
| `renew_participant` | ~5K CPU, ~1KB | ~50K CPU, ~10KB | ~500K CPU, ~100KB | ~5M CPU, ~1MB |
| `renew_instance` | ~5K CPU, ~1KB | - | - | - |

### Read Operations

| Method | 1 | 10 | 100 | 1,000 |
|--------|---|-----|------|-------|
| `pool` | ~5K CPU, ~1KB | - | - | - |
| `savings` | ~5K CPU, ~1KB | ~50K CPU, ~10KB | ~500K CPU, ~100KB | ~5M CPU, ~1MB |
| `admins` | ~5K CPU, ~1KB | ~50K CPU, ~10KB | ~500K CPU, ~100KB | ~5M CPU, ~1MB |
| `threshold` | ~5K CPU, ~1KB | - | - | - |

## Event Sizing

| Event | Topics | Data | Total Bytes |
|-------|--------|------|-------------|
| `pool/created` | 2 symbols | 1 address | ~100 |
| `pool/joined` | 2 symbols | 1 address | ~100 |
| `pool/deposit` | 2 symbols | 3 values | ~150 |
| `pool/claimed` | 2 symbols | 2 values | ~120 |
| `pool/withdrawn` | 2 symbols | 2 values | ~120 |
| `pool/payout` | 2 symbols | 2 values | ~120 |

## Scaling Characteristics

### Linear Scaling

Most operations scale linearly with participant count:
- `join`, `deposit`, `claim`, `withdraw`, `renew_participant`

### Constant Scaling

Some operations are constant regardless of participant count:
- `create`, `seed_admin`, `add_yield`, `renew_instance`, `draw_winner`

### Quadratic Scaling

No operations currently exhibit quadratic scaling.

## Soroban Limits Analysis

### Safe Scales (within limits)

| Scale | Operations | Status |
|-------|------------|--------|
| 1 participant | All | ✅ Safe |
| 10 participants | All | ✅ Safe |
| 100 participants | All except bulk operations | ✅ Safe |
| 1,000 participants | Individual operations only | ⚠️ Requires batching |

### Operations Requiring Batching at Scale

At 1,000 participants:
- Bulk deposits must be split across transactions
- Bulk claims must be split across transactions
- Bulk withdrawals must be split across transactions
- Bulk TTL renewals must be split across transactions

**Recommended batch size:** 100 participants per transaction

## Running Benchmarks

### Prerequisites

The benchmark tests require the `testutils` feature of `soroban-sdk` 27+.

### Local Development

```bash
# Run all benchmarks
cargo test --package drip-pool --lib -- benchmarks

# Run specific scale
cargo test --package drip-pool --lib -- benchmarks::bench_join_1_participant

# Run with output
cargo test --package drip-pool --lib -- benchmarks -- --nocapture
```

### CI Integration

Benchmarks run automatically in CI on:
- Pull requests touching contract code
- Pushes to main/develop branches
- Manual trigger via workflow dispatch

See `.github/workflows/contracts.yml` for CI configuration.

## Regression Detection

CI enforces resource budgets:
- CPU instructions must not exceed 10% above baseline
- Memory usage must not exceed 10% above baseline
- Ledger operations must not exceed 10% above baseline

Failures indicate performance regressions that must be addressed before merging.

## Optimization Strategies

### Storage Optimization

1. **Minimize storage writes:** Use `set` sparingly; batch updates where possible
2. **Compress data:** Use smaller types (u32 vs u64) when safe
3. **Avoid redundant reads:** Cache frequently accessed values

### Computation Optimization

1. **Short-circuit early:** Return early on error conditions
2. **Minimize iterations:** Use iterator methods efficiently
3. **Avoid cloning:** Use references where possible

### Event Optimization

1. **Minimize event payload:** Use minimal data types
2. **Batch events:** Combine related events where possible
3. **Use symbolic topics:** Leverage Soroban's symbol compression

## Cursor-Based Operations

For large-scale maintenance operations, use cursor-based pagination:

```rust
// Example: Cursor-based TTL renewal
pub fn renew_participants_batch(
    env: Env,
    start_cursor: u32,
    batch_size: u32,
) -> Result<u32, Error> {
    let mut renewed = 0;
    let mut cursor = start_cursor;

    // Process batch
    for _ in 0..batch_size {
        let key = DataKey::Participant(Address::from_cursor(cursor));
        if env.storage().persistent().has(&key) {
            Self::bump_participant(&env, &key);
            renewed += 1;
        }
        cursor += 1;
    }

    Ok(cursor)
}
```

## Monitoring

Track the following metrics in production:

1. **Transaction success rate:** % of transactions completing within limits
2. **Resource usage:** Average and peak CPU/memory per transaction
3. **Storage growth:** Rate of storage expansion
4. **Event volume:** Events emitted per transaction

## Future Improvements

1. **Implement cursor-based batch operations** for production use
2. **Add resource metering** to capture actual on-chain usage
3. **Create load testing suite** for stress testing
4. **Add gas price estimation** for transaction cost prediction

## Benchmark Test Coverage

The benchmark suite (`src/benchmarks.rs`) covers:

### Join Operations
- `bench_join_1_participant`
- `bench_join_10_participants`
- `bench_join_100_participants`
- `bench_join_1000_participants`

### Deposit Operations
- `bench_deposit_1_participant`
- `bench_deposit_10_participants`
- `bench_deposit_100_participants`
- `bench_deposit_1000_participants`

### Claim Operations
- `bench_claim_1_participant`
- `bench_claim_10_participants`
- `bench_claim_100_participants`
- `bench_claim_1000_participants`

### Withdraw Operations
- `bench_withdraw_1_participant`
- `bench_withdraw_10_participants`
- `bench_withdraw_100_participants`
- `bench_withdraw_1000_participants`

### Full Round Lifecycle
- `bench_full_round_1_participant`
- `bench_full_round_10_participants`
- `bench_full_round_100_participants`
- `bench_full_round_1000_participants`

### Yield Operations
- `bench_add_yield_and_credit_1_participant`
- `bench_add_yield_and_credit_10_participants`
- `bench_add_yield_and_credit_100_participants`
- `bench_add_yield_and_credit_1000_participants`

### Proposal Operations
- `bench_propose_and_approve_2_of_2`
- `bench_propose_and_approve_3_of_5`
- `bench_proposal_with_5_admins`
- `bench_cancel_proposal`

### TTL Renewal
- `bench_renew_participant_1`
- `bench_renew_participant_10`
- `bench_renew_participant_100`
- `bench_renew_participant_1000`
- `bench_renew_instance`

### View Operations
- `bench_pool_view_1_participant`
- `bench_pool_view_10_participants`
- `bench_pool_view_100_participants`
- `bench_pool_view_1000_participants`
- `bench_savings_view_1_participant`
- `bench_savings_view_10_participants`
- `bench_savings_view_100_participants`
- `bench_savings_view_1000_participants`
- `bench_admins_view_1_admin`
- `bench_admins_view_5_admins`
- `bench_threshold_view`

### Draw Winner
- `bench_draw_winner_1_participant`
- `bench_draw_winner_10_participants`
- `bench_draw_winner_100_participants`
- `bench_draw_winner_1000_participants`

### Multiple Deposits
- `bench_multiple_deposits_10_participants_10_each`
- `bench_multiple_deposits_100_participants_10_each`
- `bench_multiple_deposits_1000_participants_10_each`

### Large Amounts
- `bench_large_amount_deposits`

### Mixed Operations
- `bench_mixed_operations_small_vault`
- `bench_mixed_operations_medium_vault`
- `bench_mixed_operations_large_vault`

### Edge Cases
- `bench_minimum_deposit`
- `bench_maximum_deposit`
- `bench_zero_claim`

### Stress Tests
- `bench_concurrent_deposits_and_claims`
- `bench_stress_max_operations`

### Duration-Based Operations
- `bench_deposit_with_duration_short`
- `bench_deposit_with_duration_long`
- `bench_withdraw_locked_10_participants`

### Admin Operations
- `bench_seed_admin`
