# Migration safety (#790)

Migrations here are hand-maintained SQL folders applied with
`prisma migrate deploy`. That reports success, but it does not tell you, before
the write, how many records a statement will touch — and several folders contain
destructive or row-rewriting statements. Nothing checks afterwards whether the
database actually converged.

[`backend/src/scripts/migrationSafety.ts`](../backend/src/scripts/migrationSafety.ts)
adds those guardrails without replacing Prisma: it reads the same
`migration.sql` files, previews them, and verifies them.

## 1. Preview before writing

```bash
cd backend
npx tsx src/scripts/migrationSafety.ts --preview 20260927000000_add_record_change_history
```

Only `SELECT`s are issued — safe against production. It prints:

- statements parsed, and what would be **created** vs **already present**;
- **destructive** statements that would actually run (a `DROP … IF EXISTS`
  against an absent object is reported as a no-op, not as risk);
- **affected record counts** for every data-changing statement — total rows in
  the table, plus whether the statement rewrites all rows or a `WHERE`-filtered
  subset. When a count cannot be obtained it reports `unknown` rather than `0`;
- **rollback / forward-fix notes** for each risky statement.

## 2. Verify after applying

```bash
npx tsx src/scripts/migrationSafety.ts --check <migration-id> --post-checks
```

Post-checks assert that every table, index and added column the migration
creates actually exists, and that any `SET NOT NULL` left no NULL rows behind.
Failures name the specific object and exit non-zero:

```
FAIL  table pools exists — missing after migration
FAIL  action_ledger.version has no NULL rows — 17 NULL row(s) remain
```

A check that could not be executed is reported as a **failure**, not skipped —
an unverifiable migration is not a verified one.

## 3. Rollback and forward-fix

| Statement | Risk | Recovery |
| --- | --- | --- |
| `ALTER TABLE … DROP COLUMN` | Column values are gone | Re-add the column with its original type; restore values from a pre-migration `pg_dump` |
| `DROP TABLE` | Table and data removed | Restore from a pre-migration `pg_dump`, then re-apply |
| `DROP INDEX` | Only the index is lost | Recreate from the same `CREATE INDEX` statement; no data affected |
| `UPDATE … ` (no `WHERE`) | Every row rewritten | Restore the affected columns from a dump |
| `ALTER COLUMN … SET NOT NULL` | Fails if NULLs remain | Backfill, then re-run — migrations are written to be re-runnable |

Take a dump first:

```bash
pnpm --filter backend db:backup
```

**Forward fix is the normal path.** Statements use `IF NOT EXISTS` / `IF EXISTS`
guards, so after correcting a migration you simply re-run it; there is rarely
anything to undo by hand. Roll back from a dump only when a statement already
destroyed data.

### Verifying a rollback or failed migration (#1000)

After a migration fails part-way, or after you roll one back, confirm where the
database actually landed:

```bash
npx tsx src/scripts/migrationSafety.ts --verify-rollback <migration-id>                   # expect fully reverted
npx tsx src/scripts/migrationSafety.ts --verify-rollback <migration-id> --expect applied  # expect fully applied
```

Every table, index and column the migration creates or drops is probed and
classified as evidence that the migration is *applied* or *reverted*. The state
is one of:

| State | Meaning | Exit |
| --- | --- | --- |
| `reverted` | Everything the migration created is gone and everything it dropped is back | 0 when `--expect reverted` |
| `applied` | Everything is in its post-migration state | 0 when `--expect applied` |
| `partial` | Some objects are migrated and some are not; the report names both groups | 1 |
| `unverifiable` | No reliable evidence (data-only migration, only `DROP ... IF EXISTS` of absent objects) or a probe could not run | 1 |

The report also reads Prisma's `_prisma_migrations` ledger. A failed migration
leaves an unfinished record that blocks every later `prisma migrate deploy`, so
a clean schema with a `failed` ledger fails verification and prints the
`prisma migrate resolve --rolled-back <id>` command to run. The reverse
mismatches (schema migrated, ledger not; schema reverted, ledger still
`applied`) are flagged the same way. If the ledger cannot be queried the schema
classification still runs and the ledger is reported as `unknown`.

Edge cases:

- **Row data is never inspected.** A `reverted` schema only proves the objects
  are back. After a destructive migration, compare row counts and checksums
  against the pre-migration dump before reopening writes.
- **`partial` is not safe to re-run blindly.** Either finish the rollback by hand
  using the rollback notes above, or fix forward by re-applying the missing
  statements; statements are guarded, so a re-run is the normal fix-forward path.
- **A migration that creates then drops the same object** is judged by its final
  statement.
- A dropped object that is absent proves the drop only when the statement was
  not `IF EXISTS`; otherwise it could never have existed and is ignored.

For a failed *deployment*, roll the application back first so nothing writes
against the wrong schema, run `--verify-rollback` for each migration in that
release (newest first), then run the deployment preflight
(`backend/scripts/validate-deployment.ts`) to confirm the schema versions the
rolled-back build expects.

## 4. Adding a migration

1. Create the folder `prisma/migrations/<timestamp>_<phase>_<description>/migration.sql`.
2. Add the entry to `MANIFEST.json` (and `tables` when it introduces a table) —
   see [`MIGRATIONS_GUIDE.md`](../backend/prisma/MIGRATIONS_GUIDE.md).
3. Preview locally, then staging, and read the affected-record counts.
4. Apply with `prisma migrate deploy`, then run `--post-checks` against staging
   before promoting to production.

## Tests

[`backend/tests/migration-safety.spec.ts`](../backend/tests/migration-safety.spec.ts)
covers parsing (including every real migration folder in the repo), preview
(create vs skip, affected counts, unknown-count degradation, no-op detection),
and post-checks across successful, partially-failed, incomplete-backfill and
unverifiable scenarios.
[`backend/tests/rollback-verification.spec.ts`](../backend/tests/rollback-verification.spec.ts)
covers rollback verification: reverted, applied, partial and unverifiable
schemas, `IF EXISTS` and create-then-drop handling, and Prisma ledger
agreement.

```bash
pnpm --filter backend test -- migration-safety
```
