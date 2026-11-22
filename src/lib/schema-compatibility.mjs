export const RECORD_SCHEMA_VERSION = "1.0.0";
export const SUPPORTED_RECORD_SCHEMA_VERSIONS = ["0.9.0", "1.0.0"];
export const DEFAULT_LEGACY_SCHEMA_VERSION = "0.9.0";
export const DEPRECATED_RECORD_FIELDS = ["commission"];

export const DEFAULT_STORAGE_SCHEMA_WINDOW = {
  database: "20261015000000",
  oldest: "20250101000000",
  supportedDatabaseVersions: [
    "20250101000000",
    "20250601000000",
    "20260101000000",
    "20261015000000",
  ],
};

export class UnsupportedSchemaVersionError extends Error {
  constructor(version, supported = SUPPORTED_RECORD_SCHEMA_VERSIONS) {
    super(
      `incompatible schema version: ${version} (supported: ${supported.join(", ")})`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.code = "UNSUPPORTED_SCHEMA_VERSION";
    this.version = version;
    this.statusCode = 400;
  }
}

export class RecordCompatibilityError extends Error {
  constructor(issues) {
    super(`record failed schema validation: ${issues.join("; ")}`);
    this.name = "RecordCompatibilityError";
    this.code = "RECORD_SCHEMA_INVALID";
    this.issues = issues;
    this.statusCode = 422;
  }
}

export class SchemaAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaAuthorizationError";
    this.code = "SCHEMA_UNAUTHORIZED";
    this.statusCode = 403;
  }
}

const READ_ROLES = new Set(["user", "operator", "admin"]);
const WRITE_ROLES = new Set(["operator", "admin"]);

/**
 * Authorize schema compatibility operations.
 * - `read` and `negotiate` are permitted for `user`, `operator`, and `admin`.
 * - `write` and `migrate` require `operator` or `admin` (or explicit `schema:migrate`).
 */
export function authorizeSchemaOperation(actor, operation = "read") {
  if (!actor || typeof actor.id !== "string" || !actor.id.trim()) {
    throw new SchemaAuthorizationError("Authenticated actor is required for schema operations.");
  }

  const role = typeof actor.role === "string" ? actor.role.toLowerCase() : "";
  const scopes = new Set(Array.isArray(actor.scopes) ? actor.scopes : []);

  if (operation === "read" || operation === "negotiate") {
    if (!READ_ROLES.has(role) && !scopes.has("schema:read")) {
      throw new SchemaAuthorizationError(`Actor ${actor.id} cannot read versioned records.`);
    }
    return true;
  }

  if (operation === "write" || operation === "migrate") {
    if (!WRITE_ROLES.has(role) && !scopes.has("schema:migrate")) {
      throw new SchemaAuthorizationError(
        `Actor ${actor.id} with role '${role || "none"}' is not authorized for schema '${operation}'.`,
      );
    }
    return true;
  }

  throw new SchemaAuthorizationError(`Unknown schema operation '${operation}'.`);
}

function validateBaseFields(record, issues) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    issues.push("record must be a plain object");
    return;
  }
  if (typeof record.id !== "string" || !record.id.trim()) {
    issues.push("id must be a non-empty string");
  }
  if (typeof record.vaultId !== "string" || !record.vaultId.trim()) {
    issues.push("vaultId must be a non-empty string");
  }
  if (typeof record.amount !== "string" && typeof record.amount !== "number") {
    issues.push("amount must be a numeric string or number");
  } else if (Number.isNaN(Number(record.amount)) || Number(record.amount) < 0) {
    issues.push("amount must be a non-negative number");
  }
}

/**
 * Read a versioned (or pre-versioning 0.9.0 legacy) record and upgrade it to 1.0.0.
 */
export function readVersionedRecord(raw, { actor = { id: "system", role: "admin" } } = {}) {
  authorizeSchemaOperation(actor, "read");

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RecordCompatibilityError(["record must be a plain object"]);
  }

  const declaredVersion =
    raw.schemaVersion === undefined || raw.schemaVersion === null
      ? DEFAULT_LEGACY_SCHEMA_VERSION
      : String(raw.schemaVersion);

  if (!SUPPORTED_RECORD_SCHEMA_VERSIONS.includes(declaredVersion)) {
    throw new UnsupportedSchemaVersionError(declaredVersion);
  }

  const issues = [];
  validateBaseFields(raw, issues);

  if (declaredVersion === "1.0.0") {
    if (typeof raw.asset !== "string" || !raw.asset.trim()) {
      issues.push("asset is required for schemaVersion 1.0.0");
    }
  }

  if (issues.length > 0) {
    throw new RecordCompatibilityError(issues);
  }

  const warnings = [];
  const migrated = { ...raw };

  for (const field of DEPRECATED_RECORD_FIELDS) {
    if (field in migrated) {
      warnings.push(`deprecated field '${field}' removed during read`);
      delete migrated[field];
    }
  }

  // Upgrade 0.9.0 -> 1.0.0 defaults
  if (declaredVersion === "0.9.0") {
    if (!migrated.asset) {
      migrated.asset = migrated.currency ?? "USDC";
    }
    delete migrated.currency;
    migrated.migratedFrom = "0.9.0";
  }

  migrated.amount = String(migrated.amount);
  migrated.schemaVersion = RECORD_SCHEMA_VERSION;

  return {
    record: migrated,
    sourceVersion: declaredVersion,
    targetVersion: RECORD_SCHEMA_VERSION,
    warnings,
  };
}

