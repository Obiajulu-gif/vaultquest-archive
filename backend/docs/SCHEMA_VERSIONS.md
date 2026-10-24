# Schema Version Management

This document describes every versioned surface of the VaultQuest backend, the
compatibility layer that keeps old records and old clients working during a
rollout, and the deprecation/migration rules contributors must follow.

There are three versioned surfaces:

| Surface | Version coordinate | Source of truth |
| --- | --- | --- |
| HTTP response contracts | semantic (`1.0.0`) | `src/contracts/apiContract.ts`, `backend/docs/API_RESPONSES.md` |
| Database & indexer schema stamps | 14-digit migration stamp | `src/constants.ts` (`SCHEMA_VERSIONS`, `getVersionMismatch`) |
| Persisted record schemas | semantic (`0.9.0`, `1.0.0`) | `src/schemas/recordCompatibility.ts` |

## Versioned API responses

Every core response is validated against a strict Zod schema during tests.
Breaking changes must fail contract tests before they reach consumers.

```json
{
  "schemaVersion": "1.0.0",
  "data": { },
  "error": null,
  "meta": { "requestId": "…", "generatedAt": "…" }
}
```

- **MAJOR** — breaking changes (added/renamed/removed/retyped fields).
  Consumers must opt in to a new major version.
- **MINOR** — backward-compatible additions (new optional fields).
- **PATCH** — documentation or non-shape clarifications.

The current supported major version is `1.0.0`. Response contracts live in
`backend/src/contracts/apiContract.ts` and are exercised by
`backend/tests/apiContract.spec.ts`; documented examples live in
`backend/docs/API_RESPONSES.md`.

### Schema version negotiation

`GET /schema-version` reports the database and indexer stamps a deployment is
running (current, expected, and the supported window). Clients may pin a record
schema version to check support:

```bash
GET /schema-version                  # always OK — latest shape
GET /schema-version?schema_version=0.9.0   # 200 — still supported
GET /schema-version?schema_version=0.1.0   # 400 UNSUPPORTED_SCHEMA_VERSION
```

Responses are always the **latest** shape: the API evolves additively, so
supported clients (old or new) read one contract and must ignore unknown
fields. The negotiation check only fails versions this build cannot interpret
at all — see `negotiateSchemaVersion()` in
`src/schemas/recordCompatibility.ts`.

### Database / indexer stamps

`SCHEMA_VERSIONS` in `src/constants.ts` uses the 14-digit Prisma migration
prefix as a single coordinate system for the database and the indexer:

- `DATABASE` / `INDEXER` — stamps this build expects.
- `OLDEST` — oldest stamp this build can still serve; anything older must be
  migrated before deploying.
- `SUPPORTED_DATABASE_VERSIONS` / `SUPPORTED_INDEXER_VERSIONS` — the stamps
  inside the supported window that are published through `GET /schema-version`.
  Compatibility itself is a range check (`getVersionMismatch`), so a stamp
  inside the window is compatible even when it is not enumerated.

`GET /schema-version/validate` (and `scripts/validate-deployment.ts`) run the
preflight check and return `409` with a per-stamp issue list when the database
or the indexer is outside the window.

## Record schemas and the compatibility layer

Persisted records carry a `schemaVersion`. The compatibility layer in
`src/schemas/recordCompatibility.ts` is the **only** code allowed to transform
them:

| Version | Status | Notes |
| --- | --- | --- |
| `1.0.0` | current | Written by this build. `schemaVersion` is always stamped on write. |
| `0.9.0` | readable | Upgraded on read/write: `owner` → `ownerAddress`, `prizePoolId` required, `commission` dropped. |
| anything else | rejected | `UnsupportedSchemaVersionError` (`UNSUPPORTED_SCHEMA_VERSION`). Never coerced. |

Records persisted **before** versioning existed have no `schemaVersion` metadata;
they are read as `0.9.0` (`DEFAULT_LEGACY_SCHEMA_VERSION`) with a warning, so no
backfill migration is required to keep them readable.

### Read path — old records stay readable

```ts
import { readVaultRecord } from "../schemas/recordCompatibility.js";

const { record, sourceVersion, migrated, warnings } = readVaultRecord(row);
// record is always the current shape; record.migratedFrom remembers provenance
```

### Write path — storage only ever contains the latest shape

```ts
import { writeVaultRecord } from "../schemas/recordCompatibility.js";

const { record, warnings } = writeVaultRecord(input);
// deprecated fields dropped, schemaVersion stamped to RECORD_SCHEMA_VERSION
```

