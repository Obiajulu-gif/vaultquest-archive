import type { FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { timingSafeStringEqual } from "../utils/timingSafeCompare.js";

/**
 * Fastify preHandler that enforces API key authentication for external-service
 * endpoints (issue #273).
 *
 * The key is read from the `X-Api-Key` request header and compared in constant
 * time (issue #584) to prevent timing-based side-channel attacks.
 *
 * Usage:
 *   const guard = requireApiKey("my-secret-key");
 *   app.get("/api/metrics", { preHandler: guard }, handler);
 *
 * When `expectedKey` is `undefined` (API_KEY env var not set) the guard is a
 * no-op, which allows local development without configuration overhead.
 */
export function requireApiKey(expectedKey: string | undefined) {
  return async function apiKeyGuard(req: FastifyRequest): Promise<void> {
    // Guard is disabled when no key is configured (local dev / test).
    if (expectedKey === undefined) return;

    const provided = req.headers["x-api-key"];
    const key = Array.isArray(provided) ? provided[0] : provided;

    if (typeof key !== "string" || key.length === 0) {
      throw AppError.unauthorized();
    }

    // Constant-time comparison to resist timing attacks.
    if (!timingSafeStringEqual(key, expectedKey)) {
      throw AppError.unauthorized();
    }
  };
}
