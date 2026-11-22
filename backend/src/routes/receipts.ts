import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { hasPermission } from "../../../lib/rbac.js";
import { AppError } from "../errors.js";
import { ok } from "../responses.js";
import {
  RECEIPT_ALGORITHM,
  RECEIPT_DOMAIN,
  RECEIPT_VERSION,
  ReceiptAccessError,
  type ReceiptService,
  type ReceiptViewer,
} from "../services/receipts.js";

/**
 * Signed receipts (#812).
 *
 *   GET  /receipts/public-key          public — key to verify receipts offline
 *   POST /receipts/verify              public, rate-limited — signature + issued-copy check
 *   GET  /receipts/:id                 owner or maintainer
 *   GET  /actions/:id/receipts         owner or maintainer — the action's signed timeline
 *   GET  /admin/receipts/:id/verify    maintainer — re-derive from the ledger (tamper check)
 *
 * Receipts are returned verbatim (camelCase payload): the signature covers the
 * canonical JSON of exactly these fields, so renaming keys would break
 * verification for clients.
 */
export type ReceiptGuards = {
  /** `own.receipts.read` */
  read: preHandlerHookHandler;
  /** `admin.receipts.read` */
  admin: preHandlerHookHandler;
  /** Operation limit for `receipt.verify`. */
  verifyLimit: preHandlerHookHandler;
};

const idParams = z.object({ id: z.string().min(1).max(100) });
const verifyBody = z.object({ receipt: z.unknown() });

function viewerOf(req: FastifyRequest): ReceiptViewer {
  const principal = req.principal;
  return {
    walletAddress: principal?.walletAddress,
    canReadAny: !!principal && hasPermission([principal.role], "admin.receipts.read"),
  };
}

function rethrow(err: unknown): never {
  if (err instanceof ReceiptAccessError) throw AppError.forbidden("this receipt belongs to another wallet");
  throw err;
}

export const receiptsRoutes = (svc: ReceiptService, guards: ReceiptGuards): FastifyPluginAsync =>
  async (app) => {
    app.get("/receipts/public-key", async () =>
      ok({
        version: RECEIPT_VERSION,
        algorithm: RECEIPT_ALGORITHM,
        key_id: svc.keyId,
        trusted_key_ids: svc.trustedKeyIds,
        message_prefix: RECEIPT_DOMAIN,
        // True when no RECEIPT_SIGNING_SECRET is configured: receipts are only
        // verifiable until the process restarts.
        ephemeral: svc.ephemeralKey,
      }),
    );

    app.post("/receipts/verify", { preHandler: [guards.verifyLimit] }, async (req) => {
      const body = verifyBody.parse(req.body);
      const result = await svc.verify(body.receipt);
      return ok({ valid: result.valid, reason: result.reason ?? null });
    });

    app.get("/receipts/:id", { preHandler: [guards.read] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const receipt = await svc.get(id, viewerOf(req)).catch(rethrow);
      if (!receipt) throw AppError.notFound(`receipt ${id} not found`);
      return ok(receipt);
    });

    app.get("/actions/:id/receipts", { preHandler: [guards.read] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const receipts = await svc.listForAction(id, viewerOf(req)).catch(rethrow);
      if (!receipts) throw AppError.notFound(`action ${id} not found`);
      return ok(receipts);
    });

    app.get("/admin/receipts/:id/verify", { preHandler: [guards.admin] }, async (req) => {
      const { id } = idParams.parse(req.params);
      const result = await svc.verifyAgainstLedger(id);
      return ok({ receipt_id: id, valid: result.valid, reason: result.reason ?? null });
    });
  };
