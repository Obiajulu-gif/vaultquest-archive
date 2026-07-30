# Contract boundary (#495)

## Decision

**`contracts/drip-pool` is the single authoritative contract.** It is the only
source of truth for principal, rewards/yield, round/draw state, pause, admin
control, and winner settlement. All clients (backend, `stellar-wallet-connect`,
deployment manifest) bind to it exclusively.

`contracts/vault` is a deprecated skeleton that predates drip-pool. It is
**not** deployed for new pools and no client is wired to its write entrypoints.
It is retained only so a pre-existing deployment (if any) can still be read
for migration verification. See the deprecation banner in
`contracts/vault/src/lib.rs` for the specific incompatibilities (single-admin,
no rounds/lockups/claim-deadlines, no real token custody).

## Why drip-pool

| Concern | drip-pool | vault |
|---|---|---|
| Admin model | Multisig with configurable threshold, proposal/approve/cancel | Single `Admin` address |
| Token custody | Real SAC transfers in/out (#376) | Internal balance bookkeeping only |
| Rounds/draws | `Pool` round state, `draw_winner` with prize accounting | `draw_winner` only emits an event |
| Lockups/yield | Duration-weighted lockup multipliers, `add_yield`/`credit_yield` | none |
| Claim handling | `claim_deadline`, `sweep_unclaimed` | none |
| Reentrancy/TTL hardening | Guard + comprehensive TTL renewal (#139/#385) | none |

vault's storage layout (`DataKey::{Admin, IsPaused, Balance, TotalDeposits}`)
and drip-pool's (`Pool`, `Participant`, `Proposal`, multisig admin set) are not
convertible into one another without a bespoke migration script — there is no
generic on-chain upgrade path between them.

## Module responsibilities

- **pool** (`contracts/drip-pool`): canonical state — deposits, withdrawals,
  yield, rounds, winner selection, payouts, pause, multisig admin.
- **vault** (`contracts/vault`): retired; read-only (`balance_of`,
  `total_deposits`, `get_paused`) for legacy-deployment verification only.
- **factory**: not yet implemented. Any future multi-pool factory must deploy
  drip-pool instances and register them through the same
  `contracts/drip-pool/canonical-spec.ts`.
- **strategy**: not yet implemented; yield sourcing today is admin-credited
  via `add_yield`/`credit_yield` inside drip-pool itself. A future strategy
  module must be a caller of drip-pool's yield entrypoints, not a parallel
  balance holder.

## One client/spec

`contracts/drip-pool/canonical-spec.ts` (mirrored in `canonical-spec.json`)
is the single generated spec consumed by:

- the backend indexer/reconciler (event topics, error codes)
- `stellar-wallet-connect/src/vault/contract/types.ts` (`VaultContractClient`,
  despite its historical `vault` package path, already speaks drip-pool's
  pool/join/drip/claim/withdraw model — not `contracts/vault`)
- `lib/deployment-manifest.ts` (`contracts.dripPool`)

`contracts/drip-pool/tests/cross-stack-conformance.test.ts` fails CI if any of
these three drift from the canonical spec. `ContractsSchema` in
`lib/deployment-manifest.ts` has no `vault` field, so a schema-valid manifest
cannot reference the legacy contract at all. In addition,
`assertContractSpecNotDeprecated` (called from every manifest load path) rejects
any manifest whose `contracts.dripPool.specHash` matches a known-superseded
build, via the `DEPRECATED_CONTRACT_SPEC_HASHES` allowlist in
`lib/deployment-manifest.ts` — see `tests/deployment-manifest.test.ts`.

## Legacy deployment migration path

For any already-deployed `contracts/vault` instance:

1. Read out `balance_of(depositor)` for every known depositor and
   `total_deposits()` via the contract's own view calls (read-only; no writes).
2. Re-`deposit` each balance into the canonical drip-pool instance under
   admin-assisted migration, crediting principal 1:1 with no yield (yield
   accrual starts fresh under drip-pool's model since vault never tracked it).
3. Mark the vault instance paused (if not already) and stop indexing it —
   the backend indexer only ever watches `contracts.dripPool.contractId` from
   the manifest, so no code change is needed to "stop" ingesting vault events.
4. Retire the vault contract id from any off-manifest configuration (env vars,
   scripts) once migration is verified.

No automated on-chain migration exists today; step 2 is an operational runbook,
not a contract call, because the storage models don't map automatically.