/**
 * Validate and normalize an incoming client record, stamping the latest schemaVersion.
 */
export function writeVersionedRecord(input, { actor } = {}) {
  authorizeSchemaOperation(actor, "write");
  const { record, warnings } = readVersionedRecord(input, { actor });
  delete record.migratedFrom;
  record.schemaVersion = RECORD_SCHEMA_VERSION;
  return {
    record,
    warnings,
  };
}

/**
 * Negotiate API schema version for a caller.
 */
export function negotiateSchemaVersion(requestedVersion, { actor = { id: "system", role: "user" } } = {}) {
  authorizeSchemaOperation(actor, "negotiate");
  const version = requestedVersion ? String(requestedVersion) : RECORD_SCHEMA_VERSION;
  if (!SUPPORTED_RECORD_SCHEMA_VERSIONS.includes(version)) {
    throw new UnsupportedSchemaVersionError(version);
  }
  return {
    requestedVersion: version,
    negotiatedVersion: RECORD_SCHEMA_VERSION,
    additiveOnly: true,
    deprecatedFields: [...DEPRECATED_RECORD_FIELDS],
  };
}

/**
 * Storage schema window compatibility check (forwards & backwards).
 */
export function checkStorageSchemaCompatibility(
  current,
  next,
  window = DEFAULT_STORAGE_SCHEMA_WINDOW,
) {
  const issues = [];
  const stamps = window.supportedDatabaseVersions ?? [];
  let wellFormed = true;
  for (let i = 1; i < stamps.length; i++) {
    if (stamps[i - 1] >= stamps[i]) {
      wellFormed = false;
      issues.push(
        `storage schema window is not strictly ascending at ${stamps[i - 1]} -> ${stamps[i]}`,
      );
      break;
    }
  }

  const known = new Set(stamps);
  if (!known.has(current)) {
    issues.push(`current storage schema '${current}' is not in supported window`);
  }
  if (!known.has(next)) {
    issues.push(`next storage schema '${next}' is not in supported window`);
  }
  if (current < window.oldest) {
    issues.push(`current storage schema '${current}' is older than oldest supported '${window.oldest}'`);
  }
  if (next < current) {
    issues.push(`downgrade from '${current}' to '${next}' is prohibited`);
  }

  const forwardsCompatible = wellFormed && known.has(current) && known.has(next) && current <= next;
  const backwardsCompatible = wellFormed && known.has(current) && known.has(next) && next <= window.database;

  if (!backwardsCompatible && known.has(next) && next > window.database) {
    issues.push(`next storage schema '${next}' exceeds build database schema '${window.database}'`);
  }

  return {
    compatible: wellFormed && issues.length === 0 && forwardsCompatible && backwardsCompatible,
    current,
    next,
    forwardsCompatible,
    backwardsCompatible,
    issues,
  };
}

/**
 * Migrate a batch of stored records with retry handling for transient persistence errors.
 */
export async function migrateVersionedRecordsBatch({
  records,
  actor,
  persistFn,
  maxRetries = 2,
}) {
  authorizeSchemaOperation(actor, "migrate");

  const migrated = [];
  const failed = [];

  for (const raw of records) {
    let upgraded;
    try {
      upgraded = readVersionedRecord(raw, { actor });
    } catch (err) {
      failed.push({
        id: raw?.id ?? "unknown",
        code: err.code ?? "MIGRATION_VALIDATION_FAILED",
        message: err.message,
        retryable: false,
      });
      continue;
    }

    let attempt = 0;
    let persisted = false;
    while (!persisted) {
      try {
        await persistFn(upgraded.record);
        migrated.push(upgraded.record);
        persisted = true;
      } catch (err) {
        if (err?.retryable && attempt < maxRetries) {
          attempt += 1;
          continue;
        }
        failed.push({
          id: upgraded.record.id,
          code: err?.code ?? "PERSISTENCE_FAILED",
          message: err?.message ?? String(err),
          retryable: Boolean(err?.retryable),
          attempts: attempt + 1,
        });
        break;
      }
    }
  }

  return {
    migratedCount: migrated.length,
    failedCount: failed.length,
    migrated,
    failed,
  };
}
