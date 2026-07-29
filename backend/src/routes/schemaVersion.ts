import type { FastifyPluginAsync } from "fastify";
import type { SchemaVersionService } from "../services/schemaVersionService.js";
import { ok } from "../responses.js";

/**
 * Routes for schema version validation
 */
export const schemaVersionRoutes = (svc: SchemaVersionService): FastifyPluginAsync =>
  async (app) => {
    /**
     * GET /schema-version - Get current schema versions
     */
    app.get("/schema-version", async () => {
      const versionInfo = await svc.getVersionInfo();
      return ok(versionInfo);
    });

    /**
     * GET /schema-version/validate - Validate schema compatibility
     * Used for deployment preflight checks
     */
    app.get("/schema-version/validate", async (req, reply) => {
      const validation = await svc.validateSchemaVersions();
      
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
