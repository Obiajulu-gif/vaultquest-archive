import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import type { ActionLedgerVerificationService } from "../services/actionLedgerVerificationService.js";
import { ok } from "../responses.js";

export const ledgerVerificationRoutes = (
  verificationService: ActionLedgerVerificationService,
  requireAdmin: preHandlerHookHandler
): FastifyPluginAsync =>
  async (app) => {
    const chainRecordBody = z.object({
      action_id: z.string().uuid(),
      actor: z.string().min(1),
      authorization: z.string().min(1),
      intent_hash: z.string().min(1),
      referenced_events: z.array(z.string()).optional()
    });

    const verifyChainQuery = z.object({
      action_id: z.string().uuid()
    });

    app.post<{ Body: any }>("/admin/ledger/chain", {
      preHandler: [requireAdmin]
    }, async (req, reply) => {
      const body = chainRecordBody.parse(req.body);

      const signingKey = Buffer.from(process.env.LEDGER_SIGNING_KEY || "", "hex");
      if (signingKey.length === 0) {
        return reply.status(500).send({ error: "Ledger signing key not configured" });
      }

      const record = await verificationService.chainRecord({
        actionId: body.action_id,
        actor: body.actor,
        authorization: body.authorization,
        intentHash: body.intent_hash,
        referencedEvents: body.referenced_events || [],
        signingKey
      });

      reply.status(201);
      return ok({
        id: record.id,
        previous_hash: record.previousHash,
        current_hash: record.currentHash,
        actor: record.actor,
        authorization: record.authorization,
        intent_hash: record.intentHash,
        timestamp: record.timestamp
      });
    });

    app.get<{ Querystring: any }>("/admin/ledger/verify", {
      preHandler: [requireAdmin]
    }, async (req) => {
      const { action_id } = verifyChainQuery.parse(req.query);

      const publicKey = Buffer.from(process.env.LEDGER_PUBLIC_KEY || "", "hex");
      if (publicKey.length === 0) {
        return { valid: false, reason: "Public key not configured" };
      }

      const result = await verificationService.verifyChain(action_id, publicKey);
      return ok(result);
    });

    app.get<{ Params: { actionId: string } }>("/admin/ledger/export/:actionId", {
      preHandler: [requireAdmin]
    }, async (req, reply) => {
      const records = await verificationService.exportChain(req.params.actionId);

      if (records.length === 0) {
        reply
          .header("Content-Type", "application/json")
          .header("Content-Disposition", `attachment; filename="ledger-${req.params.actionId}.json"`);
        return reply.send(JSON.stringify({ records: [] }, null, 2));
      }

      const json = JSON.stringify(
        {
          action_id: req.params.actionId,
          records: records.map((r) => ({
            id: r.id,
            previous_hash: r.previousHash,
            current_hash: r.currentHash,
            actor: r.actor,
            authorization: r.authorization,
            intent_hash: r.intentHash,
            result: r.result,
            referenced_events: r.referencedEvents,
            timestamp: r.timestamp
          }))
        },
        null,
        2
      );

      reply
        .header("Content-Type", "application/json")
        .header("Content-Disposition", `attachment; filename="ledger-${req.params.actionId}.json"`);
      return reply.send(json);
    });
  };
