/**
 * Partial failure dashboard API routes (#793).
 *
 * GET  /admin/partial-failures            — list failures (cursor-paginated)
 * GET  /admin/partial-failures/summary    — aggregated counts
 * GET  /admin/partial-failures/:id        — inspect one failure
 * POST /admin/partial-failures            — record a new failure (internal)
 * POST /admin/partial-failures/:id/retry  — mark retried
 * POST /admin/partial-failures/:id/resolve — manually resolve
 * POST /admin/partial-failures/:id/ignore — mark ignored
 */

import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { ok, page } from "../responses.js";
import { AppError } from "../errors.js";
import {
  PartialFailureService,
  PartialFailureError,
  PARTIAL_FAILURE_OPERATION_TYPES,
  PARTIAL_FAILURE_SEVERITIES,
  PARTIAL_FAILURE_STATES,
} from "../services/partialFailureService.js";
import type { AuditActor } from "../services/auditTrail.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const listQuery = z.object({
  operation_type: z.enum(PARTIAL_FAILURE_OPERATION_TYPES).optional(),
  severity: z.enum(PARTIAL_FAILURE_SEVERITIES).optional(),
  state: z.enum(PARTIAL_FAILURE_STATES).optional(),
  retryable: z
    .string()
    .optional()
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined)),
  since: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

const createBody = z.object({
  operation_type: z.enum(PARTIAL_FAILURE_OPERATION_TYPES),
  operation_id: z.string().min(1).max(200),
  external_ref: z.string().max(200).optional().nullable(),
  severity: z.enum(PARTIAL_FAILURE_SEVERITIES).optional(),
  retryable: z.boolean().optional(),
  description: z.string().min(5).max(1000),
  /** Caller must pre-sanitize. Secrets will not be stored. */
  metadata: z.record(z.unknown()).optional().nullable(),
  stale_since_at: z.string().datetime({ offset: true }).optional().nullable(),
});

const idParams = z.object({ id: z.string().uuid() });

const retryBody = z.object({
  outcome: z.enum(["resolved", "still_failing"]),
});

const resolveBody = z.object({
  resolution_note: z.string().trim().min(5).max(500),
});

const ignoreBody = z.object({
  reason: z.string().trim().min(5).max(500),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function actorOf(req: import("fastify").FastifyRequest): AuditActor {
  const p = req.principal;
  if (!p) throw AppError.unauthorized();
  return { subject: p.subject, role: p.role };
}

function rethrow(err: unknown): never {
  if (err instanceof PartialFailureError) {
    switch (err.code) {
      case "NOT_FOUND":
        throw AppError.notFound(err.message);
      case "ILLEGAL_TRANSITION":
        throw AppError.conflict("ILLEGAL_TRANSITION", err.message);
    }
  }
  throw err;
}

function serialize(r: import("../services/partialFailureService.js").PartialFailureRecord) {
  return {
    id: r.id,
    operation_type: r.operationType,
    operation_id: r.operationId,
    external_ref: r.externalRef,
    severity: r.severity,
    state: r.state,
    retryable: r.retryable,
    description: r.description,
    metadata: r.metadata,
    detected_at: r.detectedAt,
    stale_since_at: r.staleSinceAt,
    last_retried_at: r.lastRetriedAt,
    resolved_at: r.resolvedAt,
    resolved_by: r.resolvedBy,
    resolution_note: r.resolutionNote,
    ignored_at: r.ignoredAt,
    ignored_by: r.ignoredBy,
    updated_at: r.updatedAt,
  };
}

// ─── Route plugin ─────────────────────────────────────────────────────────────

export type PartialFailureRouteGuards = {
  /** admin.recovery.read */
  read: preHandlerHookHandler;
  /** admin.recovery.write */
  write: preHandlerHookHandler;
};

export const partialFailureRoutes = (
  svc: PartialFailureService,
  guards: PartialFailureRouteGuards,
): FastifyPluginAsync =>
  async (app) => {
    // GET /admin/partial-failures/summary — aggregated counts
    app.get("/admin/partial-failures/summary", { preHandler: [guards.read] }, async () => {
      const summary = await svc.summary();
      return ok(summary);
    });

    // GET /admin/partial-failures — list with cursor-based pagination
    app.get("/admin/partial-failures", { preHandler: [guards.read] }, async (req) => {
      const q = listQuery.parse(req.query);
      const result = await svc.list({
        operationType: q.operation_type,
        severity: q.severity,
        state: q.state,
        retryable: q.retryable as boolean | undefined,
        since: q.since,
        limit: q.limit,
        cursor: q.cursor,
      });
      return page(result.items.map(serialize), { nextCursor: result.nextCursor, limit: q.limit });
    });

    // GET /admin/partial-failures/:id — inspect one failure
    app.get("/admin/partial-failures/:id", { preHandler: [guards.read] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const record = await svc.getById(id).catch(rethrow);
      return ok(serialize(record));
    });

    // POST /admin/partial-failures — record a new failure
    app.post("/admin/partial-failures", { preHandler: [guards.write] }, async (req) => {
      const body = createBody.parse(req.body);
      const record = await svc.create({
        operationType: body.operation_type,
        operationId: body.operation_id,
        externalRef: body.external_ref,
        severity: body.severity,
        retryable: body.retryable,
        description: body.description,
        metadata: body.metadata as Record<string, unknown> | null | undefined,
        staleSinceAt: body.stale_since_at ? new Date(body.stale_since_at) : null,
      });
      return ok(serialize(record));
    });

    // POST /admin/partial-failures/:id/retry
    app.post("/admin/partial-failures/:id/retry", { preHandler: [guards.write] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const body = retryBody.parse(req.body);
      const actor = actorOf(req);
      const record = await svc.markRetried(id, actor, body.outcome).catch(rethrow);
      return ok(serialize(record));
    });

    // POST /admin/partial-failures/:id/resolve
    app.post(
      "/admin/partial-failures/:id/resolve",
      { preHandler: [guards.write] },
      async (req) => {
        const { id } = idParams.parse(req.params);
        const body = resolveBody.parse(req.body);
        const actor = actorOf(req);
        const record = await svc.resolve(id, actor, body.resolution_note).catch(rethrow);
        return ok(serialize(record));
      },
    );

    // POST /admin/partial-failures/:id/ignore
    app.post(
      "/admin/partial-failures/:id/ignore",
      { preHandler: [guards.write] },
      async (req) => {
        const { id } = idParams.parse(req.params);
        const body = ignoreBody.parse(req.body);
        const actor = actorOf(req);
        const record = await svc.ignore(id, actor, body.reason).catch(rethrow);
        return ok(serialize(record));
      },
    );
  };
