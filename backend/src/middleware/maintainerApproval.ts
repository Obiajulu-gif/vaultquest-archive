import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { AppError } from "../errors.js";

/**
 * Metadata for a role-scoped maintainer action approval.
 */
export interface MaintainerApproval {
  reason: string;
  scope: string;
  actor: string;
  expiresAt: number;
}

/**
 * Fastify preHandler that requires valid maintainer approval metadata in the
 * `X-Maintainer-Approval` header for high-impact actions.
 *
 * It verifies that:
 * 1. The header exists and is valid JSON (base64 encoded).
 * 2. The scope matches the required protected scope.
 * 3. The reason is provided.
 * 4. The approval has not expired.
 * 5. If the request has an authenticated principal, the actor matches.
 */
export function requireMaintainerApproval(requiredScope: string): preHandlerHookHandler {
  return async function maintainerApprovalGuard(req: FastifyRequest): Promise<void> {
    const header = req.headers["x-maintainer-approval"];
    if (!header || typeof header !== "string") {
      throw AppError.forbidden("Missing maintainer approval metadata");
    }

    let approval: MaintainerApproval;
    try {
      approval = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    } catch {
      throw AppError.forbidden("Invalid maintainer approval format");
    }

    if (approval.scope !== requiredScope) {
      throw AppError.forbidden("Mismatched maintainer approval scope");
    }
    
    if (!approval.reason || approval.reason.trim().length < 3) {
      throw AppError.forbidden("Missing or insufficient approval reason");
    }
    
    if (approval.expiresAt < Date.now()) {
      throw AppError.forbidden("Maintainer approval expired");
    }
    
    if (req.principal?.subject && approval.actor !== req.principal.subject) {
      throw AppError.forbidden("Mismatched maintainer approval actor");
    }
    
    req.log.info({ event: "maintainer_action_approved", approval });
  };
}
