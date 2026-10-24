# Draw auditability: self-audit a round winner (#718)

This guide shows how a depositor or auditor — with **no trust in the
backend** — can verify that a round's winner was computed exactly per the
documented algorithm in [VAULTQUEST_ARCHITECTURE_DESIGN.md](../VAULTQUEST_ARCHITECTURE_DESIGN.md):

```
winner_index = randomness mod eligible_participant_count
```

All inputs are public on-chain data: contract storage entries and contract
events. The only tool needed is `tools/draw-verifier/verify-draw.mjs` — a
single-file Node script with **zero npm dependencies** (Node ≥ 18). It is
intentionally independent of the backend codebase so a compromised backend
cannot alter what you verify.

## 1. How a round draw works (and why it is auditable)

For every round, the contract runs a two-phase commit/reveal (mirroring the
lock/reveal model in the architecture design):

| Phase | Entrypoint | What is pinned on-chain |
|---|---|---|
| Lock | `round_commit_draw` | `seed_hash` = H(seed), Merkle `snapshot_root` over the frozen participant snapshot, `leaf_count`, commit ledger |
| Draw | `round_draw` | revealed `seed`, derived `randomness`, recomputed `winner_index`, winner address, credited prize |

### Published hash formulas (canonical, stable across upgrades)

Every hash input is `domain_tag ‖ round_id_be8 ‖ …` so evidence can never be
replayed across rounds. All integers are big-endian.

```
leaf_hash     = SHA256("vaultquest-draw-leaf" ‖ round_id_be8 ‖ strkey(addr) ‖ deposit_be)
seed_hash     = SHA256("vaultquest-draw-seed" ‖ round_id_be8 ‖ seed32)
randomness    = SHA256("vaultquest-draw-seed" ‖ round_id_be8 ‖ seed32 ‖ drawn_at_ledger_be8)
snapshot_root = SHA256("vaultquest-draw-root" ‖ round_id_be8 ‖ leaf_count_be8 ‖ merkle_root32)
winner_index  = randomness (as u256, big-endian) mod leaf_count
```

`deposit_be` is the minimal big-endian byte encoding of the deposit
(`BigInt.toString(16)` in hex, empty for zero). Merkle leaves are sorted by
address strkey; a lone node at odd depth promotes unchanged.

The contract refuses to execute a draw unless:

1. the revealed seed hashes to the lock-time `seed_hash` (`RoundDrawSeedMismatch`),
2. the winner index equals the recomputed `randomness mod leaf_count`
   (`RoundDrawWinnerNotInSnapshot`),
3. the winner's Merkle proof verifies under the committed `snapshot_root`
   and the witnessed deposit matches the frozen `RoundDeposit` storage
   (`RoundDrawWinnerNotInSnapshot`).

So the admin cannot choose the winner: the seed was committed before
settlement, the index is forced by the formula, and the winner must be the
participant sitting at that index in the committed snapshot.

## 2. Self-audit a past round (live chain)

You need the pool contract id (from `deployment-manifest.json` →
`contracts.dripPool.contractId`) and the round id (shown in the app; or read
`round_nonce` from the contract).

```bash
node tools/draw-verifier/verify-draw.mjs verify \
  --contract CD... --round 3 \
  [--rpc-url https://soroban-testnet.stellar.org]
```

The tool:

1. fetches the contract's `round committed` / `round drawn` events (getEvents),
2. re-derives `seed_hash`, `randomness` and `winner_index` from the revealed
   seed,
3. re-derives the snapshot-root envelope,
4. checks the reported winner index equals the recomputation,
5. verifies the winner's Merkle proof under the snapshot root (when the
   bundle carries the snapshot leaves/proof).

It prints one ✓/✗ per check and exits non-zero on any failure.

## 3. Self-audit offline (captured bundle)

Because RPC history can be pruned, `capture` first writes a self-contained
JSON bundle (raw evidence only — commitments, revealed seed, snapshot root,
winner, ledger). Anyone can re-verify it later without network access:

```bash
node tools/draw-verifier/verify-draw.mjs capture --contract CD... --round 3 --out round-3.json
node tools/draw-verifier/verify-draw.mjs verify-fixture --fixture round-3.json
```

A bundle is tamper-evident: every field it contains is cross-checked against
every other field (commitment vs reveal, randomness vs index, envelope vs
root), so editing any single value breaks verification.

## 4. What you need to trust

| Trust | Needed? | Why |
|---|---|---|
| VaultQuest backend | **No** | The verifier reads chain data and re-implements the formulas itself. |
| The verifier script | Only its ~200 lines of hash/XDR code | Read it; it has no dependencies to hide anything in. |
| The contract deployment | Yes | You must trust the deployed WASM is the audited build (`specHash` in `deployment-manifest.json`). |
| The seed's initial choice | Commitment-bounded | The committer picks the seed before settlement, but cannot change it after `round committed` — any reveal must hash to the committed value. |

Residual risks (also true of the two-phase design in the architecture doc):
the committer could discard a seed (DoS — mitigated by the permissionless
finalize path) and a single committer who knew future settlement outcomes
could grind seeds before committing. Multi-admin multisig approval of
`round_commit_draw` bounds both.

## 5. Continuous verification (CI)

`.github/workflows/ci.yml` runs a job that:

1. executes the contract's Rust round-draw test suite,
2. captures the emitted `round committed`/`round drawn` events from the
   simulated ledger as a raw-ScVal fixture (the same encoding live chain
   data has),
3. runs `verify-draw.mjs verify-fixture` against that fixture — the
   **real historical round data** produced by the canonical contract code —
   and fails the build if recomputation and reported winner ever disagree.

## 6. Round error codes

| Code | Name | Meaning |
|---|---|---|
| 92 | `RoundDrawSeedMismatch` | revealed seed ≠ committed seed hash |
| 93 | `RoundDrawNotLocked` | commit attempted on a non-Locked round (or draw without commit) |
| 94 | `RoundDrawAlreadyCommitted` | double commit for the same round |
| 95 | `RoundDrawNotSettled` | draw attempted before `settle_round` |
| 96 | `RoundDrawWinnerNotInSnapshot` | index ≠ recomputation, or Merkle proof / deposit witness invalid |
