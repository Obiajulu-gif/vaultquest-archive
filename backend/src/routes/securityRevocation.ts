/**
 * Issue #996 — Security session revocation routes.
 *
 * POST /admin/security/revoke-sessions
 *   Revoke all active sessions for a wallet after a security event.
 *
 * POST /admin/security/prune-stale-sessions
 *   Prune globally stale sessions (idle longer than maxIdleMs).
 *
 * Authorization: both routes require `admin.recovery.write` (maintainer).
 *
 * Normal paths:
 *  - 200 with { revokedCount, revokedAt, noOp } on success
 *  - 200 with noOp=true when there is nothing to revoke
 *
 * Failure paths:
 *  - 400 — invalid body (Zod)
 *  - 401 — missing / invalid credentials
 *  - 403 — insufficient permission
 *  - 500 — database error (logged, message is scrubbed)
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import {
  SecurityRevocationService,
  type SecurityRevocationInput,
} from "../services/securityRevocationService.js";
import { AppError } from "../errors.js";

const SECURITY_EVENT_TYPES = [
  "key_rotation",
  "suspicious_activity",
  "admin_forced_logout",
  "account_compromise",
  "password_change",
  "mfa_reset",
] as const;

const revokeBody = z.object({
  wallet_address: z.string().min(1).max(120),
  network: z.string().min(1).max(64).optional(),
  reason: z.enum(SECURITY_EVENT_TYPES),
  detail: z.string().max(512).optional(),
  max_idle_ms: z.number().int().positive().optional(),
  actor: z.string().min(1).max(120).optional(),
});

const pruneBody = z.object({
  max_idle_ms: z.number().int().positive(),
});

export const securityRevocationRoutes = (
  guard: preHandlerHookHandler,
  svc: SecurityRevocationService
): FastifyPluginAsync =>
  async (app) => {
    /**
     * POST /admin/security/revoke-sessions
     *
     * Revoke all active sessions for the specified wallet in response to a
     * security event. Optionally scope to a network or idle threshold.
     */
    app.post(
      "/admin/security/revoke-sessions",
      { preHandler: [guard] },
      async (req, reply) => {
        if (req.principal?.role !== "maintainer") {
          throw AppError.forbidden("maintainer role required");
        }

        const body = revokeBody.parse(req.body);

        const input: SecurityRevocationInput = {
          walletAddress: body.wallet_address,
          reason: body.reason,
          ...(body.network ? { network: body.network } : {}),
          ...(body.detail ? { detail: body.detail } : {}),
          ...(body.max_idle_ms != null ? { maxIdleMs: body.max_idle_ms } : {}),
          ...(body.actor ? { actor: body.actor } : {}),
        };

        const result = await svc.revokeForSecurityEvent(input);
        reply.header("Cache-Control", "no-store");
        return reply.code(200).send({ ok: true, data: result });
      }
    );

    /**
     * POST /admin/security/prune-stale-sessions
     *
     * Revoke all sessions across all wallets that have been idle longer than
     * `max_idle_ms`. This is a maintenance sweep, not a targeted revocation.
     */
    app.post(
      "/admin/security/prune-stale-sessions",
      { preHandler: [guard] },
      async (req, reply) => {
        if (req.principal?.role !== "maintainer") {
          throw AppError.forbidden("maintainer role required");
        }

        const body = pruneBody.parse(req.body);
        const revokedCount = await svc.pruneStaleSessionsGlobally(body.max_idle_ms);
        reply.header("Cache-Control", "no-store");
        return reply.code(200).send({
          ok: true,
          data: { revokedCount, prunedAt: new Date().toISOString() },
        });
      }
    );
  };
