# VaultQuest Test Coverage Map

This map tracks important product and platform areas that should stay covered as VaultQuest changes. Status labels are intentionally blunt:

- **Covered**: direct automated coverage exists.
- **Partial**: useful coverage exists, but important paths are missing.
- **Missing**: no clear automated coverage was found.

## Frontend

| Area | Current coverage | Status | Missing coverage to add |
| --- | --- | --- | --- |
| App route rendering | `e2e/route-smoke.spec.ts` covers core public/app routes | Partial | Add smoke coverage for `/app/vaults/archive`, account subflows, and error routes |
| Vault list and filtering | Manual UI logic in `app/app/vaults/page.jsx` and `components/app/VaultComparisonTable.jsx` | Missing | Component tests for filters, sorting, empty states, and participant insights |
| Vault detail flow | `app/app/vaults/[id]/page.jsx` renders mocked vault detail data | Missing | Component/route tests for found, not-found, participant insights, and deposit CTA states |
| Wallet connection UI | `e2e/helpers/wallet-mock.ts` and route smoke disconnected state | Partial | Header status tests for connected, disconnected, balance loading, extension disconnect, and network mismatch |
| Dashboard widgets | `components/hooks/useYieldCounter.test.js`; dashboard route smoke | Partial | Tests for onboarding checklist, empty position state, recent winners, and prize countdown |
| Accessibility/responsive behavior | Playwright guidance in `docs/TESTING.md` | Partial | Add axe checks for vault detail, archive, wallet status, and mobile nav |
| E2E failure states (wallet rejection, RPC failure, on-chain revert) | `e2e/error-states.spec.ts` mocks denial (code 4001), C-Chain RPC outage (502), and a reverted `/api/actions` record via `e2e/helpers/wallet-mock.ts` | Covered | Add per-action retry/recover coverage for the connected deposit flow once a real wallet-proxy surface exists |
| Draw round-close with independent winner verification | `e2e/round-close.spec.ts` recomputes seed→R→weighted winner, full hash chain, and `verifyProofIntegrity`, then asserts the served proof renders Verified on `/app/prizes` | Covered | Add negative round-close cases (tampered participants/seed hash) |
| Dashboard cache consistency (#748/#749) | `stellar-wallet-connect/src/vault/data/queryClient.test.ts` (out-of-order drop, monotonic `setQueryDataAt`) and `consistency.test.ts` (cross-tab fan-out, no echo, snapshot rehydrate) | Partial | Add a browser-level cross-tab test for the wired `ensureVaultCacheSync` in `Providers.jsx` |

## Backend

| Area | Current coverage | Status | Missing coverage to add |
| --- | --- | --- | --- |
| Health, env, constants, logging | `backend/tests/health.spec.ts`, `env.spec.ts`, `constants.spec.ts`, `logger.spec.ts` | Covered | Add regression tests whenever new required env vars are introduced |
| Actions and internal routes | `backend/tests/routes.actions.spec.ts`, `routes.internal.spec.ts`, `middleware.spec.ts`, `security.spec.ts` | Partial | Add unhappy-path tests for malformed payloads, auth failures, and rate limits per route |
| Portfolio/dashboard data | `backend/tests/dashboard.spec.ts`, `portfolio.spec.ts`, `portfolio-unit.spec.ts` | Partial | Add tests for empty portfolios, stale indexer data, and multi-vault summaries |
| Quest and escrow services | `backend/tests/quest.spec.ts`, `escrow.spec.ts` | Partial | Add settlement retry, idempotency, and external API failure coverage |
| Indexer, ledger, reconciliation | `backend/tests/indexer.spec.ts`, `ledger.spec.ts`, `reconciler.spec.ts`, `pool-status.spec.ts` | Partial | Add checkpoint recovery, duplicate event handling, and partial Horizon outage tests |
| Saved pools and cache | `backend/tests/saved-pools.spec.ts`, `cache.spec.ts` | Covered | Add eviction and cross-user authorization regressions as features expand |

## Contracts

| Area | Current coverage | Status | Missing coverage to add |
| --- | --- | --- | --- |
| Drip pool lifecycle | `contracts/drip-pool/src/test.rs` covers create, join, drip, claim, withdraw snapshots | Covered | Keep snapshot fixtures updated with intentional event/schema changes |
| Validation and failure cases | Rust tests cover double joins, zero/negative deposits, missing pool, unauthorized proposal paths | Covered | Add fuzz/property tests for deposit amount boundaries and timing windows |
| Lockup and withdrawal rules | Rust tests cover before/after lockup and flash-loan style withdrawal blocking | Covered | Add multi-round lockup rollover cases |
| Multisig release flow | Rust tests cover single-sig rejection and two-of-two execution | Partial | Add signer rotation, duplicate signer ordering, and revoked signer scenarios |
| Cost and event schemas | `contracts/scripts/measure_costs.sh`, `contracts/docs/EVENT_SCHEMA.md` | Partial | Automate cost budget assertions in CI and validate emitted event schema snapshots |

## Priority Gaps

1. Add frontend component tests for vault participant insights, archive load-more behavior, and wallet header status.
2. Extend route smoke coverage to include `/app/vaults/archive`.
3. Add backend failure-path tests around indexer recovery and authenticated route errors.
4. Add contract tests for signer rotation and multi-round lockup rollover.
