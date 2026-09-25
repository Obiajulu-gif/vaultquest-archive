import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { ok } from "../responses.js";
import { JOB_STATUSES, type JobRecord } from "../worker/types.js";
import type { JobQueue } from "../worker/jobWorker.js";

const listQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});
const idParams = z.object({ id: z.string().uuid() });

export function serializeJob(j: JobRecord) {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    idempotency_key: j.idempotencyKey,
    payload: j.payload,
    attempts: j.attempts,
    max_attempts: j.maxAttempts,
    run_at: j.runAt,
    correlation_id: j.correlationId,
    last_error: j.lastError,
    failures: j.failures,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
    completed_at: j.completedAt
  };
}

/** Operator inspection of background jobs. Guarded by the internal service secret. */
export const jobsRoutes = (queue: JobQueue, secret: string): FastifyPluginAsync =>
  async (app) => {
    const guard = requireServiceAuth(secret);

    app.get("/internal/jobs", { preHandler: [guard] }, async (req) => {
      const q = listQuery.parse(req.query);
      return ok((await queue.listJobs(q)).map(serializeJob));
    });

    app.get("/internal/jobs/:id", { preHandler: [guard] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const job = await queue.getJob(id);
      if (!job) throw AppError.notFound(`job ${id} not found`);
      return ok(serializeJob(job));
    });

    app.post("/internal/jobs/:id/retry", { preHandler: [guard] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const job = await queue.retryDeadJob(id);
      if (!job) throw AppError.notFound(`dead job ${id} not found`);
      return ok(serializeJob(job));
    });
  };
