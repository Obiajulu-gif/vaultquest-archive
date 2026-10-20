import type { FastifyRequest } from "fastify";
import type { WebhookProvider } from "../schemas/webhooks.js";
import type { WebhookService, VerifiedWebhookEvent } from "../services/webhookService.js";
import { getRawBody } from "../routes/webhooks.js";

declare module "fastify" {
  interface FastifyRequest {
    verifiedWebhook?: VerifiedWebhookEvent;
  }
}

export interface WebhookAuthOptions {
  provider: WebhookProvider;
  secret?: string;
  publicKey?: string;
  toleranceSeconds?: number;
}

/**
 * Fastify preHandler hook to verify webhook signatures on any route
 */
export function verifyWebhook(
  webhookService: WebhookService,
  options: WebhookAuthOptions
) {
  return async (req: FastifyRequest): Promise<void> => {
    const rawBody = getRawBody(req);
    const verified = webhookService.verifyAndParse({
      provider: options.provider,
      rawBody,
      headers: req.headers,
      secret: options.secret,
      publicKey: options.publicKey,
      toleranceSeconds: options.toleranceSeconds,
    });
    req.verifiedWebhook = verified;
  };
}
