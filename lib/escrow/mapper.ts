import type { Challenge } from "@/types/challenge";
import type { TWCreateEscrowRequest, TWRefundRequest, TWResolveDisputeRequest } from "./types";

export const EscrowMapper = {
  toCreateRequest(challenge: Challenge, recipientAddress: string): TWCreateEscrowRequest {
    return {
      type: "multi-release",
      amount: challenge.amount,
      assetCode: challenge.assetCode,
      funderAddress: challenge.funderAddress,
      recipientAddress,
      deadline: challenge.deadline,
      metadata: { challengeId: challenge.id, title: challenge.title },
    };
  },

  /** #741 — only meaningful once `challenge.escrowId` is set (the challenge was actually funded). */
  toRefundRequest(challenge: Challenge, reason: string): TWRefundRequest {
    if (!challenge.escrowId) {
      throw new Error(`Challenge ${challenge.id} has no escrowId — nothing to refund.`);
    }
    return { escrowId: challenge.escrowId, reason };
  },

  /** #738 — same shape whether the resolution came from arbitration or the timeout fallback; the caller decides which reason to log. */
  toResolveDisputeRequest(
    challenge: Challenge,
    resolution: "released" | "refunded" | "split",
    splitBps?: number,
  ): TWResolveDisputeRequest {
    if (!challenge.escrowId) {
      throw new Error(`Challenge ${challenge.id} has no escrowId — nothing to resolve.`);
    }
    return { escrowId: challenge.escrowId, resolution, splitBps };
  },
};
