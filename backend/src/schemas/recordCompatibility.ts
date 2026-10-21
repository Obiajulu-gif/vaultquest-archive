import { z } from "zod";

/**
 * #803 — compatibility layer for versioned record schemas.
 *
 * VaultQuest persists domain records (vault accounting, prize draws, wallet
 * flows) that were written by several generations of clients. This module is
 * the single place that knows how those generations relate:
 *
 * - **Version metadata.** Every record carries a `schemaVersion`. Records
 *   written before versioning existed have no metadata; they are treated as
 *   the `0.9.0` baseline (see {@link DEFAULT_LEGACY_SCHEMA_VERSION}).
 * - **Read path.** {@link readVaultRecord} accepts any *supported* stored
 *   record and returns the current shape, applying the documented transform
 *   for its version. Old records stay readable after schema changes.
 * - **Write path.** {@link writeVaultRecord} accepts input from any supported
 *   client generation, drops deprecated fields, and stamps the latest version
 *   before the record is persisted. New storage only ever contains the latest
 *   shape.
 * - **API negotiation.** {@link negotiateSchemaVersion} lets a caller ask which
 *   schema version it may speak. Responses are always the latest shape
 *   (additive-only evolution — clients must ignore unknown fields); the check
 *   only rejects versions this build does not understand at all.
 *
 * Errors are typed so HTTP/routes and background jobs can map them without
 * string matching:
 * - {@link UnsupportedSchemaVersionError} — version outside the supported
 *   window (rollout guard; never silently coerced).
 * - {@link RecordCompatibilityError} — record is a supported version but does
 *   not validate against that version's schema (e.g. a required field is
 *   missing).
 *
 * Deprecation policy: a field is deprecated for at least one minor release
 * before removal. While deprecated it is still *accepted* on the write path and
 * dropped with a warning, and it never appears on the current shape returned by
 * the read path. See `backend/docs/SCHEMA_VERSIONS.md`.
 */

/** The record schema this build reads and writes. */
export const RECORD_SCHEMA_VERSION = "1.0.0";

/**
 * Older record versions this build can still read and upgrade. Anything else
 * is rejected with {@link UnsupportedSchemaVersionError}.
 */
export const SUPPORTED_RECORD_SCHEMA_VERSIONS = ["0.9.0", "1.0.0"] as const;
export type SupportedRecordSchemaVersion = (typeof SUPPORTED_RECORD_SCHEMA_VERSIONS)[number];

/**
 * Version assumed for records persisted before `schemaVersion` metadata was
 * added. Keeps pre-versioning rows readable without a backfill migration.
 */
export const DEFAULT_LEGACY_SCHEMA_VERSION = "0.9.0";

/** Record fields that are accepted but no longer part of the current shape. */
export const DEPRECATED_RECORD_FIELDS = ["commission"] as const;

/** Thrown when a record/request declares a schema version outside the window. */
export class UnsupportedSchemaVersionError extends Error {
  readonly code = "UNSUPPORTED_SCHEMA_VERSION";
  readonly version: string;

  constructor(version: string) {
    super(
      `incompatible schema version: ${version} (supported: ${SUPPORTED_RECORD_SCHEMA_VERSIONS.join(", ")})`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.version = version;
  }
}

/** Thrown when a supported-version record fails its version's validation. */
export class RecordCompatibilityError extends Error {
  readonly code = "RECORD_SCHEMA_INVALID";
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`record failed schema validation: ${issues.join("; ")}`);
    this.name = "RecordCompatibilityError";
    this.issues = issues;
  }
}

const nonEmpty = z.string().min(1);
/** Amounts are decimal integer strings (base units); never floats. */
const amountString = z.string().regex(/^\d+$/, "must be a decimal integer string");

