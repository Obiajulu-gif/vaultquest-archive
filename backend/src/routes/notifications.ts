import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { NotificationService } from "../services/notificationService.js";
import { ok } from "../responses.js";
import { AppError } from "../errors.js";

const listQuery = z.object({
  wallet: z.string().min(1),
  include_dismissed: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true")
});

const dismissParams = z.object({ id: z.string().uuid() });
const dismissBody = z.object({ wallet: z.string().min(1) });

const preferenceBody = z.object({
  wallet: z.string().min(1),
  type: z.enum(["maturity", "claim_window"]),
  enabled: z.boolean()
});

const diagnosticsQuery = z.object({ wallet: z.string().min(1).optional() });

function serialize(row: Awaited<ReturnType<NotificationService["listNotifications"]>>[number]) {
  return {
    id: row.id,
    wallet_address: row.walletAddress,
    type: row.type,
    position_id: row.positionId,
    title: row.title,
    message: row.message,
    idempotency_key: row.idempotencyKey,
    delivery_status: row.deliveryStatus,
    delivery_attempts: row.deliveryAttempts,
    max_delivery_attempts: row.maxDeliveryAttempts,
    last_delivery_error: row.lastDeliveryError,
    delivered_at: row.deliveredAt,
    dismissed_at: row.dismissedAt,
    created_at: row.createdAt
  };
}

export const notificationsRoutes = (svc: NotificationService): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/notifications", async (req) => {
      const q = listQuery.parse(req.query);
      const rows = await svc.listNotifications(q.wallet, q.include_dismissed ?? false);
      return ok(rows.map(serialize));
    });

    app.post<{ Params: { id: string } }>(
      "/api/notifications/:id/dismiss",
      async (req) => {
        const params = dismissParams.parse(req.params);
        const body = dismissBody.parse(req.body);
        const updated = await svc.dismiss(body.wallet, params.id);
        if (!updated) {
          throw AppError.notFound("notification not found");
        }
        return ok(serialize(updated));
      }
    );

    app.put("/api/notifications/preferences", async (req) => {
      const body = preferenceBody.parse(req.body);
      await svc.setReminderTypeEnabled(body.wallet, body.type, body.enabled);
      return ok({ wallet: body.wallet, type: body.type, enabled: body.enabled });
    });

    app.post<{ Params: { id: string } }>(
      "/api/notifications/:id/retry",
      async (req) => {
        const params = dismissParams.parse(req.params);
        const body = dismissBody.parse(req.body);
        const existing = await svc.listNotifications(body.wallet, true);
        const owned = existing.find((row) => row.id === params.id);
        if (!owned) {
          throw AppError.notFound("notification not found");
        }
        const result = await svc.deliver(owned);
        return ok({
          id: result.id,
          delivery_status: result.deliveryStatus,
          delivery_attempts: result.deliveryAttempts,
          max_delivery_attempts: result.maxDeliveryAttempts,
          last_delivery_error: result.lastDeliveryError,
          delivered_at: result.deliveredAt
        });
      }
    );

    app.get("/api/notifications/diagnostics", async (req) => {
      const q = diagnosticsQuery.parse(req.query);
      const diagnostics = await svc.getDeliveryDiagnostics(q.wallet);
      return ok(diagnostics);
    });
  };