Both functions throw:

- `UnsupportedSchemaVersionError` — declared version outside the supported
  window (rollout guard).
- `RecordCompatibilityError` — valid version, invalid record; `issues` lists
  the failing fields (e.g. `prizePoolId: Required`).

### Version metadata inventory

Where a version must be present:

| Location | Field | Value |
| --- | --- | --- |
| Persisted records | `schemaVersion` | `RECORD_SCHEMA_VERSION` (`1.0.0`) |
| Export bundle (`GET /exports`) | `metadata.schema_version` | `EXPORT_SCHEMA_VERSION` |
| Import request (`POST /imports/saved-pools`) | `format_version` | `IMPORT_FORMAT_VERSION` |
| Response contracts | `CONTRACT_VERSIONS` | semver per contract |
| Deployment preflight | `SCHEMA_VERSIONS` | migration stamps |

## Contract and compatibility testing

Contract tests validate recorded fixtures against the current schemas:

```bash
cd backend
npx vitest run tests/apiContract.spec.ts          # response contracts
npx vitest run tests/legacyRecordMigration.spec.ts # record compatibility layer
npx vitest run tests/schemaVersionService.spec.ts  # stamps + preflight check
```

Record fixtures live in `backend/tests/fixtures/legacy-records/` and are named
after the scenario they cover (`clean-legacy-record.json`,
`missing-field.json`, `deprecated-field.json`,
`incompatible-legacy-record.json`). Their provenance is documented in that
directory's README. `tests/legacyRecordMigration.spec.ts` asserts:

- **legacy record reads** — a `0.9.0` fixture reads successfully and is
  upgraded to the current shape; records without metadata read as `0.9.0`.
- **new writes** — writes are stamped with `1.0.0`, round-trip unchanged, and
  never leak deprecated fields.
- **unsupported versions** — `0.1.0` / `2.0.0` are rejected with
  `UNSUPPORTED_SCHEMA_VERSION`, never silently coerced.

The suite fails when:

- A response is missing `data`, `error`, or `meta`.
- A field is removed or changes type without a major version bump.
- A new required field is added without a major version bump.
- A record fixture can no longer be read, or a write stops stamping its version.

## Deprecation rules

1. A deprecated record field is added to `DEPRECATED_RECORD_FIELDS` in
   `src/schemas/recordCompatibility.ts` and documented in the table above.
2. Deprecated fields are **accepted but ignored** on the write path and dropped
   with a warning; they never appear on the read path's current shape.
3. Deprecated fields remain readable for at least one minor release before
   removal. Removing one requires a major version bump (a new entry in
   `SUPPORTED_RECORD_SCHEMA_VERSIONS` is *not* created — the old reader is
   dropped instead) and a migration note in this document.
4. Deprecated response contracts are registered in `DEPRECATED_CONTRACTS`
   (`src/contracts/apiContract.ts`) with a `replacedBy` contract and a sunset
   date; see `backend/docs/API_RESPONSES.md`.
5. Consumers must ignore unknown fields and must not rely on field ordering.

## Migration strategy

- **Lazy upgrade.** Records are upgraded in place the first time they pass
  through the compatibility layer (`readVaultRecord` / `writeVaultRecord`).
  `migratedFrom` records the source version. No batch backfill is required.
- **Optional backfill.** To materialise the upgrade, run a one-off script that
  reads with `readVaultRecord` and writes with `writeVaultRecord`; the transform
  is idempotent, so re-running it is safe.
- **Rollout order.** Deploy the build that *understands* both versions before
  writing the new version anywhere. `SCHEMA_VERSIONS.OLDEST` /
  `getVersionMismatch` blocks a deployment whose database or indexer is
  outside the supported window.
- **Unsupported versions.** A record/request declaring an unknown version is
  rejected loudly (`UNSUPPORTED_SCHEMA_VERSION`). This is intentional: silently
  guessing a shape is how data corruption starts.

## Change checklist

When changing a core response or record schema:

1. Update the Zod schema in `src/schemas/` (or `src/contracts/apiContract.ts`).
2. Bump the version per the rules above and update `RECORD_SCHEMA_VERSION`,
   `SCHEMA_VERSIONS`, or `CONTRACT_VERSIONS` as applicable.
3. Add or update a fixture in `backend/tests/fixtures/legacy-records/`.
4. Run the three vitest commands listed under *Contract and compatibility
   testing*.
5. Update this document if the version, deprecation status, or migration steps
   change.
6. Note any migration steps in the pull request description.
