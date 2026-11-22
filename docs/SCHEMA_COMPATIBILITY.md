# Schema Compatibility for Versioned Records (#1066)

## Overview
`src/lib/schema-compatibility.mjs` implements a focused vertical slice for versioned record compatibility and storage schema window validation, preserving the contracts in `backend/src/schemas/recordCompatibility.ts` and `backend/src/services/storageSchemaCompatibility.ts`.

## Supported Versions & Deprecation Policy
- **Current version**: `1.0.0` (`RECORD_SCHEMA_VERSION`).
- **Supported versions**: `0.9.0`, `1.0.0` (`SUPPORTED_RECORD_SCHEMA_VERSIONS`). Pre-versioning records without `schemaVersion` default to `0.9.0` (`DEFAULT_LEGACY_SCHEMA_VERSION`).
- **Deprecated fields**: `commission` is accepted on read/write with a warning and stripped from the normalized `1.0.0` output.

## Authorization
- `read` / `negotiate`: Permitted for `user`, `operator`, and `admin` roles (or `schema:read` scope).
- `write` / `migrate`: Restricted to `operator` and `admin` roles (or `schema:migrate` scope). Unauthorized calls throw `SchemaAuthorizationError` (`SCHEMA_UNAUTHORIZED`, HTTP 403).

## Failure, Retry & Migration Safety
- **Unsupported version**: Versions outside `SUPPORTED_RECORD_SCHEMA_VERSIONS` throw `UnsupportedSchemaVersionError` (`UNSUPPORTED_SCHEMA_VERSION`, HTTP 400) — never silently coerced.
- **Validation failure**: Missing or invalid fields throw `RecordCompatibilityError` (`RECORD_SCHEMA_INVALID`, HTTP 422) with structured `issues[]`.
- **Storage window**: `checkStorageSchemaCompatibility(current, next, window)` enforces strictly ascending migration stamps and rejects downgrades (`next < current`).
- **Batch retry**: `migrateVersionedRecordsBatch` retries transient (`retryable: true`) persistence errors up to `maxRetries` per record while isolating permanent validation failures.
