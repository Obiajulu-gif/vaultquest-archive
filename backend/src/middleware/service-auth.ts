import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { timingSafeStringEqual } from "../utils/timingSafeCompare.js";

/**
 * Fastify preHandler that enforces the shared-secret guard on internal,
 * service-to-service endpoints (e.g. POST /internal/reconcile).
 *
 * The secret is compared in constant time (issue #584) so a mismatch can't
 * be distinguished from a match by response latency.
 */
export function requireServiceAuth(expectedSecret: string) {
  return async function (req: FastifyRequest): Promise<void> {
    const provided = req.headers["x-internal-secret"];
    if (typeof provided !== "string" || provided.length === 0) {
      throw AppError.unauthorized();
    }
    if (!timingSafeStringEqual(provided, expectedSecret)) {
      throw AppError.unauthorized();
    }
  };
}
