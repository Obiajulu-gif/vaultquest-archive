## Description

Adds a fail-closed release readiness gate for migration validation, security checks, smoke tests, and rollback rehearsal. The `v*` release workflow now creates a draft only after these checks pass, and uploads commit/run-bound evidence. This prevents missing or unverifiable release checks from being treated as ready.

## Type of Change

- [ ] Bug fix
- [x] New feature
- [ ] Breaking change
- [x] Documentation update

## Files Modified

- `.github/workflows/release-tagging.yml` — gates draft release creation on PostgreSQL migration checks, security scans, smoke tests, and rollback rehearsal.
- `.github/workflows/security.yml` — no longer suppresses critical dependency audit failures.
- `.github/pull_request_template.md`, `scripts/check-release-readiness.js` — validate gate wiring during PR/repository checks.
- `scripts/release-readiness.cjs`, `scripts/rehearse-release-rollback.cjs` — validate provenance-bound evidence and perform safe isolated backup/restore verification.
- `backend/src/scripts/migrationSafety.ts`, `backend/tests/migration-safety.spec.ts`, `backend/tests/release-readiness-gate.spec.ts` — migration parsing and release gate verification.
- `docs/release-readiness-checklist.md`, `backend/docs/RELEASE_READINESS.md`, `docs/TESTING.md` — operational requirements and recovery guidance.

## Testing

- [x] Tested locally
- [x] Added unit tests
- [ ] Tested on Stellar Testnet (for wallet/contract changes; not applicable)

## Code Quality checks

- 33 migration/release readiness tests passed.
- 3 selected CSRF/service-auth tests passed.
- Changed TypeScript and JavaScript lint checks passed.
- Prisma schema validation, `node --check`, release preflight, and `git diff --check` passed.
- `pnpm audit --audit-level=critical` reports 4 critical findings (37 total); the release gate correctly blocks until dependencies are remediated.
- Docker daemon was unavailable locally, so PostgreSQL-backed smoke and restore rehearsal must be confirmed in CI.

# Behavioural Changes

- Release tag jobs cannot draft a release unless the release readiness job passes.
- Migration/schema checks run against disposable PostgreSQL; rollback rehearsals refuse remote or unsafe database targets.
- Required evidence is tied to the commit and GitHub Actions run and uploaded as an artifact.
- Critical audit failures now fail the security workflow instead of being ignored.

## Tests Errors

- The full backend security test file has 3 pre-existing failures; the release workflow runs the passing CSRF and internal service-auth test selection.
- Local execution of PostgreSQL-backed smoke and rollback restore was unavailable because Docker Desktop’s daemon was not running.
- Critical dependency audit currently fails on 4 critical dependency advisories; this is an intentional release blocker.

Closes #956
