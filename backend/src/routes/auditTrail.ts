import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { ok, page } from "../responses.js";
import { AUDIT_CATEGORIES, type AuditRecord, type AuditTrailService } from "../services/auditTrail.js";

/**
 * Immutable audit trail query/export (#814). Maintainers only.
 *
 *   GET /admin/audit-trail          filterable, cursor-paginated (newest first)
 *   GET /admin/audit-trail/export   ?format=ndjson|csv, same filters, max 5,000 rows
 *   GET /admin/audit-trail/verify   recompute the hash chain
 *
 * Separate from the older GET /admin/audit (protocol parameter changes), which
 * is unchanged.
 */
export type AuditTrailGuards = {
  /** `admin.audit_trail.read` */
  read: preHandlerHookHandler;
  /** `admin.audit_trail.export` + the `audit.export` operation limit. */
  export: preHandlerHookHandler;
};

const filters = {
  category: z.enum(AUDIT_CATEGORIES).optional(),
  action: z.string().min(1).max(100).optional(),
  actor: z.string().min(1).max(200).optional(),
  target_type: z.string().min(1).max(100).optional(),
  target_id: z.string().min(1).max(200).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
};
const listQuery = z.object({
  ...filters,
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const exportQuery = z.object({ ...filters, format: z.enum(["ndjson", "csv"]).default("ndjson") });

function toQuery(q: z.infer<typeof exportQuery> | z.infer<typeof listQuery>) {
  return {
    category: q.category,
    action: q.action,
    actorSubject: q.actor,
    targetType: q.target_type,
    targetId: q.target_id,
    // Normalise to the stored ISO form so string comparison is exact.
    since: q.since ? new Date(q.since).toISOString() : undefined,
    until: q.until ? new Date(q.until).toISOString() : undefined,
  };
}

function serialize(r: AuditRecord) {
  return {
    sequence: r.sequence,
    id: r.id,
    occurred_at: r.occurredAt,
    category: r.category,
    action: r.action,
    actor: r.actor,
    target: r.target,
    reason: r.reason,
    before: r.before,
    after: r.after,
    metadata: r.metadata,
    redacted_fields: r.redactedFields,
    prev_hash: r.prevHash,
    record_hash: r.recordHash,
  };
}

export const auditTrailRoutes = (svc: AuditTrailService, guards: AuditTrailGuards): FastifyPluginAsync =>
  async (app) => {
    app.get("/admin/audit-trail", { preHandler: [guards.read] }, async (req) => {
      const q = listQuery.parse(req.query);
      let result;
      try {
        result = await svc.list({ ...toQuery(q), cursor: q.cursor ?? null, limit: q.limit });
      } catch {
        throw AppError.badRequest(ERROR_CODES.INVALID_CURSOR, "invalid cursor");
      }
      return page(result.items.map(serialize), { nextCursor: result.nextCursor, limit: q.limit });
    });

    app.get("/admin/audit-trail/export", { preHandler: [guards.export] }, async (req, reply) => {
      const q = exportQuery.parse(req.query);
      const body = await svc.export(toQuery(q), q.format);
      reply
        .header("Content-Type", q.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename="audit-trail.${q.format === "csv" ? "csv" : "ndjson"}"`);
      return reply.send(body);
    });

    app.get("/admin/audit-trail/verify", { preHandler: [guards.read] }, async () => ok(await svc.verify()));
  };