/**
 * Legacy record as stored by the `0.9.0` generation.
 *
 * Differences from the current shape (the migration contract):
 * - `owner` was renamed to `ownerAddress`.
 * - `prizePoolId` is required (it was optional in a short-lived 0.9.x rollout;
 *   rows without it cannot be linked to a prize pool and are rejected).
 * - `commission` is deprecated: accepted on writes, dropped with a warning.
 */
export const legacyVaultRecord090 = z.object({
  schemaVersion: z.literal("0.9.0"),
  id: nonEmpty,
  owner: nonEmpty,
  asset: nonEmpty,
  balance: amountString,
  prizePoolId: nonEmpty,
  commission: z.string().optional(),
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
});

/**
 * Current record shape (`1.0.0`). `migratedFrom` records provenance when a
 * legacy record was upgraded in place; it is absent on records written natively
 * at the current version.
 */
export const vaultRecord100 = z.object({
  schemaVersion: z.literal("1.0.0"),
  id: nonEmpty,
  ownerAddress: nonEmpty,
  asset: nonEmpty,
  balance: amountString,
  prizePoolId: nonEmpty,
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
  migratedFrom: z.string().optional(),
});

export type VaultRecord = z.infer<typeof vaultRecord100>;
export type LegacyVaultRecord090 = z.infer<typeof legacyVaultRecord090>;

