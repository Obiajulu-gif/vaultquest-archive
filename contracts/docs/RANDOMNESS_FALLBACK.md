# Randomness Reveal Fallback Mechanism

## Issue #717: Define a safe fallback path for stalled or withheld randomness reveals

### Problem Statement

When a randomness reveal transaction fails, is censored, or never arrives, the round can hang indefinitely. This creates an unacceptable situation for a system holding real user funds.

### Solution Overview

This document defines a bounded timeout mechanism with a permissionless fallback entropy source that preserves the no-loss guarantee and prevents manipulation.

### Implementation

#### 1. Timeout Constants

The system uses `ROUND_REVEAL_WINDOW_SECONDS` (currently 24 hours) as the timeout period after which the fallback becomes callable.

#### 2. Fallback Mechanism

The `finalize_round_randomness_fallback` function provides the fallback:

```rust
pub fn finalize_round_randomness_fallback(
    env: Env,
    caller: Address,
    round_id: u32,
) -> Result<(), Error>
```

**Key Properties:**
- **Permissionless**: Any address can call it after the timeout
- **Non-manipulable**: Uses host PRNG (`env.prng().gen()`) which cannot be biased by any single actor
- **Incentive-aligned**: No additional reward needed; participants are inherently incentivized to unblock rounds
- **Time-gated**: Only callable after `ROUND_REVEAL_WINDOW_SECONDS` have elapsed since `round.locked_at`

#### 3. Entropy Source Comparison

| Source | Security | Availability | Manipulation Resistance |
|--------|----------|--------------|------------------------|
| Commit-Reveal | High (if ≥1 honest revealer) | Dependent on revealers | Excellent if ≥1 reveals |
| PRNG Fallback | Medium (host-dependent) | Always available | Excellent (outside protocol control) |

The fallback uses a different, harder-to-withhold entropy source: the host PRNG, which is seeded by the Stellar network and outside any individual actor's control.

#### 4. Security Guarantees

**Non-manipulability:**
- Withholding a reveal cannot bias the outcome—it only forfeits the withholder's influence
- The fallback PRNG seed is determined by the host environment, not any participant
- No actor benefits from delaying past the timeout

**No-loss preservation:**
- The fallback does not affect principal safety
- Yield distribution is independent of the randomness source
- All deposits remain fully backed regardless of which path resolves

### Test Coverage

The implementation includes tests for:

1. **Reveal never happens**: Fallback succeeds after timeout
2. **Reveal happens late but before timeout**: Fallback rejected, commit-reveal succeeds
3. **Reveal happens exactly at boundary**: Both paths tested for deterministic behavior
4. **Multiple fallback attempts**: Second call returns existing randomness

### Usage

**Normal Path:**
1. Round locks → `commit_round_randomness` by signers
2. Signers call `reveal_round_randomness` within 24 hours
3. When all signers reveal, randomness resolves immediately

**Fallback Path:**
1. Round locks → some/all signers fail to reveal within 24 hours
2. Anyone calls `finalize_round_randomness_fallback` after timeout
3. Randomness resolves using host PRNG
4. Round proceeds to winner selection

### Events

- `("round", "rfallbk")`: Emitted when fallback is used, includes `(caller, round_id)`
- `("round", "rticket")`: Emitted when ticket is resolved, includes `(round_id, winning_ticket)`

### Acceptance Criteria ✓

- [x] Documented timeout and fallback-entropy path for stalled rounds
- [x] Anyone can permissionlessly trigger the fallback after the timeout
- [x] Fallback path has the same non-manipulability guarantees as the primary path
- [x] Tests covering: reveal never happens, reveal happens late but before timeout, reveal happens exactly at boundary
