# Release readiness gate

The authoritative release checklist and failure/recovery guidance lives in
[`docs/release-readiness-checklist.md`](../../docs/release-readiness-checklist.md).
The `Release on Tag` workflow blocks draft creation until migration deployment
and post-checks, security checks, backend smoke tests, and an isolated PostgreSQL
backup/restore rehearsal all pass.

For manual verification, follow the checklist on a disposable database. Never
point release-gate tooling at production. Database recovery is restore or
forward-fix, not an assumed reverse migration. Contract rollback must follow
the timelock and multisignature procedure; CI never submits live transactions.

The `validateReleaseReadiness` report fails closed if the migration directory
is missing, has no selectable migration, or the selected plan is empty. A
`migrationVerified` claim also requires an injected database and passing
post-checks; it cannot be satisfied by setting the flag alone. Destructive
migrations require rollback evidence unless a tracked urgent incident is
provided. Maintainer sign-off must have an admin/maintainer role, a non-empty
identity, and a valid approval timestamp no later than the check time. An
urgent exception without an incident ID is not authorized.

For failure recovery, fix an incomplete migration forward where possible. If a
migration must be rolled back, restore from the pre-migration snapshot or use
the migration-specific recovery procedure, then verify both schema state and
Prisma's migration ledger before serving traffic:

```bash
pnpm --dir backend exec tsx src/scripts/migrationSafetyCli.ts --preview <migration-id>
pnpm --dir backend exec tsx src/scripts/migrationSafetyCli.ts --check <migration-id> --post-checks
pnpm --dir backend exec tsx src/scripts/migrationSafetyCli.ts --verify-rollback <migration-id> --expect reverted
```

These are verification steps, not automatic rollback commands. A failed
verification blocks release/traffic until the operator restores or applies a
forward fix and repeats the checks.
