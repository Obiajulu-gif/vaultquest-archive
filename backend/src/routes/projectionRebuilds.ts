import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ok } from "../responses.js";
import type { AuditActor } from "../services/auditTrail.js";
import type { ProjectionRebuildRun, ProjectionRebuildService } from "../services/projectionRebuild.js";

/**
 * Versioned projection rebuild (#989). Maintainer only.
 *
 *   GET  /admin/projections/plan                  dry run: versions, log tip, events to replay
 *   GET  /admin/projections/rebuilds?limit=       runs, newest first
 *   GET  /admin/projections/rebuilds/:id          one run (poll for progress)
 *   POST /admin/projections/rebuilds              { reason, allow_downgrade? } -> 202
 *   POST /admin/projections/rebuilds/:id/resume   -> 202
 *
 * Starts and resumes are audited (category "recovery") and return 202: the
 * replay continues in the background and its progress is read via GET.
 */
export type ProjectionRebuildGuards = {
  /** `admin.recovery.read` */
  read: preHandlerHookHandler;
  /** `admin.recovery.write` */
  write: preHandlerHookHandler;
};

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
const startBody = z.object({
  reason: z.string().trim().min(3).max(500),
  allow_downgrade: z.boolean().default(false)
});

function actorOf(req: FastifyRequest): AuditActor {
  const p = req.principal;
  if (!p) throw AppError.unauthorized();
  return { subject: p.subject, role: p.role };
}

function serializeRun(run: ProjectionRebuildRun) {
  return {
    id: run.id,
    projection_version: run.projectionVersion,
    status: run.status,
    requested_by: run.requestedBy,
    reason: run.reason,
    to_event_id: run.toEventId,
    cursor: run.cursor,
    events_replayed: run.eventsReplayed,
    attempts: run.attempts,
    error_code: run.errorCode,
    last_error: run.lastError,
    heartbeat_at: run.heartbeatAt,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    completed_at: run.completedAt
  };
}

export const projectionRebuildRoutes = (
  svc: ProjectionRebuildService,
  guards: ProjectionRebuildGuards
): FastifyPluginAsync =>
  async (app) => {
    app.get("/admin/projections/plan", { preHandler: [guards.read] }, async () => {
      const plan = await svc.plan();
      return ok({
        projection_version: plan.projectionVersion,
        last_rebuilt_version: plan.lastRebuiltVersion,
        rebuild_recommended: plan.rebuildRecommended,
        is_downgrade: plan.isDowngrade,
        to_event_id: plan.toEventId,
        events_to_replay: plan.eventsToReplay,
        active_run: plan.activeRun ? serializeRun(plan.activeRun) : null
      });
    });

    app.get("/admin/projections/rebuilds", { preHandler: [guards.read] }, async (req) => {
      const q = listQuery.parse(req.query);
      return ok((await svc.list(q.limit)).map(serializeRun));
    });

    app.get("/admin/projections/rebuilds/:id", { preHandler: [guards.read] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const run = await svc.get(id);
      if (!run) throw AppError.notFound(`projection rebuild ${id} not found`);
      return ok(serializeRun(run));
    });

    app.post("/admin/projections/rebuilds", { preHandler: [guards.write] }, async (req, reply) => {
      const body = startBody.parse(req.body);
      const execution = await svc.start({ actor: actorOf(req), reason: body.reason, allowDowngrade: body.allow_downgrade });
      reply.status(202);
      return ok(serializeRun(execution.run));
    });

    app.post("/admin/projections/rebuilds/:id/resume", { preHandler: [guards.write] }, async (req, reply) => {
      const { id } = idParams.parse(req.params);
      const execution = await svc.resume(id, actorOf(req));
      reply.status(202);
      return ok(serializeRun(execution.run));
    });
  };
