import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { ok } from "../responses.js";
import { ROLLOUT_FLAG_KEYS, RolloutError, type FeatureFlagRolloutGuard } from "../services/featureFlagRollout.js";

/**
 * Guarded feature-flag rollouts. Maintainers only.
 *
 *   GET  /admin/feature-flags/:key/rollout?scope=             state, rollout record, live health
 *   POST /admin/feature-flags/:key/rollout                    { scope, reason, guardrails? }
 *   POST /admin/feature-flags/:key/rollout/rollback           { scope, reason }
 *   POST /admin/feature-flags/:key/rollout/verify             { scope }
 *   POST /admin/feature-flags/:key/rollout/complete           { scope, reason }
 *
 * See docs/FEATURE_FLAGS.md ("Guarded rollouts").
 */
export type FeatureFlagRolloutGuards = {
  /** `admin.flags.read` */
  read: preHandlerHookHandler;
  /** `admin.flags.write` */
  write: preHandlerHookHandler;
};

const params = z.object({ key: z.enum(ROLLOUT_FLAG_KEYS) });
const scope = z.string().trim().min(1).max(220).default("global");
const reason = z.string().trim().min(3).max(500);
const startBody = z.object({
  scope,
  reason,
  guardrails: z
    .object({
      max_error_rate: z.number().min(0).max(1).optional(),
      min_samples: z.number().int().min(1).max(100_000).optional(),
      window_seconds: z.number().int().min(10).max(24 * 3600).optional(),
    })
    .optional(),
});
const endBody = z.object({ scope, reason });
const verifyBody = z.object({ scope });
const scopeQuery = z.object({ scope });

function actorOf(req: FastifyRequest): string {
  const p = req.principal;
  if (!p) throw AppError.unauthorized();
  return `${p.role}:${p.subject}`;
}

function rethrow(err: unknown): never {
  if (err instanceof RolloutError) {
    if (err.code === "NOT_FOUND") throw AppError.notFound(err.message);
    if (err.code === "INVALID_SCOPE") throw AppError.validation(err.message);
    throw AppError.conflict(ERROR_CODES.CONFLICT, err.message);
  }
  throw err;
}

export const featureFlagRolloutRoutes =
  (guard: FeatureFlagRolloutGuard, guards: FeatureFlagRolloutGuards): FastifyPluginAsync =>
  async (app) => {
    app.get("/admin/feature-flags/:key/rollout", { preHandler: [guards.read] }, async (req) => {
      const { key } = params.parse(req.params);
      const q = scopeQuery.parse(req.query);
      return ok(await guard.get(key, q.scope));
    });

    app.post("/admin/feature-flags/:key/rollout", { preHandler: [guards.write] }, async (req, reply) => {
      const { key } = params.parse(req.params);
      const body = startBody.parse(req.body);
      const g = body.guardrails;
      try {
        const rollout = await guard.start(key, body.scope, {
          actor: actorOf(req),
          reason: body.reason,
          guardrails: {
            ...(g?.max_error_rate !== undefined ? { maxErrorRate: g.max_error_rate } : {}),
            ...(g?.min_samples !== undefined ? { minSamples: g.min_samples } : {}),
            ...(g?.window_seconds !== undefined ? { windowMs: g.window_seconds * 1000 } : {}),
          },
        });
        return reply.code(201).send(ok(rollout));
      } catch (err) {
        rethrow(err);
      }
    });

    app.post("/admin/feature-flags/:key/rollout/rollback", { preHandler: [guards.write] }, async (req) => {
      const { key } = params.parse(req.params);
      const body = endBody.parse(req.body);
      try {
        return ok(await guard.rollback(key, body.scope, { actor: actorOf(req), reason: body.reason }));
      } catch (err) {
        rethrow(err);
      }
    });

    app.post("/admin/feature-flags/:key/rollout/verify", { preHandler: [guards.write] }, async (req) => {
      const { key } = params.parse(req.params);
      const body = verifyBody.parse(req.body ?? {});
      try {
        return ok(await guard.verify(key, body.scope));
      } catch (err) {
        rethrow(err);
      }
    });

    app.post("/admin/feature-flags/:key/rollout/complete", { preHandler: [guards.write] }, async (req) => {
      const { key } = params.parse(req.params);
      const body = endBody.parse(req.body);
      try {
        return ok(await guard.complete(key, body.scope, { actor: actorOf(req), reason: body.reason }));
      } catch (err) {
        rethrow(err);
      }
    });
  };
