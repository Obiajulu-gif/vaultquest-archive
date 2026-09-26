import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { AppError } from "../errors.js";
import { timingSafeStringEqual } from "../utils/timingSafeCompare.js";
import { hasPermission, type Permission, type Role } from "../../../lib/rbac.js";

/** The authenticated caller, attached to `req.principal` by `requirePermission`. */
export type Principal = {
  role: Role;
  /** Stable identifier for audit logs (wallet address, or the service name). */
  subject: string;
  /** Present for wallet-backed principals; used for ownership scoping. */
  walletAddress?: string;
};

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Resolves a request to a principal, or `null` when this resolver's credential
 * is absent/invalid. Resolvers never throw for bad credentials: the next
 * resolver gets a chance, and `requirePermission` answers 401 if none match.
 */
export type PrincipalResolver = (req: FastifyRequest) => Promise<Principal | null>;

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.substring(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * Wallet session -> `maintainer` when the wallet is on the admin allowlist,
 * otherwise `user`. Sessions are validated server-side; a forged token yields
 * no principal.
 */
export function walletSessionResolver(
  walletAuth: { validateSession(token: string): Promise<{ walletAddress: string } | null> },
  adminWalletAddresses: readonly string[] = [],
): PrincipalResolver {
  const admins = new Set(adminWalletAddresses.map((w) => w.trim().toLowerCase()).filter(Boolean));
  return async (req) => {
    const token = bearerToken(req);
    if (!token) return null;
    const session = await walletAuth.validateSession(token);
    if (!session) return null;
    const walletAddress = String(session.walletAddress);
    return {
      role: admins.has(walletAddress.toLowerCase()) ? "maintainer" : "user",
      subject: walletAddress,
      walletAddress,
    };
  };
}

/** `X-Internal-Secret` header (constant-time compare) -> `service`. */
export function serviceSecretResolver(secret: string, subject = "internal-service"): PrincipalResolver {
  return async (req) => {
    const provided = req.headers["x-internal-secret"];
    if (typeof provided !== "string" || provided.length === 0) return null;
    return timingSafeStringEqual(provided, secret) ? { role: "service", subject } : null;
  };
}

/**
 * Fastify preHandler enforcing `permission`. 401 when no resolver yields a
 * principal, 403 when the principal's role lacks the permission.
 */
export function requirePermission(
  permission: Permission,
  resolvers: readonly PrincipalResolver[],
): preHandlerHookHandler {
  return async function permissionGuard(req: FastifyRequest): Promise<void> {
    let principal: Principal | null = null;
    for (const resolve of resolvers) {
      principal = await resolve(req);
      if (principal) break;
    }
    if (!principal) throw AppError.unauthorized();
    if (!hasPermission([principal.role], permission)) {
      req.log.warn(
        { event: "permission_denied", permission, role: principal.role, subject: principal.subject },
        "permission denied",
      );
      throw AppError.forbidden(`missing permission: ${permission}`);
    }
    req.principal = principal;
  };
}
