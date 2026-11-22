# Contract rounding policy

All pool balances and payouts use integer token units; no floating-point
arithmetic is used for contract accounting. Proportional calculations round
down in the vault's favor. Multiplication uses a checked `i128` fast path and
Soroban `U256` when the intermediate product would overflow, so a large valid
calculation is not silently altered by saturation.

## Round claims

For a settled round, a participant's payout is
`floor((realized_yield + prize_reserve) * deposit / principal_snapshot)`.
The snapshot is frozen when the round is locked. Each claim's exact numerator
remainder is accumulated against that same denominator. The
`round_rounding_remainder(round_id)` view reports:

- `whole_units`: cumulative whole token units of dust from claimed fractions;
- `numerator / denominator`: the remaining fractional token unit.

Claims and accumulated whole-unit dust are checked together against the
settled pool before state is written. The remainder is stored separately from
the `Round` record, so adding it does not change the serialized shape of
existing rounds; its report also survives `prune_round`.

## Other proportional calculations

Emergency withdrawals use the same floor-and-wide-product arithmetic. Any
unallocated amount stays in the `emergency_assets` reserve; that view reports
the remaining reserve, not only its rounding component. Time-weighted round
tickets also use integer floor allocation; their fractional ticket weight is
not itself a token liability.

Remainders are accounting data, not additional claimable rewards. The
contract does not transfer this dust during a claim; it remains unallocated
and explicitly reportable rather than being silently discarded or assigned
to a participant based on claim order.

## Regression coverage

The contract tests exercise wide intermediate products, adversarial balance
shapes with 2,000 simulated depositors, and 300 consecutive simulated rounds.
They check after every claim that paid shares plus accumulated whole-unit dust
never exceed the settled pool.
