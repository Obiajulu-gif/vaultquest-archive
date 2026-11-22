## Description

Adds bounded stale-cache and stale-search-index detection with scoped, auditable repair recommendations for VaultQuest. Repairs are dry-run by default, preserve authoritative PostgreSQL/on-chain state, and guard checkpoint/index updates against concurrent changes. Adds operator endpoints, scheduled repair, audit persistence, and recovery guidance.

## Type of Change

- [ ] Bug fix
- [x] New feature
- [ ] Breaking change
- [x] Documentation update

## Files Modified

- `backend/src/services/cacheService.ts`, `backend/src/routes/cacheRepair.ts`, `backend/src/app.ts` — cache inspection, guarded repair, operator routes, and wiring.
- `backend/src/services/search/` and `backend/src/routes/search.ts` — stale-index comparison, concurrency-safe repair, and maintainer preview.
- `backend/src/cron.ts`, `backend/src/server.ts` — startup hydration and scheduled repair.
- `backend/prisma/migrations/20261016000000_stale_projection_repair/migration.sql` — additive projection and repair-audit tables.
- `backend/tests/cache.spec.ts`, `backend/tests/cacheRepairRoutes.spec.ts`, `backend/tests/searchIndexRepair.spec.ts`, `backend/tests/searchRoutes.spec.ts`, `backend/tests/apiContract.spec.ts` — verification.
- `backend/README.md`, `backend/prisma/migrations/README.md`, `docs/API.md`, `docs/SEARCH_INDEXING_AND_REPAIR.md` — API and operational documentation.

## Testing

- [x] Tested locally
- [x] Added unit tests
- [ ] Tested on Stellar Testnet (for wallet/contract changes; not applicable)

## Code Quality checks

- Focused tests: 4 files, 33 tests passed.
- ESLint on changed TypeScript files passed.
- Prisma schema validation and `git diff --check` passed.
- Full backend type-check remains blocked by existing repository-wide schema/type drift, including Prisma model version-field mismatches.

# Behavioural Changes

- Adds service-authenticated `GET /internal/cache/stale` and `POST /internal/cache/repair`; apply mode is opt-in.
- Adds maintainer-protected search repair preview and recurring bounded reconciliation.
- Cache repair invalidates projections only; ordinary read-through repopulates them. No ledger, wallet, or on-chain state is changed.
- Redis checkpoint writes and conditional repairs use atomic scripts to avoid dirty write-behind races.

## Tests Errors

- `tests/apiContract.spec.ts` still has 8 failures involving incomplete route/error documentation and action-response contract mismatches. The newly added cache routes are documented and do not appear as stale.

Closes #955
