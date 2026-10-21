import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ok } from "../responses.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import type { CapabilityTokenService } from "../services/capabilityTokenService.js";

const issueBody = z.object({
  action: z.string().min(1).max(100),
  resource: z.string().min(1).max(255).default("*"),
  principal: z.string().min(1).max(255),
  ttl_seconds: z.number().int().min(10).max(3600).optional(),
  single_use: z.boolean().default(true),
  metadata: z.record(z.unknown()).optional()
});

const inspectBody = z.object({
  token: z.string().min(1),
  action: z.string().optional(),
  resource: z.string().optional(),
  principal: z.string().optional()
});

const revokeBody = z.object({
  token_id: z.string().optional(),
  token: z.string().optional(),
  principal: z.string().optional()
}).refine(
  (data) => Boolean(data.token_id || data.token || data.principal),
  { message: "At least one of token_id, token, or principal must be provided" }
);

export interface CapabilityRoutesOptions {
  capabilityService: CapabilityTokenService;
}

export const capabilityRoutes: FastifyPluginAsync<CapabilityRoutesOptions> = async (
  fastify,
  options
) => {
  const service = options.capabilityService;

  // POST /auth/capabilities/issue
  fastify.post("/auth/capabilities/issue", async (req, reply) => {
    const parsed = issueBody.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 400, "Invalid capability issuance request", undefined, parsed.error.issues);
    }

    const { action, resource, principal, ttl_seconds, single_use, metadata } = parsed.data;

    // Multi-tenant check: if caller has a principal attached, ensure they don't issue for other wallets unless maintainer
    const reqPrincipal = (req as any).principal;
    if (reqPrincipal && reqPrincipal.role !== "maintainer" && reqPrincipal.role !== "service") {
      const callerWallet = reqPrincipal.walletAddress || reqPrincipal.subject;
      if (callerWallet && callerWallet.toLowerCase() !== principal.toLowerCase()) {
        throw new AppError(ERROR_CODES.FORBIDDEN, 403, "Cannot issue capability token for another wallet");
      }
    }

    const result = await service.issueCapability({
      action,
      resource,
      principal,
      ttlSeconds: ttl_seconds,
      singleUse: single_use,
      metadata
    });

    return ok({
      token: result.token,
      payload: {
        token_id: result.payload.jti,
        action: result.payload.action,
        resource: result.payload.resource,
        principal: result.payload.principal,
        issued_at: result.payload.iat,
        expires_at: result.payload.exp,
        single_use: result.payload.singleUse,
        metadata: result.payload.metadata
      }
    });
  });

  // POST /auth/capabilities/inspect
  fastify.post("/auth/capabilities/inspect", async (req, reply) => {
    const parsed = inspectBody.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 400, "Invalid capability inspect request", undefined, parsed.error.issues);
    }

    const { token, action, resource, principal } = parsed.data;

    const result = await service.verifyCapability(token, {
      expectedAction: action ?? "*",
      expectedResource: resource,
      expectedPrincipal: principal,
      consume: false // Inspect never consumes
    });

    return ok({
      valid: result.valid,
      error_code: result.errorCode ?? null,
      error_message: result.errorMessage ?? null,
      payload: result.payload
        ? {
            token_id: result.payload.jti,
            action: result.payload.action,
            resource: result.payload.resource,
            principal: result.payload.principal,
            issued_at: result.payload.iat,
            expires_at: result.payload.exp,
            single_use: result.payload.singleUse,
            metadata: result.payload.metadata
          }
        : null
    });
  });

  // POST /auth/capabilities/revoke
  fastify.post("/auth/capabilities/revoke", async (req, reply) => {
    const parsed = revokeBody.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 400, "Invalid capability revocation request", undefined, parsed.error.issues);
    }

    const { token_id, token, principal } = parsed.data;

    if (token) {
      // Decode and revoke by token JTI
      const inspected = await service.verifyCapability(token, {
        expectedAction: "*",
        consume: false
      });
      if (inspected.payload) {
        await service.revokeToken(inspected.payload.jti, inspected.payload.exp);
      }
    }

    if (token_id) {
      // Revoke directly by JTI (assume max TTL expiration buffer)
      const maxExpiry = Math.floor(Date.now() / 1000) + 3600;
      await service.revokeToken(token_id, maxExpiry);
    }

    if (principal) {
      await service.revokePrincipal(principal);
    }

    return ok({
      revoked: true,
      token_id: token_id ?? null,
      principal: principal ?? null
    });
  });
};
