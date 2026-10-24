import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { ok } from "../responses.js";
import type { AuditActor } from "../services/auditTrail.js";
import { RecoveryError, type PendingRecoveryService, type RecoveryCase } from "../services/pendingRecovery.js";

/**
 * Stuck pending-action recovery (#813).
 *
 * Owner (wallet session):
 *   GET  /actions/:id/recovery             state + user-safe message
 *   POST /actions/:id/recovery/retry       retry while `retryable` (rate-limited)
 * Maintainer:
 *   GET  /admin/recovery/diagnostics       stale records past the threshold
 *   GET  /admin/recovery/cases?state=      list cases
 *   POST /admin/recovery/scan              open cases for stale actions
 *   POST /admin/recovery/cases/:id/retry
 *   POST /admin/recovery/cases/:id/escalate   { reason }
 *   POST /admin/recovery/cases/:id/resolve    { outcome: failed|dismissed, reason }
 * Every transition is audited (category "recovery").
 */
export type RecoveryGuards = {
  /** `own.data.read` */
  ownRead: preHandlerHookHandler;
  /** `own.data.read` + the `recovery.retry` operation limit. */
  ownRetry: preHandlerHookHandler;
  /** `admin.recovery.read` */
  adminRead: preHandlerHookHandler;
  /** `admin.recovery.write` */
  adminWrite: preHandlerHookHandler;
};

const idParams = z.object({ id: z.string().min(1).max(100) });
const caseStates = ["retryable", "failed", "manual_review", "resolved"] as const;
const listQuery = z.object({
  state: z.enum(caseStates).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const diagnosticsQuery = z.object({ sample: z.coerce.number().int().min(1).max(100).default(25) });
const scanBody = z.object({ limit: z.number().int().min(1).max(500).default(100) }).default({ limit: 100 });
const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) });
const resolveBody = z.object({
  outcome: z.enum(["failed", "dismissed"]),
  reason: z.string().trim().min(3).max(500),
});

function actorOf(req: FastifyRequest): AuditActor {
  const p = req.principal;
  if (!p) throw AppError.unauthorized();
  return { subject: p.subject, role: p.role };
}

function ownerWallet(req: FastifyRequest): string {
  const wallet = req.principal?.walletAddress;
  if (!wallet) throw AppError.forbidden("a wallet session is required");
  return wallet;
}

function rethrow(err: unknown): never {
  if (err instanceof RecoveryError) {
    switch (err.code) {
      case "NOT_FOUND":
        throw AppError.notFound(err.message);
      case "FORBIDDEN":
        throw AppError.forbidden(err.message);
      case "ILLEGAL_TRANSITION":
        throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, err.message);
      case "CONFLICT":
        throw AppError.conflict(ERROR_CODES.CONFLICT, err.message);
      default:
        throw AppError.validation(err.message);
    }
  }
  throw err;
}

function serializeCase(c: RecoveryCase) {
  return {
    id: c.id,
    action_id: c.actionId,
    wallet_address: c.walletAddress,
    action_type: c.actionType,
    state: c.state,
    attempts: c.attempts,
    max_attempts: c.maxAttempts,
    stale_since: c.staleSince,
    detected_at: c.detectedAt,
    last_attempt_at: c.lastAttemptAt,
    last_error: c.lastError,
    resolution: c.resolution,
    version: c.version,
    updated_at: c.updatedAt,
  };
}

export const recoveryRoutes = (svc: PendingRecoveryService, guards: RecoveryGuards): FastifyPluginAsync =>
  async (app) => {
    app.get("/actions/:id/recovery", { preHandler: [guards.ownRead] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const view = await svc.viewForOwner(id, ownerWallet(req)).catch(rethrow);
      return ok({
        action_id: view.actionId,
        action_status: view.actionStatus,
        state: view.state,
        message: view.message,
        case_id: view.caseId,
        attempts: view.attempts,
        max_attempts: view.maxAttempts,
        can_retry: view.canRetry,
      });
    });

    app.post("/actions/:id/recovery/retry", { preHandler: [guards.ownRetry] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const wallet = ownerWallet(req);
      const view = await svc.viewForOwner(id, wallet).catch(rethrow);
      if (!view.caseId || !view.canRetry) {
        throw AppError.conflict(ERROR_CODES.ILLEGAL_TRANSITION, "this action cannot be retried right now");
      }
      const updated = await svc.retry(view.caseId, actorOf(req), wallet).catch(rethrow);
      return ok(serializeCase(updated));
    });

    app.get("/admin/recovery/diagnostics", { preHandler: [guards.adminRead] }, async (req) => {
      const q = diagnosticsQuery.parse(req.query);
      return ok(await svc.diagnostics(q.sample));
    });

    app.get("/admin/recovery/cases", { preHandler: [guards.adminRead] }, async (req) => {
      const q = listQuery.parse(req.query);
      const cases = await svc.listCases({ state: q.state, limit: q.limit });
      return ok(cases.map(serializeCase));
    });

    app.post("/admin/recovery/scan", { preHandler: [guards.adminWrite] }, async (req) => {
      const body = scanBody.parse(req.body ?? undefined);
      const result = await svc.scan(body.limit, actorOf(req));
      return ok({ opened: result.opened.map(serializeCase), already_open: result.existing });
    });

    app.post("/admin/recovery/cases/:id/retry", { preHandler: [guards.adminWrite] }, async (req) => {
      const { id } = idParams.parse(req.params);
      return ok(serializeCase(await svc.retry(id, actorOf(req)).catch(rethrow)));
    });

    app.post("/admin/recovery/cases/:id/escalate", { preHandler: [guards.adminWrite] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const body = reasonBody.parse(req.body);
      return ok(serializeCase(await svc.escalate(id, actorOf(req), body.reason).catch(rethrow)));
    });

    app.post("/admin/recovery/cases/:id/resolve", { preHandler: [guards.adminWrite] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const body = resolveBody.parse(req.body);
      return ok(serializeCase(await svc.resolve(id, actorOf(req), body).catch(rethrow)));
    });
  };
