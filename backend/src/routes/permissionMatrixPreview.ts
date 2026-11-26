import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS } from "../../../lib/rbac.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { ok } from "../responses.js";

const proposal = z.object({
  expected_revision: z.string().optional(),
  // Omitted roles retain their existing permissions; supplied roles replace them.
  roles: z.object({
    user: z.array(z.enum(PERMISSIONS)).optional(),
    maintainer: z.array(z.enum(PERMISSIONS)).optional(),
    service: z.array(z.enum(PERMISSIONS)).optional(),
  }).strict().refine((roles) => Object.keys(roles).length > 0, "Supply at least one role"),
}).strict();

export function permissionPolicyRevision(): string {
  const canonical = ROLES.map((role) => [role, [...ROLE_PERMISSIONS[role]].sort()]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Advisory only: neither the proposal nor its preview changes live authorization. */
export const permissionMatrixPreviewRoutes = (guard: preHandlerHookHandler): FastifyPluginAsync => async (app) => {
  app.post("/admin/permissions/matrix-preview", { preHandler: guard }, async (req) => {
    const input = proposal.parse(req.body);
    const revision = permissionPolicyRevision();
    if (input.expected_revision !== undefined && input.expected_revision !== revision) {
      throw AppError.conflict(ERROR_CODES.CONFLICT, "Policy changed; refresh the preview before proceeding");
    }
    const changes = ROLES.map((role) => {
      const before = [...ROLE_PERMISSIONS[role]].sort();
      const after = [...new Set(input.roles[role] ?? before)].sort();
      return {
        role, before, after,
        added: after.filter((permission) => !before.includes(permission)),
        removed: before.filter((permission) => !after.includes(permission)),
      };
    });
    return ok({ revision, changed: changes.some((c) => c.added.length || c.removed.length), changes });
  });
};
