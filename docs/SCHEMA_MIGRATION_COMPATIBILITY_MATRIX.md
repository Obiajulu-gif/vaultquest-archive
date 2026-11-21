# Schema Migration Compatibility Matrix and Fixtures

## Overview
`src/lib/schema-migration-matrix.mjs` and `tests/fixtures/schema-migration-matrix.fixtures.json` provide a focused vertical slice for evaluating schema migration compatibility and running deterministic fixture verification across record and storage schema transitions.

It builds directly on `src/lib/schema-compatibility.mjs` without altering any existing contracts (`readVersionedRecord`, `writeVersionedRecord`, `checkStorageSchemaCompatibility`, `authorizeSchemaOperation`).

## Compatibility Matrix

### Record Schema Transitions
| From | To | Compatible | Direction | Additive Only | Rollback Safe | Rollback Strategy |
| --- | --- | --- | --- | --- | --- | --- |
| `0.9.0` | `1.0.0` | Yes | `upgrade` | Yes | Yes | `preserve-source-snapshot-and-restore-currency-field` |
| `1.0.0` | `1.0.0` | Yes | `noop` | Yes | Yes | `noop` |
| `1.0.0` | `0.9.0` | No | `downgrade` | No | No | `restore-from-pre-migration-backup` |

### Storage Schema Window Transitions
Storage migration stamps are evaluated via `checkStorageSchemaCompatibility` against `DEFAULT_STORAGE_SCHEMA_WINDOW`:
- Forward transitions (`next > current`) within the supported window are `compatible: true` (`upgrade`) with rollback strategy `expand-contract-keep-old-columns-until-window-closes`.
- Same-version transitions (`next === current`) are `compatible: true` (`noop`).
- Downgrades (`next < current`) are rejected (`compatible: false`, `downgrade`) and require `restore-point-in-time-snapshot`.

## Authorization
- **Matrix inspection (`read` / `negotiate`)**: Allowed for `user`, `operator`, and `admin` roles (or `schema:read` scope).
- **Migration execution (`migrate`)**: Restricted to `operator` and `admin` roles (or `schema:migrate` scope). Unauthorized or unauthenticated actors fail closed with `SchemaAuthorizationError` (`SCHEMA_UNAUTHORIZED`, HTTP 403).

## Edge Cases, Failure, Retry & Rollback Behavior
- **Unsupported versions**: Any version outside `SUPPORTED_RECORD_SCHEMA_VERSIONS` throws `UnsupportedSchemaVersionError` (`UNSUPPORTED_SCHEMA_VERSION`, HTTP 400).
- **Blocked downgrades**: `1.0.0 -> 0.9.0` throws `MigrationCompatibilityError` (`MIGRATION_INCOMPATIBLE`, HTTP 409) before mutating state.
- **Invalid payloads**: Invalid fields (e.g. negative `amount`) throw `RecordCompatibilityError` (`RECORD_SCHEMA_INVALID`, HTTP 422).
- **Transient failures & retry**: `executeMigrationFixture` retries `retryable: true` persistence failures up to `maxRetries`.
- **Exhausted retries & rollback**: When retries are exhausted (or a non-retryable persistence error occurs), `rollbackFn` is invoked with the original pre-migration input and the matrix's `rollbackStrategy`, returning `status: "rolled_back"`.

## Automated Verification
Run both the new matrix fixture suite and the existing schema compatibility suite:
```bash
node --test tests/backend/schema-migration-matrix.test.mjs tests/backend/schema-compatibility.test.mjs
```
