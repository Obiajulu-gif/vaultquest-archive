import { z } from "zod";
import type { DrawProofService } from "../services/drawProofService.js";
import { NonRetryableJobError, type JobHandler } from "./types.js";

export const JOB_TYPES = {
  DRAW_PROOF_GENERATE: "draw_proof.generate"
} as const;

export const drawProofPayload = z.object({ actionId: z.string().min(1) });

export function drawProofJobKey(actionId: string): string {
  return `${JOB_TYPES.DRAW_PROOF_GENERATE}:${actionId}`;
}

/**
 * Handlers must be idempotent: the queue is at-least-once. Draw-proof
 * generation checks for an existing proof before inserting, so a re-run after
 * a crash or lock takeover is a no-op.
 */
export function createJobHandlers(deps: { drawProofs: DrawProofService }): Record<string, JobHandler> {
  return {
    [JOB_TYPES.DRAW_PROOF_GENERATE]: async (job) => {
      const parsed = drawProofPayload.safeParse(job.payload);
      if (!parsed.success) throw new NonRetryableJobError("invalid draw_proof.generate payload", "INVALID_PAYLOAD");
      await deps.drawProofs.generateProof({ actionId: parsed.data.actionId });
    }
  };
}
