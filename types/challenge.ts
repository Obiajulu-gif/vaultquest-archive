/**
 * A VaultQuest "quest" — the product-facing name is "Challenge" in the
 * escrow layer, matching Trustless Work's own terminology. Funded into a
 * Trustless Work escrow at creation; released to the completer on
 * verified completion, refunded to the funder if it expires unclaimed.
 */
export interface Challenge {
  id: string;
  title: string;
  description: string;
  /** Funder's Stellar public key — refund destination. */
  funderAddress: string;
  /** Escrow amount in the smallest unit of `assetCode` (e.g. stroops for XLM). */
  amount: string;
  assetCode: string;
  /** ISO 8601. After this instant, the quest is eligible for expiry/refund if still unclaimed. */
  deadline: string;
  /** Set once an escrow has been created for this challenge via EscrowService.createEscrowForChallenge. */
  escrowId?: string;
  status: ChallengeStatus;
}

export type ChallengeStatus =
  | "draft"
  | "funded"
  | "completed"
  | "disputed"
  | "resolved"
  | "expired"
  | "refunded";
