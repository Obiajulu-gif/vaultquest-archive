/**
 * Thin HTTP client for the Trustless Work escrow API. Every method maps a
 * conflicting-state response (409, or a 4xx whose body names a terminal
 * status mismatch) to `EscrowConflictError` and everything else to
 * `EscrowProviderError` — callers never see a raw Trustless Work error
 * body or an unstructured network failure.
 */
import type {
  TWCreateEscrowRequest,
  TWCreateEscrowResponse,
  TWEscrowStatusResponse,
  TWReleaseRequest,
  TWRefundRequest,
  TWDisputeRequest,
  TWResolveDisputeRequest,
  EscrowType,
  EscrowStatus,
} from "./types";
import { EscrowConflictError, EscrowProviderError } from "./types";

const API_BASE_URL = process.env.TRUSTLESS_WORK_API_BASE_URL ?? "";
const API_KEY = process.env.TRUSTLESS_WORK_API_KEY ?? "";

interface ConflictBody {
  currentStatus?: EscrowStatus;
  message?: string;
}

async function request<T>(path: string, init: RequestInit, escrowId: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
        ...init.headers,
      },
    });
  } catch (err) {
    throw new EscrowProviderError(
      "Could not reach the escrow provider. Please try again shortly.",
      err,
    );
  }

  if (res.status === 409) {
    let body: ConflictBody = {};
    try {
      body = (await res.json()) as ConflictBody;
    } catch {
      // fall through with an empty body — still a conflict
    }
    throw new EscrowConflictError(
      escrowId,
      body.currentStatus ?? "released",
      body.message ??
        `Escrow ${escrowId} is no longer in a state that allows this operation — it likely already resolved via the opposite path.`,
    );
  }

  if (!res.ok) {
    throw new EscrowProviderError(
      `Escrow provider request failed (${res.status}). Please try again or contact support if this persists.`,
    );
  }

  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new EscrowProviderError("Escrow provider returned an unreadable response.", err);
  }
}

export const TrustlessWorkClient = {
  async createEscrow(req: TWCreateEscrowRequest): Promise<TWCreateEscrowResponse> {
    return request<TWCreateEscrowResponse>(
      "/escrows",
      { method: "POST", body: JSON.stringify(req) },
      "pending",
    );
  },

  async getStatus(type: EscrowType, escrowId: string): Promise<TWEscrowStatusResponse> {
    return request<TWEscrowStatusResponse>(
      `/escrows/${escrowId}?type=${encodeURIComponent(type)}`,
      { method: "GET" },
      escrowId,
    );
  },

  async releaseFunds(type: EscrowType, req: TWReleaseRequest): Promise<{ xdr: string }> {
    return request<{ xdr: string }>(
      `/escrows/${req.escrowId}/release?type=${encodeURIComponent(type)}`,
      { method: "POST", body: JSON.stringify(req) },
      req.escrowId,
    );
  },

  /**
   * #741 — refunds an escrow past its deadline back to the funder.
   * Trustless Work's own contract enforces that this cannot succeed once
   * the escrow has already released (or already refunded): a completion
   * that lands first wins, and this call surfaces that as
   * `EscrowConflictError`, not a generic failure.
   */
  async refund(req: TWRefundRequest): Promise<{ xdr: string }> {
    return request<{ xdr: string }>(
      `/escrows/${req.escrowId}/refund`,
      { method: "POST", body: JSON.stringify({ reason: req.reason }) },
      req.escrowId,
    );
  },

  async dispute(type: EscrowType, escrowId: string, reason: string): Promise<{ xdr: string }> {
    return request<{ xdr: string }>(
      `/escrows/${escrowId}/dispute?type=${encodeURIComponent(type)}`,
      { method: "POST", body: JSON.stringify({ escrowId, reason } satisfies TWDisputeRequest) },
      escrowId,
    );
  },

  /**
   * #738 — resolves a disputed escrow, either via arbitration (an explicit
   * resolution decision within the dispute window) or the pre-agreed
   * timeout fallback (called with the same shape once the window elapses
   * with no arbitration).
   */
  async resolveDispute(req: TWResolveDisputeRequest): Promise<{ xdr: string }> {
    return request<{ xdr: string }>(
      `/escrows/${req.escrowId}/resolve`,
      { method: "POST", body: JSON.stringify(req) },
      req.escrowId,
    );
  },
};
