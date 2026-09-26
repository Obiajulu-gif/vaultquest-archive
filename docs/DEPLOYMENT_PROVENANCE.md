# Deployment provenance (#511)

This document describes the contract-artifact provenance manifest — what it
records, how `verifyProvenance()` checks it, and how to independently verify
a deployed contract's wasm locally without any special tooling.

This is a deliberately scaled-down slice of the fuller signed-provenance
proposal discussed on #511 (see that issue's design comment for the full
Sigstore/cosign + SBOM + CI-attestation rollout). What ships here is the
self-contained, verifiable part: a typed manifest schema and a pure digest
comparison. See [Deferred](#deferred) for what's intentionally left out and
why.

## What's recorded

`lib/deployment-provenance.ts` defines `DeploymentManifestEntrySchema`, one
entry per deployed contract:

| Field | Meaning |
|---|---|
| `contractName` | Logical name, e.g. `"drip-pool"` — matches the crate/package name. |
| `contractId` | Deployed Stellar contract id (`C...`), if known. Optional — a manifest entry can be recorded before deployment. |
| `sourceCommit` | Git commit sha the wasm was built from. |
| `wasmDigest` | `sha256` of the built `.wasm` file, lowercase hex, no `sha256:` prefix. |
| `specHash` | `sha256` of the contract's exported spec (XDR). Catches ABI drift even if the wasm digest check is bypassed. |
| `cargoLockHash` | `sha256` of `Cargo.lock` at build time. Catches a dependency-only rebuild that produced a different wasm than what was reviewed. |
| `network` | `testnet \| mainnet \| futurenet \| standalone`. |
| `timestamp` | ISO-8601 build/record time. |

A full manifest is `{ version: 1, entries: DeploymentManifestEntry[] }` — see
`ProvenanceManifestSchema`.

This is a separate, additive module from `lib/deployment-manifest.ts` /
`deployment-manifest.json` (the existing network + contract-id config the
frontend reads at runtime). Nothing here changes that schema or its
consumers; the two can be merged in a follow-up once this shape is proven
out, per the original proposal's compatibility note.

## Verifying an artifact

### Locally, by hand

```bash
# 1. Build the contract the same way CI does
cd contracts/drip-pool
cargo build --target wasm32v1-none --release

# 2. Hash the resulting wasm
sha256sum ../../target/wasm32v1-none/release/drip_pool.wasm
# -> <64-char lowercase hex digest>

# 3. Compare it against the recorded entry's wasmDigest for this contract/commit.
#    They must match exactly (case-insensitive on input, but the manifest
#    itself always stores lowercase hex).
```

On macOS without `sha256sum`, use `shasum -a 256 <file>` instead.

### Programmatically, with `verifyProvenance()`

```ts
import { verifyProvenance, type DeploymentManifestEntry } from "@/lib/deployment-provenance";

const entry: DeploymentManifestEntry = /* looked up from the manifest */;
const freshDigest = /* sha256 of a freshly-built wasm, hex */;

const result = verifyProvenance(entry, freshDigest);
if (!result.verified) {
  throw new Error(`Provenance check failed: ${result.reason}`);
}
```

`verifyProvenance` is a pure function — no network calls, no filesystem
access, no Sigstore/Rekor lookups. It:

- normalizes case/whitespace on the freshly-computed digest before comparing,
- rejects anything that isn't a well-formed 64-char hex sha256 digest,
- rejects a digest that doesn't match the manifest's recorded `wasmDigest`,
- never throws — callers get a `{ verified, reason }` result they can act on
  (e.g. refuse to treat a contract id as trusted) rather than having to
  catch an exception.

`verifyProvenanceForContract(manifest, contractName, freshDigest)` is a
convenience wrapper that looks the entry up by `contractName` first and
fails closed (returns `verified: false`, never throws) when no entry exists
for that contract — so a caller can uniformly treat "no provenance recorded"
the same as "provenance check failed" rather than needing a separate
missing-entry code path.

## Deferred

Scoped out of this PR — see #511 for the full design:

- **Sigstore/cosign keyless signing** of the manifest or individual
  attestations, and the corresponding `cosign verify` / Rekor
  transparency-log check. `verifyProvenance()` here only compares digests;
  it does not establish that the recorded digest itself was produced by a
  trusted builder. That's the actual "signed provenance" part of the
  original proposal and needs real CI/OIDC infrastructure to implement and
  verify — not something that can be meaningfully added and tested in this
  slice.
- **SBOM generation** (`cargo cyclonedx` / `cyclonedx-npm`) — unrelated to
  the digest-verification guarantee this PR adds; tracked separately.
- **Reproducible-build CI enforcement** (pinned toolchain,
  `--remap-path-prefix`, double-build-and-diff in CI) — the manifest schema
  here assumes the recorded `wasmDigest` is trustworthy; making that
  assumption verifiable end-to-end in CI is follow-up work.
- **Automatic rejection wiring in backend/frontend** — this PR ships the
  verification primitive (`verifyProvenance`) but does not wire it into a
  request path that blocks untrusted contract ids. Doing so safely requires
  deciding a rollout window (see the original proposal's compatibility
  note) so currently-deployed contracts aren't locked out before they have
  a recorded manifest entry.

## Param-bound enforcement at the contract edge (#649)

Administrative parameter changes on the settings page are simulated and
never written directly — they route through governance proposals. The
`vault-factory` contract enforces the same stringency bounds on-chain inside
`update_pool_metadata` (see `contracts/vault-factory/src/lib.rs`), mirroring
`lib/admin-parameter-simulation.ts`:

| Bound | Value | Contract error |
|---|---|---|
| Treasury fee floor | `fee_bps >= 1` (1 bp; the UI carries the 0.5 bp floor, whole-bp floor here) | `FeeBelowStringency` |
| Treasury fee cap | `fee_bps <= 10_000` (100.00%) | `FeeExceedsCap` |
| Lockup cap | `lockup_days <= 3650` (10 years) | `LockupDaysExceedsCap` |

A value the simulation UI marks as blocked can therefore never be written
on-chain, even by the factory admin — the bounds are a contract-level
invariant, not just a UI constraint. New pools default to a 75 bps treasury
fee so registry metadata is never below the floor. Tests live in
`contracts/vault-factory/src/test.rs`.
