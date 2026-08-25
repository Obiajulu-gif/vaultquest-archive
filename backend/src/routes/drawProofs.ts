import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { DrawProofService } from "../services/drawProofService.js";
import { ok, page } from "../responses.js";

const listQuery = z.object({
  round_id: z.coerce.number().int().nonnegative().optional(),
  contract_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});

function serializeProof(record: Awaited<ReturnType<DrawProofService["getProof"]>>) {
  if (!record) return null;
  return {
    id: record.id,
    draw_id: record.drawId,
    round_id: record.roundId,
    contract_id: record.contractId,
    proof: record.proofJson,
    proof_hash: record.proofHash,
    signature: record.signature,
    verified: record.verified,
    verified_at: record.verifiedAt,
    verification_error: record.verificationError,
    created_at: record.createdAt,
  };
}

export const drawProofRoutes = (svc: DrawProofService): FastifyPluginAsync =>
  async (app) => {
    app.get("/api/draw-proofs", async (req) => {
      const query = listQuery.parse(req.query);
      const result = await svc.listProofs({
        roundId: query.round_id,
        contractId: query.contract_id,
        limit: query.limit,
        cursor: query.cursor ?? null,
      });

      return page(
        result.items.map((r) => serializeProof(r)),
        { nextCursor: result.nextCursor, limit: query.limit }
      );
    });

    app.get("/api/draw-proofs/:drawId", async (req, reply) => {
      const { drawId } = req.params as { drawId: string };
      const record = await svc.getProof(drawId);
      if (!record) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: `Draw proof ${drawId} not found` },
        });
      }
      return ok(serializeProof(record));
    });

    app.get("/api/draw-proofs/:drawId/verify", async (req, reply) => {
      const { drawId } = req.params as { drawId: string };
      const record = await svc.getProof(drawId);
      if (!record) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: `Draw proof ${drawId} not found` },
        });
      }
      return ok({
        draw_id: record.drawId,
        verified: record.verified,
        verified_at: record.verifiedAt,
        verification_error: record.verificationError,
      });
    });

    app.post("/api/draw-proofs/:drawId/verify", async (req, reply) => {
      const { drawId } = req.params as { drawId: string };
      const result = await svc.verifyProof(drawId);
      if (!result) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: `Draw proof ${drawId} not found` },
        });
      }
      return ok({
        draw_id: result.record.drawId,
        verified: result.verification.verified,
        fields: result.verification.fields,
        verified_at: result.verification.verifiedAt,
      });
    });
  };
