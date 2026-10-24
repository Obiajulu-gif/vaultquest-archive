/**
 * Trustless Work API request/response shapes this codebase depends on.
 *
 * Trustless Work's escrow is itself an on-chain Stellar/Soroban contract —
 * the atomicity guarantees these types' operations rely on (a given escrow
 * can only ever reach one terminal outcome: released or refunded, never
 * both) come from that contract, not from anything in this repo. Our job
 * is to call it correctly and handle its authoritative rejections, not to
 * re-implement mutual exclusion ourselves.
 */

export type EscrowType = "single-release" | "multi-release";

export type EscrowStatus =
  | "funded"
  | "released"
  | "disputed"
  | "resolved"
  | "refunded"
  | "expired";

export interface TWCreateEscrowRequest {
  type: EscrowType;
  amount: string;
  assetCode: string;
  funderAddress: string;
  recipientAddress: string;
  /** ISO 8601 — mirrors Challenge.deadline. Trustless Work enforces this on-chain for refund eligibility. */
  deadline: string;
  metadata?: Record<string, string>;
}

export interface TWCreateEscrowResponse {
  escrowId: string;
  xdr: string;
  status: EscrowStatus;
}

export interface TWEscrowStatusResponse {
  escrowId: string;
  status: EscrowStatus;
  deadline: string;
  amount: string;
  assetCode: string;
  /** Present once a dispute has been raised. */
  disputedAt?: string;
  /** Present once resolved (by arbitration or timeout fallback). */
  resolvedAt?: string;
  resolution?: "released" | "refunded" | "split";
}

export interface TWReleaseRequest {
  escrowId: string;
  recipient: string;
  milestoneIndex: number;
}

export interface TWRefundRequest {
  escrowId: string;
  /** Human-readable audit trail — not sent to the chain, logged only. */
  reason: string;
}

export interface TWDisputeRequest {
  escrowId: string;
  reason: string;
}

export interface TWResolveDisputeRequest {
  escrowId: string;
  resolution: "released" | "refunded" | "split";
  /** Required when resolution is "split" — recipient's share, remainder refunds the funder. Basis points, 0-10000. */
  splitBps?: number;
}

/**
 * A request that targeted an escrow already in a terminal (or otherwise
 * conflicting) state — e.g. refunding one Trustless Work already released,
 * or releasing one it already refunded. This is the *expected* shape of
 * the race described in issue #741: the losing side of a last-moment
 * completion-vs-refund race gets exactly this, not a generic 5xx.
 */
export class EscrowConflictError extends Error {
  readonly kind = "escrow_conflict";
  constructor(
    public readonly escrowId: string,
    public readonly currentStatus: EscrowStatus,
    message: string,
  ) {
    super(message);
    this.name = "EscrowConflictError";
  }
}

/** Any other Trustless Work API failure — network, 5xx, malformed response. Never expose the raw provider body to callers. */
export class EscrowProviderError extends Error {
  readonly kind = "escrow_provider_error";
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EscrowProviderError";
  }
}
