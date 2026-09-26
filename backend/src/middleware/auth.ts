import type { FastifyRequest, FastifyReply } from "fastify";
import type { WalletAuthService } from "../services/walletAuth.js";

function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7).trim();
  return token.length > 0 ? token : null;
}

function normalizeWallets(wallets: readonly string[] = []): Set<string> {
  return new Set(wallets.map((wallet) => wallet.trim().toLowerCase()).filter(Boolean));
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const token = extractBearerToken(request);
  if (!token) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  // In a real application, verify the JWT here using a library like jsonwebtoken
  // For this implementation, we simulate decoding a payload
  if (token === "invalid") {
    return reply.status(401).send({ error: "Invalid token" });
  }

  // Dummy user payload extracted from JWT
  const userPayload = {
    id: "dummy-user-id",
    // This could also be a wallet address based on implementation
  };

  // Attach user to request
  (request as any).user = userPayload;
}

export function createRequireWalletSession(walletAuth: WalletAuthService) {
  return async function requireWalletSession(request: FastifyRequest, reply: FastifyReply) {
    const token = extractBearerToken(request);
    if (!token) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const session = await walletAuth.validateSession(token);
    if (!session) {
      return reply.status(401).send({ error: "Invalid or expired wallet session" });
    }

    (request as any).user = {
      id: session.id,
      walletAddress: session.walletAddress,
      publicKey: session.publicKey,
      network: session.network
    };
  };
}

export function createRequireAdminSession(
  walletAuth: WalletAuthService,
  adminWalletAddresses: readonly string[] = []
) {
  const allowedAdmins = normalizeWallets(adminWalletAddresses);
  const requireWalletSession = createRequireWalletSession(walletAuth);

  return async function requireAdminSession(request: FastifyRequest, reply: FastifyReply) {
    await requireWalletSession(request, reply);
    if (reply.sent) return;

    const walletAddress = (request as any).user?.walletAddress;
    if (!walletAddress || !allowedAdmins.has(String(walletAddress).toLowerCase())) {
      return reply.status(403).send({ error: "Admin wallet required" });
    }
  };
}
