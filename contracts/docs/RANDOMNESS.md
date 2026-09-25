# Round-winner randomness (#715)

This document is the canonical spec for how a round's winning ticket and
winning depositor are derived, and how an external party can independently
verify a given round's outcome. Contract changes to
`commit_round_randomness` / `reveal_round_randomness` /
`finalize_round_randomness_fallback` / `select_round_winner` must keep this
file in sync.

## Why not a single committed seed, or a block hash?

Soroban/Stellar has no native VRF and no opcode for a contract to read
another ledger's hash. Two naive designs both fail:

- **A single party commits `sha256(seed)`, later reveals `seed`.** The
  committer can grind: try many candidate seeds against the *already-known*
  participant set before publishing only the hash of the one that favors
  them. Commit-reveal alone does not stop this — it only stops the committer
  from changing their mind *after* revealing, not from choosing adversarially
  *before* committing.
- **Combine with a "future" ledger hash.** Soroban contracts cannot read an
  arbitrary ledger's hash, and the caller who decides *when* to submit a
  transaction has some influence over which ledger sequence it lands in, so
  naively hashing `seed || ledger_sequence` reintroduces a timing-grind
  vector.

## The actual scheme: N-of-N approved-signer commit-reveal

1. **Commit** (`commit_round_randomness`, while `Round.status == Open`):
   any current approved multisig signer may commit `commitment =
   sha256(seed)` for a round, where `seed` is a 32-byte value only they
   know. Each signer may commit at most once per round. Because this must
   happen before `lock_round` freezes `principal_snapshot`, no commitment
   can be chosen in reaction to a fully-known final participant set.
2. **Lock** (`lock_round`, unchanged from #508): freezes
   `principal_snapshot`. Reveal is rejected before this point.
3. **Reveal** (`reveal_round_randomness`, only once `Locked`): each
   committer reveals their `seed`. The contract checks
   `sha256(seed) == commitment`; a committer can therefore only ever
   publish the exact seed they already committed to, or withhold it
   entirely — never a different, more-favorable one chosen after seeing
   the locked round.
4. **Resolve** — once *every* signer who committed for the round has
   revealed, the contract combines all revealed seeds, in commit order,
   into the round's `winning_ticket`:

   ```text
   digest         = sha256(seed_1 || seed_2 || … || seed_n || round_id_be_bytes)
   winning_ticket = u128(digest[0..16]) mod principal_snapshot
   ```

   Stored once as `RoundRandomness { winning_ticket, source: CommitReveal,
   resolved_at }` and never mutated again for that round.

This is secure against any single party — **including the contract's own
admin** — as long as at least one committer keeps their seed secret until
they choose to reveal it. That is the same threshold-honesty assumption
this contract already relies on for every other multisig action.

### Liveness: surviving a no-show

If any committer never reveals, step 4 can never see "everyone revealed".
`finalize_round_randomness_fallback` lets **anyone**, `
ROUND_REVEAL_WINDOW_SECONDS` (24h) after the round locked, resolve the
round using the host PRNG alone:

```text
digest         = env.prng().gen::<[u8; 32]>()   // no committed seed contributes
winning_ticket = u128(digest[0..16]) mod principal_snapshot
```

stored as `RoundRandomness { source: PrngFallback, .. }`.

Crucially, the fallback **discards every commitment for the round**, not
just the missing one. A committer who sees the round is about to resolve
unfavorably cannot force a "recombine without me" outcome — their only
choices are "reveal the seed I already committed to" or "the round falls
back to PRNG and my seed counts for nothing either way". This removes the
classic last-revealer look-ahead advantage that a naive
"combine whoever revealed" design would have.

`docs.rs` for `soroban_sdk::Prng` explicitly warns the host PRNG "is
unsuitable for generating secrets or use in applications with low risk
tolerance" — which is exactly why it is used *only* as the degraded
liveness fallback here, never as the primary source.

## Mapping the ticket to a winner: `select_round_winner`

Storage intentionally never holds an enumerable list of a round's
depositors (unbounded growth risk — see `DataKey::RoundDeposit`'s own
doc comment). So mapping `winning_ticket` to an address is a
**permissionless, bounded batch walk**, mirroring the existing
`prune_round` / `renew_participant` pattern:

- Off-chain, anyone reconstructs the round's participant set from public
  `round.deposit` events.
- They call `select_round_winner(caller, round_id, candidates)` with a
  batch (≤ `MAX_RENEWAL_ITEMS`) of candidate addresses. Repeat with more
  batches until it returns `Some(winner)`.
- The contract does **not** trust submission order. Each address is
  assigned a canonical position (`RoundParticipantSeq`) the first time it
  calls `round_deposit` in that round — deposit-arrival order, fixed at
  deposit time, immutable afterward. `select_round_winner` rejects any
  batch whose addresses are not in strictly increasing canonical-position
  order relative to what's already been processed
  (`Error::CanonicalOrderViolation`), so no combination of batches or
  batch ordering can change who ends up "containing" the fixed
  `winning_ticket` — the partition of `[0, principal_snapshot)` into
  per-address segments is uniquely determined by the (already-public,
  already-immutable) deposit-arrival order, not by whoever happens to call
  `select_round_winner`.
- Each address's odds of being selected are exactly
  `round_deposit_of(address, round_id) / round.principal_snapshot`,
  matching the weighted-selection model in `docs/YIELD_DISTRIBUTION.md`.

## Independent verification

Everything needed to re-derive and check a round's outcome is public
on-chain state or events — no off-chain/private input is ever
load-bearing:

1. Read every `RoundCommitment(signer, round_id)` and, for the
   `CommitReveal` path, every `RoundRevealedSeed(signer, round_id)`.
2. Recompute `sha256(seed) == commitment` for each signer.
3. Recompute `digest`/`winning_ticket` with the formula above (or confirm
   the `PrngFallback` path was legitimately reached: the round was
   `Locked` for at least `ROUND_REVEAL_WINDOW_SECONDS` with at least one
   committer's `RoundRevealedSeed` still missing).
4. Replay every `round.deposit` event for `round_id` to reconstruct the
   canonical-order participant list, partition
   `[0, principal_snapshot)` in that order, and confirm the claimed
   winner's segment contains `winning_ticket`.

`backend/src/services/drawProofService.ts` automates this as the
`DrawProof` attached to a round's `select_winner` action; see
`lib/draw-proof.ts` for the schema.

## Time-weighted tickets (#719)

`round_deposit`'s `amount` is prorated before it is added to
`RoundDeposit`/`principal_snapshot` — see the formula and rationale in
`round_deposit`'s own doc comment in `contracts/drip-pool/src/lib.rs`.
This affects both `select_round_winner`'s odds and `round_claim`'s
pro-rata yield share identically, since both read the same
time-weighted `RoundDeposit`/`principal_snapshot` values.
