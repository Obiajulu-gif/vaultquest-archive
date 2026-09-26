import type { FastifyPluginAsync } from "fastify";
import type { preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { AuditService } from "../services/auditService.js";
import type { AdminSessionService } from "../services/adminSessionService.js";
import { requireAuth } from "../middleware/auth.js";
import { createRequireAdminSessionAuth } from "../middleware/admin-session.js";
import { ok, page } from "../responses.js";

function serialize(row: any) {
  return {
    id: row.id,
    parameter_name: row.parameterName,
    previous_value: row.previousValue,
    new_value: row.newValue,
    actor: row.actor,
    tx_hash: row.txHash,
    created_at: row.createdAt,
  };
}

export const auditRoutes = (
  svc: AuditService,
  adminSessionService?: AdminSessionService,
  requireAdmin: preHandlerHookHandler = requireAuth
): FastifyPluginAsync =>
  async (app) => {
    const requireAdminSession = adminSessionService
      ? createRequireAdminSessionAuth(adminSessionService)
      : requireAdmin;
    const recordBody = z.object({
      parameter_name: z.string().min(1).max(128),
      previous_value: z.unknown(),
      new_value: z.unknown(),
      actor: z.string().min(1).max(120),
      tx_hash: z.string().min(4).max(200).optional(),
    });

    const listQuery = z.object({
      parameter_name: z.string().min(1).max(128).optional(),
      actor: z.string().min(1).max(120).optional(),
      cursor: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    });

    app.post("/admin/audit", {
      preHandler: [requireAdminSession],
    }, async (req, reply) => {
      const adminSession = (req as any).adminSession;
      const body = recordBody.parse(req.body);
      const record = await svc.record({
        parameterName: body.parameter_name,
        previousValue: body.previous_value,
        newValue: body.new_value,
        actor: adminSession?.walletAddress || body.actor,
        txHash: body.tx_hash,
      });
      reply.status(201);
      return ok(serialize(record));
    });

    app.get("/admin/audit", {
      preHandler: [requireAdminSession],
    }, async (req) => {
      const q = listQuery.parse(req.query);
      const result = await svc.list({
        parameterName: q.parameter_name,
        actor: q.actor,
        cursor: q.cursor ?? null,
        limit: q.limit,
      });
      return page(result.items.map(serialize), { nextCursor: result.nextCursor, limit: q.limit });
    });

    app.get("/admin/audit/export", {
      preHandler: [requireAdminSession],
    }, async (req, reply) => {
      const q = listQuery.parse(req.query);
      const result = await svc.list({
        parameterName: q.parameter_name,
        actor: q.actor,
        cursor: null,
        limit: 1000,
      });

      const CSV_HEADERS = [
        "id", "parameter_name", "previous_value", "new_value",
        "actor", "tx_hash", "created_at"
      ];

      if (result.items.length === 0) {
        const csv = CSV_HEADERS.join(",") + "\n";
        reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", "attachment; filename=\"protocol-audit.csv\"");
        return reply.send(csv);
      }

      const csvRows = result.items.map((r) => [
        r.id,
        r.parameterName,
        JSON.stringify(r.previousValue),
        JSON.stringify(r.newValue),
        r.actor,
        r.txHash ?? "",
        r.createdAt.toISOString(),
      ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));

      const csv = [CSV_HEADERS.join(","), ...csvRows].join("\n");
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", "attachment; filename=\"protocol-audit.csv\"");
      return reply.send(csv);
    });
  };