/** Outcome of a read/write transform through the compatibility layer. */
export interface RecordTransformResult {
  /** The record in the current shape, ready for storage or serialization. */
  record: VaultRecord;
  /** The version the source record/input declared (or the assumed default). */
  sourceVersion: string;
  /** True when a version transform actually ran. */
  migrated: boolean;
  /** Non-fatal notes: assumed version, dropped deprecated fields, … */
  warnings: string[];
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.join(".") || "record"}: ${issue.message}`,
  );
}

export function isSupportedRecordVersion(version: string): boolean {
  return (SUPPORTED_RECORD_SCHEMA_VERSIONS as readonly string[]).includes(version);
}

/** Throws {@link UnsupportedSchemaVersionError} for versions outside the window. */
export function assertSupportedRecordVersion(version: string): void {
  if (!isSupportedRecordVersion(version)) throw new UnsupportedSchemaVersionError(version);
}

function assertObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RecordCompatibilityError(["record is not an object"]);
  }
  return raw as Record<string, unknown>;
}

/**
 * Resolve the version a stored record declares. Missing metadata means the
 * record predates versioning and is read as the legacy baseline.
 */
function declaredVersion(obj: Record<string, unknown>): {
  version: string;
  assumed: boolean;
} {
  const declared = obj.schemaVersion;
  if (declared === undefined || declared === null) {
    return { version: DEFAULT_LEGACY_SCHEMA_VERSION, assumed: true };
  }
  if (typeof declared !== "string") {
    throw new UnsupportedSchemaVersionError(String(declared));
  }
  return { version: declared, assumed: false };
}

function collectWarnings(obj: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const field of DEPRECATED_RECORD_FIELDS) {
    if (field in obj && obj[field] !== undefined) {
      warnings.push(`deprecated field "${field}" is no longer part of the record schema and was dropped`);
    }
  }
  return warnings;
}

function upgradeFrom090(
  legacy: LegacyVaultRecord090,
  sourceVersion: string,
  warnings: string[],
): RecordTransformResult {
  return {
    record: {
      schemaVersion: RECORD_SCHEMA_VERSION,
      id: legacy.id,
      ownerAddress: legacy.owner,
      asset: legacy.asset,
      balance: legacy.balance,
      prizePoolId: legacy.prizePoolId,
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
      migratedFrom: sourceVersion,
    },
    sourceVersion,
    migrated: true,
    warnings,
  };
}

/**
 * Read path: load any supported record (stored or received over the wire) and
 * return it in the current shape.
 *
 * @throws {UnsupportedSchemaVersionError} the declared version is not supported
 * @throws {RecordCompatibilityError} the record does not validate for its version
 */
export function readVaultRecord(raw: unknown): RecordTransformResult {
  const obj = assertObject(raw);
  const { version, assumed } = declaredVersion(obj);
  assertSupportedRecordVersion(version);

  const warnings = collectWarnings(obj);
  if (assumed) {
    warnings.push(
      `record has no schemaVersion metadata; read as ${DEFAULT_LEGACY_SCHEMA_VERSION}`,
    );
  }

  if (version === RECORD_SCHEMA_VERSION) {
    const parsed = vaultRecord100.safeParse(obj);
    if (!parsed.success) throw new RecordCompatibilityError(zodIssues(parsed.error));
    return { record: parsed.data, sourceVersion: version, migrated: false, warnings };
  }

  const parsed = legacyVaultRecord090.safeParse({ ...obj, schemaVersion: version });
  if (!parsed.success) throw new RecordCompatibilityError(zodIssues(parsed.error));
  return upgradeFrom090(parsed.data, version, warnings);
}

/**
 * Write path: normalize input from any supported client generation into the
 * current shape and stamp it with {@link RECORD_SCHEMA_VERSION}.
 *
 * Accepts the current shape (with or without `schemaVersion` — new clients do
 * not have to send it) and legacy `0.9.0` input from older clients. The stored
 * record is always the latest schema.
 *
 * @throws {UnsupportedSchemaVersionError} the declared version is not supported
 * @throws {RecordCompatibilityError} the input does not validate for its version
 */
export function writeVaultRecord(input: unknown): RecordTransformResult {
  const obj = assertObject(input);
  const { version: declared, assumed } = declaredVersion(obj);
  // New clients may omit `schemaVersion` entirely: infer from the shape instead
  // of falling back to the legacy baseline, so a current-shaped write without
  // metadata is not mistaken for a 0.9.0 record.
  const version = assumed
    ? "ownerAddress" in obj
      ? RECORD_SCHEMA_VERSION
      : DEFAULT_LEGACY_SCHEMA_VERSION
    : declared;
  assertSupportedRecordVersion(version);

  const warnings = collectWarnings(obj);
  if (assumed && version !== RECORD_SCHEMA_VERSION) {
    // Current-shaped input without metadata is the normal new-client write:
    // the store stamps the version, so there is nothing to warn about.
    warnings.push(`input has no schemaVersion metadata; assumed ${version}`);
  }

  if (version === RECORD_SCHEMA_VERSION) {
    const parsed = vaultRecord100.safeParse({ ...obj, schemaVersion: RECORD_SCHEMA_VERSION });
    if (!parsed.success) throw new RecordCompatibilityError(zodIssues(parsed.error));
    return {
      record: parsed.data,
      sourceVersion: version,
      migrated: false,
      warnings,
    };
  }

  const parsed = legacyVaultRecord090.safeParse({ ...obj, schemaVersion: version });
  if (!parsed.success) throw new RecordCompatibilityError(zodIssues(parsed.error));
  return upgradeFrom090(parsed.data, version, warnings);
}

/** Result of negotiating a schema version with an API client. */
export interface SchemaNegotiation {
  /** The version the client asked for, or `null` when it asked for the default. */
  requested: string | null;
  /**
   * The version responses are served at. Always {@link RECORD_SCHEMA_VERSION}:
   * the API evolves additively, so every supported client reads the latest
   * shape and must ignore unknown fields.
   */
  served: string;
  /** Every record schema version this build understands. */
  supported: readonly string[];
}

/**
 * API negotiation: validate a client-requested schema version and report what
 * will be served.
 *
 * @throws {UnsupportedSchemaVersionError} for versions outside the window
 */
export function negotiateSchemaVersion(requested?: string | null): SchemaNegotiation {
  const trimmed = requested?.trim() || null;
  if (trimmed !== null) assertSupportedRecordVersion(trimmed);
  return {
    requested: trimmed,
    served: RECORD_SCHEMA_VERSION,
    supported: SUPPORTED_RECORD_SCHEMA_VERSIONS,
  };
}
