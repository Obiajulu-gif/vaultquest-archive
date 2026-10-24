/**
 * Impersonation request middleware (#791).
 *
 * When a request carries `X-Impersonation-Session: <sessionId>` and the
 * caller is an authenticated maintainer, the middleware:
 *   1. Validates the session (not expired, not ended).
 *   2. Attaches `req.impersonation` for route handlers.
 *   3. Sets `X-Impersonation-Active: true` on the response so the UI can
 *      display a persistent warning banner.
 *
 * Routes that allow impersonation check `req.impersonation` themselves;
 * routes that don't can simply ignore it. Routes that explicitly BLOCK
 * impersonation (e.g. destructive mutations) should call
 * `assertImpersonationBlocked(req)`.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import type { ImpersonationSession } from "../services/impersonation.js";
import { ImpersonationError } from "../services/impersonation.js";
import type { ImpersonationService } from "../services/impersonation.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Present when the caller is acting inside an impersonation session. */
    impersonation?: ImpersonationSession;
  }
}

export const IMPERSONATION_HEADER = "x-impersonation-session";
export const IMPERSONATION_ACTIVE_HEADER = "x-impersonation-active";

/**
 * Creates a Fastify `onRequest` hook that resolves the impersonation session
 * (if present) and attaches it to the request.
 */
export function createImpersonationHook(svc: ImpersonationService) {
  return async function impersonationHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const sessionId = req.headers[IMPERSONATION_HEADER];
    if (!sessionId || typeof sessionId !== "string") return;

    try {
      const session = await svc.validate(sessionId);
      req.impersonation = session;
      void reply.header(IMPERSONATION_ACTIVE_HEADER, "true");
    } catch (err) {
      if (err instanceof ImpersonationError) {
        // Expired or ended sessions are rejected at the route level, not here.
        // Log a warning and continue (the route handler will reject if it requires a valid session).
        req.log.warn(
          { event: "impersonation_session_invalid", code: err.code, sessionId },
          "impersonation session invalid",
        );
      } else {
        throw err;
      }
    }
  };
}

/**
 * Call this inside a route handler to forbid impersonation for that endpoint.
 * Throws 403 when the request is executing inside an impersonation session.
 */
export function assertImpersonationBlocked(req: FastifyRequest): void {
  if (req.impersonation) {
    throw Object.assign(new Error("this operation is not permitted during an impersonation session"), {
      statusCode: 403,
      code: "IMPERSONATION_MUTATION_BLOCKED",
    });
  }
}
