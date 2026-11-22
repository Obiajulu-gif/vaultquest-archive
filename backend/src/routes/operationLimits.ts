import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { ok } from "../responses.js";
import type { AuditActor } from "../services/auditTrail.js";
import {
  LimitOverrideError,
  OPERATION_NAMES,
  type LimitDecision,
  type LimitOverride,
  type OperationLimitService,
} from "../services/operationLimits.js";

/**
 * Operation-limit administration (#815). Maintainers only.
 *
 *   GET  /admin/limits                         policies + active overrides
 *   GET  /admin/limits/usage?operation&scope_key
 *   POST /admin/limits/overrides               { operation, scope_key, limit, duration_seconds, reason }
 *   POST /admin/limits/overrides/:id/revoke    { reason }
 *   POST /admin/limits/reset                   { operation, scope_key, reason }
 *
 * Grants, revocations and resets are written to the audit trail ("limits").
 */
export type LimitGuards = {
  /** `admin.limits.read` */
  read: preHandlerHookHandler;
  /** `admin.limits.write` */
  write: preHandlerHookHandler;
};

const operation = z.enum(OPERATION_NAMES as [string, ...string[]]);
const scopeKey = z.string().trim().min(3).max(220);
const reason = z.string().trim().min(3).max(500);

const usageQuery = z.object({ operation, scope_key: scopeKey });
const grantBody = z.object({
  operation,
  scope_key: scopeKey,
  limit: z.number().int().min(1),
  duration_seconds: z.number().int().min(1).max(30 * 24 * 3600),
  reason,
});
const revokeBody = z.object({ reason });
const resetBody = z.object({ operation, scope_key: scopeKey, reason });
const idParams = z.object({ id: z.string().uuid() });

function actorOf(req: FastifyRequest): AuditActor {
  const p = req.principal;
  if (!p) throw AppError.unauthorized();
  return { subject: p.subject, role: p.role };
}

function rethrow(err: unknown): never {
  if (err instanceof LimitOverrideError) {
    if (err.code === "NOT_FOUND") throw AppError.notFound(err.message);
    if (err.code === "OVERRIDE_EXISTS") throw AppError.conflict(ERROR_CODES.CONFLICT, err.message);
    throw AppError.validation(err.message);
  }
  throw err;
}

function serializeOverride(o: LimitOverride) {
  return {
    id: o.id,
    operation: o.operation,
    scope_key: o.scopeKey,
    limit: o.limit,
    reason: o.reason,
    granted_by: o.grantedBy,
    created_at: o.createdAt,
    expires_at: o.expiresAt,
    revoked_at: o.revokedAt,
    revoked_by: o.revokedBy,
  };
}

function serializeDecision(d: LimitDecision) {
  return {
    operation: d.operation,
    scope_key: d.scopeKey,
    limit: d.limit,
    used: d.used,
    remaining: d.remaining,
    reset_at: d.resetAt,
    override_id: d.overrideId,
  };
}

export const operationLimitsRoutes = (svc: OperationLimitService, guards: LimitGuards): FastifyPluginAsync =>
  async (app) => {
    app.get("/admin/limits", { preHandler: [guards.read] }, async () => {
      const overrides = await svc.listOverrides({ activeOnly: true });
      return ok({
        policies: svc.listPolicies().map((p) => ({
          operation: p.operation,
          description: p.description,
          resources: p.resources,
          limit: p.limit,
          window_seconds: Math.round(p.windowMs / 1000),
          scope: p.scope,
          remediation: p.remediation,
        })),
        active_overrides: overrides.map(serializeOverride),
      });
    });

    app.get("/admin/limits/usage", { preHandler: [guards.read] }, async (req) => {
      const q = usageQuery.parse(req.query);
      return ok(serializeDecision(await svc.usage(q.operation as (typeof OPERATION_NAMES)[number], q.scope_key)));
    });

    app.post("/admin/limits/overrides", { preHandler: [guards.write] }, async (req, reply) => {
      const body = grantBody.parse(req.body);
      const override = await svc
        .grantOverride(
          {
            operation: body.operation as (typeof OPERATION_NAMES)[number],
            scopeKey: body.scope_key,
            limit: body.limit,
            durationMs: body.duration_seconds * 1000,
            reason: body.reason,
          },
          actorOf(req),
        )
        .catch(rethrow);
      reply.status(201);
      return ok(serializeOverride(override));
    });

    app.post("/admin/limits/overrides/:id/revoke", { preHandler: [guards.write] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const body = revokeBody.parse(req.body);
      return ok(serializeOverride(await svc.revokeOverride(id, actorOf(req), body.reason).catch(rethrow)));
    });

    app.post("/admin/limits/reset", { preHandler: [guards.write] }, async (req) => {
      const body = resetBody.parse(req.body);
      const decision = await svc
        .reset(body.operation as (typeof OPERATION_NAMES)[number], body.scope_key, actorOf(req), body.reason)
        .catch(rethrow);
      return ok(serializeDecision(decision));
    });
  };
