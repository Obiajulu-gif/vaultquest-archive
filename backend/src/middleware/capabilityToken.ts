import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from "fastify";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import type { CapabilityTokenPayload, CapabilityTokenService } from "../services/capabilityTokenService.js";

declare module "fastify" {
  interface FastifyRequest {
    capability?: CapabilityTokenPayload;
  }
}

export interface RequireCapabilityOptions {
  action: string;
  service: CapabilityTokenService;
  resourceResolver?: (req: FastifyRequest) => string | undefined;
  principalResolver?: (req: FastifyRequest) => string | undefined;
  consume?: boolean;
}

export function extractCapabilityToken(req: FastifyRequest): string | null {
  const header = req.headers["x-capability-token"];
  if (typeof header === "string" && header.trim().length > 0) {
    return header.trim();
  }

  const authHeader = req.headers.authorization;
  if (authHeader && typeof authHeader === "string") {
    if (authHeader.startsWith("Capability ")) {
      return authHeader.slice(11).trim();
    }
  }

  return null;
}

/**
 * Creates a Fastify preHandler hook enforcing that the request is authorized
 * with a valid, non-expired, non-replayed capability token for the specified action.
 */
export function requireCapability(options: RequireCapabilityOptions): preHandlerHookHandler {
  return async function requireCapabilityHook(req: FastifyRequest, _reply: FastifyReply) {
    const token = extractCapabilityToken(req);

    if (!token) {
      throw new AppError(
        ERROR_CODES.CAPABILITY_TOKEN_REQUIRED,
        401,
        `Capability token required for sensitive action '${options.action}'`,
        "Obtain an expiring capability token from POST /auth/capabilities/issue and supply via X-Capability-Token header."
      );
    }

    const expectedResource = options.resourceResolver ? options.resourceResolver(req) : undefined;
    const expectedPrincipal = options.principalResolver ? options.principalResolver(req) : undefined;

    const result = await options.service.verifyCapability(token, {
      expectedAction: options.action,
      expectedResource,
      expectedPrincipal,
      consume: options.consume ?? true
    });

    if (!result.valid) {
      const code = (result.errorCode ?? ERROR_CODES.CAPABILITY_TOKEN_INVALID) as any;
      let status = 403;
      if (code === ERROR_CODES.CAPABILITY_TOKEN_CONSUMED) {
        status = 409;
      } else if (code === ERROR_CODES.CAPABILITY_TOKEN_INVALID) {
        status = 400;
      }

      throw new AppError(
        code,
        status,
        result.errorMessage ?? "Invalid capability token",
        code === ERROR_CODES.CAPABILITY_TOKEN_EXPIRED
          ? "Your capability token has expired. Re-authenticate and issue a fresh capability token."
          : code === ERROR_CODES.CAPABILITY_TOKEN_CONSUMED
          ? "Single-use capability token has already been consumed. Request a new capability token for this action."
          : "Review capability token scope and signature requirements."
      );
    }

    req.capability = result.payload;
  };
}
