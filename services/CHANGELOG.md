# Shared Services Changelog

Behavioral changelog for the shared `services/` helpers (escrow, quest,
savings). Versioning follows the policy in [`CONTRACT.md`](./CONTRACT.md):
MAJOR = a documented guarantee ID changes/removed, MINOR = a new guarantee ID,
PATCH = no behavioral change. Every PR touching `services/**` or
`lib/conformance-spec.ts` must add an entry here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- `syntheticMonitor.ts` (#1128): runs of the same journey no longer overlap; a
  scheduled tick or manual trigger during an in-flight run shares its result,
  after the caller's own authorization check. The timeout timer is cleared once
  a probe settles. `retentionHours` is now applied, so results older than the
  window are pruned and `getStatus()` reports `unknown` for a monitor that
  stopped running. No guarantee ID in `CONTRACT.md` changes. See
  [`docs/SYNTHETIC_MONITORING.md`](../docs/SYNTHETIC_MONITORING.md).

## [1.0.0] - 2026-09-24

### Added

- Documented the behavioral contract for the shared services in `CONTRACT.md`,
  establishing stable guarantee IDs `SAV-1..7`, `QST-1..5`, and `ESC-1..2`.
- Consumer-driven contract tests asserting those guarantees:
  - Frontend consumer: `services/__contracts__/frontend.contract.test.ts`.
  - Conformance consumer: `contracts/drip-pool/tests/services-contract.test.ts`.
- CI: `conformance.yml` now runs on changes to `services/**` and
  `lib/conformance-spec.ts` so a semantically breaking change fails a
  downstream consumer's contract test.

### Baseline behavior (no code change)

This release documents and locks in the existing behavior of `EscrowService`,
`questService`, and `SavingsService` as of the contract baseline; it does not
alter any runtime behavior.
