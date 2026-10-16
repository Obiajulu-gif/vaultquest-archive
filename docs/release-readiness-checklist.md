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
