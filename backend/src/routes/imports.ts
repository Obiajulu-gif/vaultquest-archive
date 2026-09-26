import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ok } from "../responses.js";
import { IMPORT_FORMAT_VERSION, IMPORT_MAX_ROWS, type DataImportService } from "../services/dataImport.js";

const importBody = z.object({
  format_version: z.literal(IMPORT_FORMAT_VERSION),
  /** Defaults to a dry run: committing requires an explicit `dry_run: false`. */
  dry_run: z.boolean().default(true),
  records: z.array(z.unknown()).max(IMPORT_MAX_ROWS),
});

/**
 * POST /imports/saved-pools (#773): imports into the caller's own wallet only.
 * Requires `own.data.import`; the wallet is taken from the session, never the body.
 */
export const importsRoutes = (svc: DataImportService, guard: preHandlerHookHandler): FastifyPluginAsync =>
  async (app) => {
    app.post("/imports/saved-pools", { preHandler: [guard] }, async (req) => {
      const body = importBody.parse(req.body);
      const wallet = req.principal?.walletAddress;
      if (!wallet) throw AppError.forbidden("a wallet session is required to import data");
      return ok(await svc.run({ wallet, records: body.records, dryRun: body.dry_run }));
    });
  };
