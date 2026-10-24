# Release Readiness Checklist

This checklist defines the mandatory operational gates for high-risk deployments to VaultQuest environments (staging, sandbox, mainnet). It covers migrations, automated tests, smoke tests, configuration drift, rollback plans, and maintainer authorization.

---

## 1. Tests

All automated test suites must pass cleanly in local validation and CI:
- **Unit and integration tests**: `pnpm test` (frontend) and `pnpm --filter backend test` (backend).
- **Typechecking**: `pnpm exec tsc --noEmit` and backend typecheck.
- **Contract and conformance tests**: Verify API contracts, Problem Details schemas, and pagination/filter monotonicity (`backend/tests/paginationFilteringAuthContract.spec.ts`, `backend/tests/apiContract.spec.ts`).
- **Smoke tests**: Execute post-deployment smoke suite (`pnpm --filter backend test tests/smoke.spec.ts`) against the target environment.
- **Concurrency & Invariants**: Concurrency tests (`backend/tests/concurrencyDuplicateStaleVersions.spec.ts`, `backend/tests/concurrency-stress.spec.ts`) must pass with zero race conditions, double-spends, or duplicate insertions.

---

## 2. Migration

For every database schema change or backfill in `backend/prisma/migrations`:
- **Pre-execution preview**:
  Run `tsx backend/src/scripts/migrationSafetyCli.ts --preview <migration-id>`.
  Inspect:
  - Tables, columns, and indexes to be created.
  - Destructive statements (`DROP COLUMN`, `DROP TABLE`, `DROP INDEX`).
  - Affected row counts for `UPDATE` backfills and data rewrites.
- **Dry-run execution**: Verify SQL syntax and lock footprint on sandbox/staging database before production application.
- **Post-checks verification**:
  Run `tsx backend/src/scripts/migrationSafetyCli.ts --check <migration-id> --post-checks`.
  Verify:
  - All planned tables, indexes, and columns exist.
  - `SET NOT NULL` constraints have 0 remaining NULL rows.
  - Re-runnability and idempotency are preserved.

---

## 3. Configuration

Validate that configuration changes do not cause runtime downtime or drift:
- **Environment variables**: All new variables are documented in `backend/.env.example` and `.env.example`, with safe defaults.
- **Feature flags**: New features are guarded behind feature flags with sensible defaults (disabled or staged rollout).
- **Secrets and credentials**: No hardcoded API keys, Stellar secret seeds (`S...`), or private credentials. Secrets must be populated in the secure secret manager before deployment.
- **Config drift**: Run `pnpm check:drift` to confirm synchronization across deployment targets.

---

## 4. Rollback

Every release must specify an executable rollback procedure before deployment begins:
- **Code rollback**: Pin commit SHA or Docker image tag to quickly revert to the previous verified release.
- **Database rollback**:
  - Non-destructive migrations (additive columns, new tables, new indexes): Can remain in place while application code is reverted.
  - Destructive migrations (dropped columns, dropped tables): Require pre-migration database snapshot (`pg_dump`) or forward-fix migration script.
  - Data backfills: Reversion script or point-in-time recovery (PITR) plan documented in the release notes.
- **Client cache-busting**: Invalidate CDN caches and verify `/deployment-manifest.json` emits the updated version tag to prevent clients from executing stale chunks.

---

## 5. Documentation

Operational documentation must reflect the changes introduced:
- **API Reference**: Update `docs/API.md` and `docs/API_REFERENCE.md` for new endpoints or modified response fields.
- **Runbooks**: Update incident and indexer runbooks (`docs/INDEXER_RUNBOOK.md`, `docs/INCIDENT_RUNBOOK.md`) if operational behaviors change.
- **Changelog & Issue tracking**: Update `issue.md` and release notes documenting closed issues, migration steps, and architectural trade-offs.

---

## 6. Maintainer Sign-off

Deployment authorization requires explicit review and attestation:
- **Role check**: Only authorized maintainers (`admin` role or authorized CI automation) may sign off on release readiness.
- **Attestation recording**: Check items using the CLI:
  ```bash
  tsx backend/src/scripts/migrationSafetyCli.ts --checklist --attest tests,docs,config,rollback --migration-verified
  ```
- **Dual-control approval**: High-impact financial settlements or treasury migrations require dual-maintainer approval in compliance with the governance protocol.

---

## 7. Exception Handling for Urgent Fixes

