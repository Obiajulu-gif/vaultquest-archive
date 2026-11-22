/**
 * Impersonation API routes (#791).
 *
 * POST /admin/impersonation          — start a session
 * GET  /admin/impersonation          — list active sessions for caller
 * DELETE /admin/impersonation/:id    — end a session early
 * GET  /admin/impersonation/:id      — inspect a session (state, expiry, …)
 *
 * Every route is maintainer-only. The session token is returned once on
 * creation; callers must store it safely. Subsequent requests that need
 * impersonated context pass `X-Impersonation-Session: <id>` — the middleware
 * in `impersonationMiddleware.ts` validates and attaches the session.
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ok } from "../responses.js";
import { AppError } from "../errors.js";
import {
  ImpersonationService,
  ImpersonationError,
  IMPERSONATION_MAX_TTL_MS,
} from "../services/impersonation.js";
import type { AuditActor } from "../services/auditTrail.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const startBody = z.object({
  target_wallet: z.string().min(1).max(200),
  reason: z.string().trim().min(10).max(500),
  ttl_ms: z.number().int().positive().max(IMPERSONATION_MAX_TTL_MS).optional(),
  allow_mutations: z.boolean().optional(),
});

const idParams = z.object({ id: z.string().uuid() });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function actorOf(req: Parameters<typeof ok>[0] extends never ? never : import("fastify").FastifyRequest): AuditActor {
  const p = req.principal;
  if (!p) throw AppError.unauthorized();
  return { subject: p.subject, role: p.role };
}

function rethrow(err: unknown): never {
  if (err instanceof ImpersonationError) {
    switch (err.code) {
      case "NOT_FOUND":
        throw AppError.notFound(err.message);
      case "EXPIRED":
      case "ENDED":
        throw AppError.conflict("IMPERSONATION_SESSION_INACTIVE", err.message);
      case "ALREADY_ACTIVE":
        throw AppError.conflict("IMPERSONATION_ALREADY_ACTIVE", err.message);
      case "FORBIDDEN":
        throw AppError.forbidden(err.message);
      case "MUTATION_BLOCKED":
        throw AppError.forbidden(err.message);
    }
  }
  throw err;
}

function serializeSession(session: import("../services/impersonation.js").ImpersonationSession) {
  return {
    id: session.id,
    maintainer_subject: session.maintainerSubject,
    target_wallet: session.targetWallet,
    reason: session.reason,
    allow_mutations: session.allowMutations,
    state: session.state,
    started_at: session.startedAt,
    expires_at: session.expiresAt,
    ended_at: session.endedAt,
  };
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

export type ImpersonationRouteGuards = {
  /** admin.impersonation.write — start/end sessions. */
  write: preHandlerHookHandler;
  /** admin.impersonation.read — inspect sessions. */
  read: preHandlerHookHandler;
};

export const impersonationRoutes = (
  svc: ImpersonationService,
  guards: ImpersonationRouteGuards,
): FastifyPluginAsync =>
  async (app) => {
    // POST /admin/impersonation — start a new session
    app.post("/admin/impersonation", { preHandler: [guards.write] }, async (req) => {
      const body = startBody.parse(req.body);
      const actor = actorOf(req as import("fastify").FastifyRequest);

      const session = await svc
        .start(actor, {
          targetWallet: body.target_wallet,
          reason: body.reason,
          ttlMs: body.ttl_ms,
          allowMutations: body.allow_mutations,
        })
        .catch(rethrow);

      return ok({
        session: serializeSession(session),
        _warning:
          "This session token gives access to another user's view. Handle it like a credential.",
      });
    });

    // GET /admin/impersonation — list active sessions for caller
    app.get("/admin/impersonation", { preHandler: [guards.read] }, async (req) => {
      const actor = actorOf(req as import("fastify").FastifyRequest);
      const sessions = await svc.listActive(actor.subject);
      return ok(sessions.map(serializeSession));
    });

    // GET /admin/impersonation/:id — inspect a session
    app.get("/admin/impersonation/:id", { preHandler: [guards.read] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const session = await svc.validate(id).catch(rethrow);
      return ok(serializeSession(session));
    });

    // DELETE /admin/impersonation/:id — end a session early
    app.delete("/admin/impersonation/:id", { preHandler: [guards.write] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const actor = actorOf(req as import("fastify").FastifyRequest);
      const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
      const session = await svc.end(id, actor, body.reason).catch(rethrow);
      return ok(serializeSession(session));
    });
  };
