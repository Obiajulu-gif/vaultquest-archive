import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../../../lib/rbac.js";
import { computePermissionDiff, preparePolicyChange, StalePolicyInputError, PermissionConfirmationRequiredError, InvalidPolicyError, type RolePolicy } from "../../../lib/permission-diff.js";
import { AppError } from "../errors.js";

const policySchema = z.object({
  version: z.number().int().positive(),
  roles: z.record(z.string().min(1).max(120), z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length)),
  actors: z.record(z.string().min(1).max(120), z.array(z.string().min(1).max(120))).optional(),
});
const inputSchema = z.object({
  baseVersion: z.number().int().positive(),
  proposedPolicy: policySchema,
  confirmationToken: z.string().optional(),
});

/** Preview configured RBAC changes; preparation returns a candidate, never silently activates it. */
export const permissionPreviewRoutes = (
  guard: preHandlerHookHandler,
  currentPolicy: () => RolePolicy = () => ({ version: 1,
    roles: Object.fromEntries(Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [role, [...permissions]])),
  }),
): FastifyPluginAsync => async (app) => {
  for (const action of ["preview", "prepare"] as const) {
    app.post(`/admin/permissions/${action}`, { preHandler: [guard] }, async (req, reply) => {
      if (req.principal?.role !== "maintainer") throw AppError.forbidden("maintainer role required");
      const input = inputSchema.parse(req.body);
      const current = currentPolicy();
      const options = { ...input, actorRoles: [req.principal.role], currentPolicy: current };
      reply.header("Cache-Control", "no-store");
      try {
        return action === "preview" ? computePermissionDiff(options) : { policy: preparePolicyChange(options), activated: false };
      } catch (error) {
        if (error instanceof InvalidPolicyError) throw AppError.validation(error.message);
        if (error instanceof StalePolicyInputError) return reply.code(409).send({ error: "stale_policy" });
        if (error instanceof PermissionConfirmationRequiredError) return reply.code(409).send({ error: "confirmation_required" });
        throw error;
      }
    });
  }
};
