import type { FastifyPluginAsync } from "fastify";
import type { LedgerService } from "../services/ledger.js";
import { reconcileBody, checkpointBody } from "../schemas/actions.js";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { validateBody } from "../middleware/validate.js";
import { ok } from "../responses.js";
import type { z } from "zod";

export const internalRoutes = (svc: LedgerService, secret: string): FastifyPluginAsync =>
  async (app) => {
    const guard = requireServiceAuth(secret);

    app.post("/internal/reconcile", {
      preHandler: [guard, validateBody(reconcileBody)]
    }, async (req, reply) => {
      const body = req.body as z.infer<typeof reconcileBody>;
      const result = await svc.reconcileEvent({
        txHash: body.tx_hash,
        sorobanEventId: body.soroban_event_id,
        eventPayload: body.event_payload,
        statusHint: body.status_hint
      });
      if (!result.matched) {
        reply.status(202);
        return ok({ parked: true });
      }
      return ok({ matched: true });
    });

    app.post("/internal/checkpoint", {
      preHandler: [guard, validateBody(checkpointBody)]
    }, async (req) => {
      const body = req.body as z.infer<typeof checkpointBody>;
      await svc.updateIndexerCheckpoint({
        latestLedger: body.latest_ledger,
        lastProcessedEventId: body.last_processed_event_id,
        lastError: body.last_error,
        success: body.success
      });
      return ok({ updated: true });
    });
  };
