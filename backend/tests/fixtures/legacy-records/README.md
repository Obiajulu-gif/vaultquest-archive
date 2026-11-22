# Legacy Record Fixtures

This directory contains fixture records that represent historical (legacy) shapes of VaultQuest domain records. They are used by the migration / compatibility test suite to ensure that old persisted records can be upgraded to the current schema without data loss or corruption.

## Provenance

The fixtures are hand-crafted from the historical Prisma migrations and the corresponding indexer output shapes that were observed in production between schema versions `0.9.0` and `1.0.0`. They are intentionally small and focused on the fields that changed during migrations.

## Coverage

The following cases are covered:

| File | Scenario | Expected behavior |
| --- | --- | --- |
| `clean-legacy-record.json` | Valid legacy record with all required fields | Migrates to a valid current record without errors. |
| `missing-field.json` | Legacy record missing a required field (`prizePoolId`) | Migration fails with a descriptive validation error. |
| `deprecated-field.json` | Legacy record containing a deprecated field (`commission`) | Migration succeeds and the deprecated field is dropped. |
| `incompatible-legacy-record.json` | Legacy record with an unsupported schema version | Migration fails with an "incompatible schema version" error. |

## Validation

Run the migration test suite to validate these fixtures:

```bash
cd backend
npx vitest run tests/legacyRecordMigration.spec.ts
```

The tests assert that:

- Legacy fixtures validate against the expected old shapes.
- Migration produces current valid records.
- Each of the four cases above behaves as documented.

The transforms themselves live in `backend/src/schemas/recordCompatibility.ts`
(the compatibility layer for versioned API and record schemas, #803); see
`backend/docs/SCHEMA_VERSIONS.md` for the deprecation and migration strategy.
