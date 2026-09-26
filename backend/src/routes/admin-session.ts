import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AdminSessionService } from "../services/adminSessionService.js";
import type { WalletAuthService } from "../services/walletAuth.js";
import { ok } from "../responses.js";

export const adminSessionRoutes = (
  adminSessionService: AdminSessionService,
  walletAuth: WalletAuthService
): FastifyPluginAsync =>
  async (app) => {
    const createSessionBody = z.object({
      wallet_address: z.string().min(1),
      signature: z.string().min(1),
      audience: z.string().min(1),
      role_version: z.number().int().positive()
    });

    app.post<{ Body: any }>("/admin/sessions", async (req, reply) => {
      const body = createSessionBody.parse(req.body);

      const session = await adminSessionService.createSession({
        walletAddress: body.wallet_address,
        signature: body.signature,
        audience: body.audience,
        roleVersion: body.role_version,
        ttlSeconds: 3600
      });

      reply.status(201);
      return ok({
        session_id: session.sessionId,
        wallet_address: session.walletAddress,
        audience: session.audience,
        expires_at: session.expiresAt,
        created_at: session.createdAt
      });
    });

    app.post<{ Params: { sessionId: string } }>("/admin/sessions/:sessionId/revoke", async (req, reply) => {
      await adminSessionService.revokeSession(req.params.sessionId);
      return ok({ revoked: true });
    });
  };