In active incident scenarios (P0/P1 emergency response):
- **Urgent fix path**: A maintainer may authorize an expedited release bypassing non-critical manual steps if customer funds or protocol security are actively at risk.
- **Exception criteria**:
  1. The fix must still pass automated unit and smoke tests.
  2. The rollback plan must be explicitly stated in the emergency communication channel.
  3. The exception must be logged with timestamp, incident ID, and authorizing maintainer wallet address.
- **Post-mortem requirement**: Within 48 hours of an urgent exception deployment, the engineering team must publish a formal post-mortem documenting root cause, checklist exceptions taken, and corrective actions to prevent recurrence.
# Release readiness gate

The release tag workflow creates a draft release only after the automated gate
passes. Do not publish a release while any required check is missing, failed, or
cannot be verified. The workflow attaches `release-readiness-evidence` to the
Actions run; retain it with the release record.

## Tests and smoke verification

- [ ] The release workflow's CSRF and internal service-auth security test
  selection passes.
- [ ] PostgreSQL-backed service smoke test passes against disposable test data.
- [ ] Tests covering changed vault deposits, prize rounds, quests, wallet flows,
  and indexer reconciliation are included when those behaviors change.
- [ ] No production wallet, secret, or production database is used by CI tests.

## Migration

- [ ] Prisma schema validation passes.
- [ ] Every checked-in migration applies to a disposable PostgreSQL database.
- [ ] Migration safety post-checks pass for each migration.
- [ ] Destructive statements, affected row counts, and forward-fix/restore
  requirements have been reviewed. An unknown count is not a zero count.
- [ ] A production backup has been verified before applying a destructive
  migration; CI does not connect to or mutate production.

## Security

- [ ] The critical dependency audit passes without suppressing failures.
- [ ] Verified-secret scanning passes.
- [ ] No test or rollback rehearsal uses production credentials or customer data.
- [ ] Security check evidence is present in the release readiness artifact.

## Rollback and recovery

- [ ] The disposable-database rehearsal creates a custom-format PostgreSQL
  backup, verifies the archive, restores it into a separate empty database, and
  compares the applied migration history.
- [ ] The change has a documented rollback or forward-fix plan. Database
  migrations are not assumed to be reversible; restore a verified pre-change
  backup for destructive data loss, otherwise prefer a forward fix.
- [ ] Contract upgrade rollback follows the timelock, migration-pair, and
  multisignature procedure in `contracts/scripts/rollback_upgrade.sh`; CI does
  not submit transactions to a live network.
- [ ] A failed rehearsal blocks release. Restore failures require preserving the
  archive and logs, correcting the restore target or permissions, and rerunning
  the full rehearsal before approval.

## Configuration

- [ ] New environment variables have safe defaults, are documented, and do not
  expose secrets in the release artifact.
- [ ] Release evidence identifies the commit and Actions run and records a
  passing result plus the executed verification for migration, security, smoke,
  and rollback.

## Documentation

- [ ] API, schema, deployment, and operator documentation is updated, or
  non-applicability is explained in the change review.

## Maintainer sign-off

- [ ] A maintainer reviewed the evidence artifact and deployment/rollback plan
  before publishing the draft release.

### Edge cases and recovery

- Missing, malformed, stale, or non-passing evidence is a hard failure; do not
  manually upload a fabricated pass record. Rerun the relevant checks on the
  exact release commit.
- If the dependency audit service is unavailable, the security check is
  unverifiable and the release remains blocked. Retry when service is restored;
  do not bypass it with `|| true`.
- A critical dependency finding is a real release blocker, not a flaky check.
  Update to a patched dependency, regenerate the lockfile, rerun tests and audit,
  and verify the new audit result before tagging.
- If PostgreSQL, `pg_dump`, `pg_restore`, or a migration post-check is
  unavailable, repair the disposable CI environment and rerun. A restore into a
  target with public tables, views, sequences, functions, or custom types is
  refused; the rehearsal resets only the blank `public` schema in its
  explicitly named local `_rollback_test` database before restoring.
- A database backup restore rolls application data/schema back together; it may
  discard writes after the backup. Freeze writes and assess recovery point
  objectives before restoring production. Replay chain-derived state from
  Soroban history as described in `DISASTER_RECOVERY.md`.
- For an urgent incident, use the repository's protected maintainer approval
  process and document the specific exception, risk, owner, and follow-up
  post-mortem. No workflow input or commit message may convert failed required
  checks into a passing release gate.
