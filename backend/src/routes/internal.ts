import type { FastifyPluginAsync } from "fastify";
import type { LedgerService } from "../services/ledger.js";
import type { TransactionTraceService } from "../services/transactionTrace.js";
import { AppError } from "../errors.js";
import { reconcileBody, checkpointBody, traceParams } from "../schemas/actions.js";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { validateBody } from "../middleware/validate.js";
import { ok } from "../responses.js";
import type { z } from "zod";

export const internalRoutes = (
  svc: LedgerService,
  secret: string,
  traces: TransactionTraceService
): FastifyPluginAsync =>
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
        statusHint: body.status_hint,
        ledgerClosedAt: body.ledger_closed_at ? new Date(body.ledger_closed_at) : undefined
      });
      req.log.info(
        { txHash: body.tx_hash, eventId: body.soroban_event_id, matched: result.matched },
        "internal reconcile applied"
      );
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

    // #753: cross-layer timeline for one transaction, keyed by its hash.
    app.get("/internal/trace/:txHash", { preHandler: [guard] }, async (req) => {
      const parsed = traceParams.safeParse(req.params);
      if (!parsed.success) throw AppError.validation("invalid tx hash");
      const trace = await traces.trace(parsed.data.txHash);
      if (!trace) throw AppError.notFound(`no record of transaction ${parsed.data.txHash}`);
      return ok(trace);
    });
  };
