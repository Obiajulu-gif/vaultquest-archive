import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { WalletAuthService } from "../services/walletAuth.js";

const challengeBody = z.object({
  wallet_address: z.string().min(1).max(120),
  public_key: z.string().min(1).max(120),
  network: z.string().min(1).max(64),
  contract: z.string().optional(),
  action: z.string().optional(),
  idempotency_key: z.string().uuid().optional()
});

const verifyBody = z.object({
  challenge_id: z.string().uuid(),
  payload: z.string().min(1),
  signature: z.string().min(1),
  public_key: z.string().min(1).max(120),
  network: z.string().min(1).max(64)
});

const refreshBody = z.object({
  refresh_token: z.string().min(1)
});

export const walletAuthRoutes = (svc: WalletAuthService): FastifyPluginAsync =>
  async (app) => {
    app.post("/wallet-auth/challenge", async (req, reply) => {
      const body = challengeBody.parse(req.body);
      const challenge = await svc.createChallenge({
        walletAddress: body.wallet_address,
        publicKey: body.public_key,
        network: body.network,
        contract: body.contract,
        action: body.action,
        idempotencyKey: body.idempotency_key
      });
      return reply.status(200).send({
        challenge_id: challenge.challengeId,
        nonce: challenge.nonce,
        expires_at: challenge.expiresAt.toISOString()
      });
    });

    app.post("/wallet-auth/verify", async (req, reply) => {
      const body = verifyBody.parse(req.body);
      const session = await svc.verifyChallenge({
        challengeId: body.challenge_id,
        payload: body.payload,
        signature: body.signature,
        publicKey: body.public_key,
        network: body.network
      });
      return reply.status(201).send({
        token: session.token,
        refresh_token: session.refreshToken,
        expires_at: session.expiresAt.toISOString(),
        wallet_address: session.walletAddress,
        public_key: session.publicKey,
        network: session.network
      });
    });

    app.post("/wallet-auth/refresh", async (req, reply) => {
      const body = refreshBody.parse(req.body);
      const session = await svc.refreshSession(body.refresh_token);
      return reply.status(200).send({
        token: session.token,
        refresh_token: session.refreshToken,
        expires_at: session.expiresAt.toISOString(),
        wallet_address: session.walletAddress,
        public_key: session.publicKey,
        network: session.network
      });
    });

    app.post("/wallet-auth/logout", async (req, reply) => {
      const token = req.headers.authorization?.replace("Bearer ", "");
      if (!token) return reply.status(204).send();
      await svc.revokeSession(token);
      return reply.status(204).send();
    });
  };
