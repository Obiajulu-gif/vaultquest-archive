import { z } from "zod";
import { SUPPORT_SCOPE_TYPES, SUPPORT_ACCESS_LIMITS } from "../services/supportAccessService.js";

const actorSchema = z.string().min(1).max(200);

export const createGrantBody = z.object({
  requester_id: actorSchema,
  reason: z.string().min(1).max(500),
  ticket_ref: z.string().min(1).max(120),
  scope_type: z.enum(SUPPORT_SCOPE_TYPES),
  scope: z.string().min(1).max(120),
  ttl_minutes: z
    .number()
    .int()
    .min(SUPPORT_ACCESS_LIMITS.minTtlMinutes)
    .max(SUPPORT_ACCESS_LIMITS.maxTtlMinutes)
    .optional()
});

export const revokeGrantBody = z.object({
  revoked_by: actorSchema
});

export const grantParams = z.object({
  id: z.string().uuid()
});

export const authorizeBody = z.object({
  grant_id: z.string().uuid(),
  scope_type: z.enum(SUPPORT_SCOPE_TYPES),
  scope: z.string().min(1).max(120),
  actor: actorSchema.optional()
});

export const supportNoticesQuery = z.object({
  wallet: z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar wallet address")
});
