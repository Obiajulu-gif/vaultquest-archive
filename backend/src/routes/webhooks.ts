import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { ok } from "../responses.js";
import {
  WebhookService,
  type VerifiedWebhookEvent,
} from "../services/webhookService.js";
import {
  webhookParamsSchema,
  webhookQuerySchema,
  type WebhookProvider,
} from "../schemas/webhooks.js";

export interface WebhookHandlerHooks {
  onVaultDeposit?: (event: VerifiedWebhookEvent) => Promise<unknown>;
  onVaultSettlement?: (event: VerifiedWebhookEvent) => Promise<unknown>;
  onPrizeDraw?: (event: VerifiedWebhookEvent) => Promise<unknown>;
  onPaymentSucceeded?: (event: VerifiedWebhookEvent) => Promise<unknown>;
  onGenericEvent?: (event: VerifiedWebhookEvent) => Promise<unknown>;
}

export function getRawBody(req: FastifyRequest): string {
  if ((req.raw as any).rawBody && typeof (req.raw as any).rawBody === "string") {
    return (req.raw as any).rawBody;
  }
  if (typeof req.body === "string") {
    return req.body;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString("utf8");
  }
  if (req.body !== undefined && req.body !== null) {
    return JSON.stringify(req.body);
  }
  return "";
}

export const webhooksRoutes = (
  webhookService: WebhookService,
  hooks: WebhookHandlerHooks = {}
): FastifyPluginAsync =>
  async (app) => {
    // Process an inbound webhook for any supported provider
    const handleWebhook = async (
      provider: WebhookProvider,
      req: FastifyRequest,
    ) => {
      const rawBody = getRawBody(req);
      if (!rawBody || rawBody.trim().length === 0) {
        throw AppError.badRequest(
          ERROR_CODES.WEBHOOK_EVENT_MALFORMED,
          "Webhook body is empty"
        );
      }

      const query = webhookQuerySchema.safeParse(req.query);
      const isDryRun = query.success && query.data?.dry_run;

      // Cryptographically verify signature and replay window
      const verified = webhookService.verifyAndParse({
        provider,
        rawBody,
        headers: req.headers,
      });

      if (isDryRun) {
        return ok({
          status: "verified",
          dry_run: true,
          provider: verified.provider,
          event_id: verified.eventId,
          event_type: verified.eventType,
          timestamp: verified.timestamp.toISOString(),
        });
      }

      // Process event with persistent deduplication
      const result = await webhookService.processEvent(verified, async (evt) => {
        req.log.info(
          {
            provider: evt.provider,
            eventId: evt.eventId,
            eventType: evt.eventType,
          },
          "Processing verified webhook event"
        );

        let handlerResult: any = { received: true };

        switch (evt.eventType) {
          case "vault.deposit_confirmed":
          case "deposit":
            if (hooks.onVaultDeposit) {
              handlerResult = await hooks.onVaultDeposit(evt);
            }
            break;

          case "vault.settlement_completed":
          case "settlement":
            if (hooks.onVaultSettlement) {
              handlerResult = await hooks.onVaultSettlement(evt);
            }
            break;

          case "prize_draw.completed":
          case "draw.winner_selected":
          case "draw":
            if (hooks.onPrizeDraw) {
              handlerResult = await hooks.onPrizeDraw(evt);
            }
            break;

          case "payment_intent.succeeded":
          case "payment.succeeded":
            if (hooks.onPaymentSucceeded) {
              handlerResult = await hooks.onPaymentSucceeded(evt);
            }
            break;

          default:
            if (hooks.onGenericEvent) {
              handlerResult = await hooks.onGenericEvent(evt);
            }
            break;
        }

        return handlerResult ?? { processed: true };
      });

      return ok({
        status: "processed",
        duplicate: result.duplicate,
        event_id: result.eventId,
        event_type: result.eventType,
        result: result.data,
      });
    };

    // Parameterized provider route: POST /webhooks/:provider
    app.post("/webhooks/:provider", async (req) => {
      const parsedParams = webhookParamsSchema.safeParse(req.params);
      if (!parsedParams.success) {
        throw AppError.badRequest(
          ERROR_CODES.WEBHOOK_PROVIDER_UNSUPPORTED,
          "Invalid or unsupported webhook provider"
        );
      }
      return handleWebhook(parsedParams.data.provider, req);
    });

    // Dedicated convenience routes
    app.post("/webhooks/stripe", async (req) => handleWebhook("stripe", req));
    app.post("/webhooks/internal", async (req) => handleWebhook("internal", req));
    app.post("/webhooks/stellar", async (req) => handleWebhook("stellar", req));
    app.post("/webhooks/vault", async (req) => handleWebhook("internal", req));
    app.post("/webhooks/draw-oracle", async (req) => handleWebhook("stellar", req));
  };
