import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { EXPORT_SECTIONS, type DataExportService } from "../services/dataExport.js";

const exportQuery = z.object({
  wallet: z.string().min(1).max(120).optional(),
  sections: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []))
    .pipe(z.array(z.enum(EXPORT_SECTIONS))),
});

/**
 * GET /exports (#772): wallet-scoped data export. The caller must hold
 * `own.data.export`; exporting another wallet additionally requires
 * `admin.export.any` (checked in the service, not the UI).
 */
export const exportsRoutes = (svc: DataExportService, guard: preHandlerHookHandler): FastifyPluginAsync =>
  async (app) => {
    app.get("/exports", { preHandler: [guard] }, async (req, reply) => {
      const q = exportQuery.parse(req.query);
      const bundle = await svc.build({ principal: req.principal!, wallet: q.wallet, sections: q.sections });
      const stamp = bundle.metadata.generated_at.replace(/[:.]/g, "-");
      reply
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename="vaultquest-export-${stamp}.json"`);
      return reply.send(JSON.stringify(bundle, null, 2) + "\n");
    });
  };
