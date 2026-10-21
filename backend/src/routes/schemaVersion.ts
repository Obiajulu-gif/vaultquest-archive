import type { FastifyPluginAsync } from "fastify";
import type { SchemaVersionService } from "../services/schemaVersionService.js";
import { ok } from "../responses.js";
import {
  RECORD_SCHEMA_VERSION,
  SUPPORTED_RECORD_SCHEMA_VERSIONS,
  UnsupportedSchemaVersionError,
  negotiateSchemaVersion,
} from "../schemas/recordCompatibility.js";

/**
 * Versioned API response contracts for VaultQuest contributor integrations.
 *
 * Versioning rules:
 * - Additive changes (new optional fields, new endpoints) are backward-compatible
 *   and bump the minor version.
 * - Removing fields, changing field types, or changing semantics is a breaking
 *   change and bumps the major version.
 * - Deprecated fields must be documented and retained for at least one major
 *   version before removal.
 *
 * Deprecation rules:
 * - Mark deprecated fields with `deprecated: true` and a `sunset` date in the
 *   schema metadata.
 * - Consumers should migrate before the sunset date; validation will fail for
 *   responses that violate the active contract.
 */
export const SCHEMA_VERSION = "1.0.0";

export interface SchemaVersionInfo {
  version: string;
  deprecated: boolean;
  sunset?: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  version: string;
  errors: string[];
}

/**
 * Validate a response payload against the documented schema contract.
 * Returns a list of human-readable errors for any violations.
 */
export const validateResponseContract = (
  payload: unknown,
  requiredFields: string[] = [],
): SchemaValidationResult => {
  const errors: string[] = [];

  if (payload === null || typeof payload !== "object") {
    errors.push("Response payload must be a non-null object");
    return { valid: false, version: SCHEMA_VERSION, errors };
  }

  const record = payload as Record<string, unknown>;
  for (const field of requiredFields) {
    if (!(field in record)) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  return { valid: errors.length === 0, version: SCHEMA_VERSION, errors };
};

/**
 * Routes for schema version validation
 */
export const schemaVersionRoutes = (svc: SchemaVersionService): FastifyPluginAsync =>
  async (app) => {
    /**
     * GET /schema-version - Get current schema versions
     *
     * Optional `?schema_version=<semver>` lets a client check whether a record
     * schema version is still supported (#803). Supported versions resolve to
     * the same 200 payload: responses are always the latest shape, so old and
     * new clients read one contract. Unknown versions fail fast with 400
     * instead of silently reading a shape the client cannot interpret.
     */
    app.get("/schema-version", async (req, reply) => {
      const requested = (req.query as { schema_version?: string } | undefined)?.schema_version;
      try {
        negotiateSchemaVersion(requested ?? null);
      } catch (error) {
        if (error instanceof UnsupportedSchemaVersionError) {
          reply.status(400);
          return {
            ok: false,
            error: error.message,
            data: {
              code: error.code,
              requested: requested ?? null,
              served: RECORD_SCHEMA_VERSION,
              supported: SUPPORTED_RECORD_SCHEMA_VERSIONS,
            },
          };
        }
        throw error;
      }

      const versionInfo = await svc.getVersionInfo();
      const contract = validateResponseContract(versionInfo, ["version"]);

      if (!contract.valid) {
        return {
          ok: false,
          error: "Schema version response violates contract",
          data: contract,
        };
      }

      return ok({ ...versionInfo, contractVersion: SCHEMA_VERSION });
    });

    /**
     * GET /schema-version/validate - Validate schema compatibility
     * Used for deployment preflight checks
     */
    app.get("/schema-version/validate", async (req, reply) => {
      const validation = await svc.validateSchemaVersions();
      const contract = validateResponseContract(validation, ["valid"]);

      if (!contract.valid) {
        reply.status(500);
        return {
          ok: false,
          error: "Schema validation response violates contract",
          data: contract,
        };
      }

      if (!validation.valid) {
        reply.status(409); // Conflict
        return {
          ok: false,
          error: "Schema version mismatch",
          data: validation,
        };
      }
      
      return ok(validation);
    });
  };
