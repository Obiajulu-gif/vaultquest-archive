import {
  DEFAULT_STORAGE_SCHEMA_WINDOW,
  RECORD_SCHEMA_VERSION,
  SUPPORTED_RECORD_SCHEMA_VERSIONS,
  SchemaAuthorizationError,
  UnsupportedSchemaVersionError,
  authorizeSchemaOperation,
  checkStorageSchemaCompatibility,
  readVersionedRecord,
} from "./schema-compatibility.mjs";

export class MigrationCompatibilityError extends Error {
  constructor(message, { fromVersion, toVersion, reason } = {}) {
    super(message);
    this.name = "MigrationCompatibilityError";
    this.code = "MIGRATION_INCOMPATIBLE";
    this.statusCode = 409;
    this.fromVersion = fromVersion;
    this.toVersion = toVersion;
    this.reason = reason;
  }
}

/**
 * Canonical schema migration compatibility matrix for versioned records.
 * Preserves existing 0.9.0 -> 1.0.0 additive upgrade guarantees and documents
 * rollback behavior for each transition.
 */
export const RECORD_MIGRATION_MATRIX = Object.freeze([
  Object.freeze({
    fromVersion: "0.9.0",
    toVersion: "1.0.0",
    compatible: true,
    direction: "upgrade",
    additiveOnly: true,
    rollbackSafe: true,
    requiresBackfill: false,
    rollbackStrategy: "preserve-source-snapshot-and-restore-currency-field",
    notes: "Maps legacy currency -> asset, normalizes amount to string, strips deprecated commission.",
  }),
  Object.freeze({
    fromVersion: "1.0.0",
    toVersion: "1.0.0",
    compatible: true,
    direction: "noop",
    additiveOnly: true,
    rollbackSafe: true,
    requiresBackfill: false,
    rollbackStrategy: "noop",
    notes: "Idempotent validation pass for current schema version.",
  }),
  Object.freeze({
    fromVersion: "1.0.0",
    toVersion: "0.9.0",
    compatible: false,
    direction: "downgrade",
    additiveOnly: false,
    rollbackSafe: false,
    requiresBackfill: false,
    rollbackStrategy: "restore-from-pre-migration-backup",
    notes: "Direct in-place downgrade is blocked to prevent silent field loss; restore from snapshot instead.",
  }),
]);

/**
 * Evaluate compatibility for a record or storage schema migration transition.
 */
export function evaluateMigrationCompatibility(
  fromVersion,
  toVersion,
  {
    actor = { id: "system", role: "admin" },
    kind = "record",
    operation = "read",
    storageWindow = DEFAULT_STORAGE_SCHEMA_WINDOW,
  } = {},
) {
  authorizeSchemaOperation(actor, operation);

  if (kind === "storage") {
    const compat = checkStorageSchemaCompatibility(fromVersion, toVersion, storageWindow);
    let direction = "noop";
    if (String(toVersion) > String(fromVersion)) {
      direction = "upgrade";
    } else if (String(toVersion) < String(fromVersion)) {
      direction = "downgrade";
    }
    return {
      kind: "storage",
      fromVersion: String(fromVersion),
      toVersion: String(toVersion),
      compatible: compat.compatible,
      direction,
      rollbackSafe: compat.backwardsCompatible,
      rollbackStrategy:
        direction === "upgrade"
          ? "expand-contract-keep-old-columns-until-window-closes"
          : direction === "noop"
            ? "noop"
            : "restore-point-in-time-snapshot",
      details: compat,
    };
  }

  const from = String(fromVersion);
  const to = String(toVersion);

  if (!SUPPORTED_RECORD_SCHEMA_VERSIONS.includes(from)) {
    throw new UnsupportedSchemaVersionError(from, SUPPORTED_RECORD_SCHEMA_VERSIONS);
  }
  if (!SUPPORTED_RECORD_SCHEMA_VERSIONS.includes(to)) {
    throw new UnsupportedSchemaVersionError(to, SUPPORTED_RECORD_SCHEMA_VERSIONS);
  }

  const entry = RECORD_MIGRATION_MATRIX.find(
    (row) => row.fromVersion === from && row.toVersion === to,
  );

  if (!entry) {
    return {
      kind: "record",
      fromVersion: from,
      toVersion: to,
      compatible: false,
      direction: "unsupported",
      additiveOnly: false,
      rollbackSafe: false,
      requiresBackfill: false,
      rollbackStrategy: "manual-intervention-required",
      notes: `No matrix entry defined for ${from} -> ${to}.`,
    };
  }

  return {
    kind: "record",
    ...entry,
  };
}

/**
 * Execute a migration fixture with retry and rollback support.
 * - Requires `migrate` authorization (operator/admin or `schema:migrate` scope).
 * - Rejects incompatible matrix transitions before mutating state.
 * - Retries transient (`retryable: true`) persistence errors up to `maxRetries`.
 * - Invokes `rollbackFn` if retries are exhausted so partial state is recovered cleanly.
 */
export async function executeMigrationFixture({
  fixture,
  actor,
  persistFn,
  rollbackFn = async () => {},
  maxRetries = 2,
}) {
  authorizeSchemaOperation(actor, "migrate");

  if (!fixture || typeof fixture !== "object") {
    throw new MigrationCompatibilityError("fixture must be an object", {
      reason: "invalid-fixture",
    });
  }

  const fromVersion = fixture.fromVersion ?? fixture.input?.schemaVersion ?? "0.9.0";
  const toVersion = fixture.toVersion ?? RECORD_SCHEMA_VERSION;

  const verdict = evaluateMigrationCompatibility(fromVersion, toVersion, {
    actor,
    kind: "record",
    operation: "migrate",
  });

  if (!verdict.compatible) {
    throw new MigrationCompatibilityError(
      `Migration from ${fromVersion} to ${toVersion} is not compatible (${verdict.direction}).`,
      { fromVersion, toVersion, reason: verdict.direction },
    );
  }

  const { record, warnings, sourceVersion, targetVersion } = readVersionedRecord(fixture.input, {
    actor,
  });

  let attempts = 0;
  let lastError = null;
  const retryLimit = Number.isInteger(fixture.maxRetries) ? fixture.maxRetries : maxRetries;

  while (attempts <= retryLimit) {
    attempts += 1;
    try {
      if (typeof persistFn === "function") {
        await persistFn(record, { attempt: attempts, verdict });
      }
      return {
        status: "migrated",
        attempts,
        sourceVersion,
        targetVersion,
        record,
        warnings,
        verdict,
      };
    } catch (err) {
      lastError = err;
      const retryable = Boolean(err && err.retryable);
      if (!retryable || attempts > retryLimit) {
        await rollbackFn(fixture.input, {
          reason: lastError?.message || "migration persistence failed",
          attempts,
          strategy: verdict.rollbackStrategy,
        });
        return {
          status: "rolled_back",
          attempts,
          sourceVersion,
          targetVersion,
          error: lastError?.message || String(lastError),
          rollbackStrategy: verdict.rollbackStrategy,
          verdict,
        };
      }
    }
  }

  throw new SchemaAuthorizationError("Unreachable migration state.");
}
