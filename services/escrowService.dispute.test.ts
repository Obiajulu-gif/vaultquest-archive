import { describe, it, expect, vi, beforeEach } from "vitest";
import { EscrowService } from "./escrowService";
import { EscrowConflictError } from "@/lib/escrow/types";
import type { Challenge } from "@/types/challenge";

const disputeMock = vi.fn();
const resolveDisputeMock = vi.fn();

vi.mock("@/lib/escrow/trustlessWork", () => ({
  TrustlessWorkClient: {
    dispute: (...args: unknown[]) => disputeMock(...args),
    resolveDispute: (...args: unknown[]) => resolveDisputeMock(...args),
    createEscrow: vi.fn(),
    getStatus: vi.fn(),
    releaseFunds: vi.fn(),
    refund: vi.fn(),
  },
}));

function disputedChallenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "q-2",
    title: "5 draws",
    description: "",
    funderAddress: "GFUNDER",
    amount: "2000000",
    assetCode: "XLM",
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    escrowId: "escrow-2",
    status: "disputed",
    ...overrides,
  };
}

describe("EscrowService.disputeEscrow (#738)", () => {
  it("raises a dispute for an active escrow", async () => {
    disputeMock.mockResolvedValue({ xdr: "DISPUTE_XDR" });
    const result = await EscrowService.disputeEscrow("escrow-2", "Completion evidence is ambiguous");
    expect(result).toEqual({ xdr: "DISPUTE_XDR" });
    expect(disputeMock).toHaveBeenCalledWith("multi-release", "escrow-2", "Completion evidence is ambiguous");
  });
});

describe("EscrowService.resolveDispute (#738)", () => {
  beforeEach(() => {
    resolveDisputeMock.mockReset();
  });

  it("dispute-then-resolution: an arbitrated decision resolves the escrow with the given outcome", async () => {
    resolveDisputeMock.mockResolvedValue({ xdr: "RESOLVE_XDR" });
    const challenge = disputedChallenge();

    const result = await EscrowService.resolveDispute(challenge, "released");

    expect(result).toEqual({ xdr: "RESOLVE_XDR" });
    expect(resolveDisputeMock).toHaveBeenCalledWith({
      escrowId: "escrow-2",
      resolution: "released",
      splitBps: undefined,
    });
  });

  it("supports a split resolution with an explicit ratio", async () => {
    resolveDisputeMock.mockResolvedValue({ xdr: "RESOLVE_XDR" });
    const challenge = disputedChallenge();

    await EscrowService.resolveDispute(challenge, "split", 3000);

    expect(resolveDisputeMock).toHaveBeenCalledWith({
      escrowId: "escrow-2",
      resolution: "split",
      splitBps: 3000,
    });
  });

  it("refuses to resolve a challenge with no escrow", async () => {
    const challenge = disputedChallenge({ escrowId: undefined });
    await expect(EscrowService.resolveDispute(challenge, "released")).rejects.toThrow(/no escrow to resolve/);
    expect(resolveDisputeMock).not.toHaveBeenCalled();
  });
});

describe("EscrowService.applyDisputeTimeoutFallback (#738)", () => {
  beforeEach(() => {
    resolveDisputeMock.mockReset();
  });

  it("dispute-then-timeout: applies a 50/50 split by default when nobody arbitrates", async () => {
    resolveDisputeMock.mockResolvedValue({ xdr: "FALLBACK_XDR" });
    const challenge = disputedChallenge();

    const result = await EscrowService.applyDisputeTimeoutFallback(challenge);

    expect(result).toEqual({ xdr: "FALLBACK_XDR" });
    expect(resolveDisputeMock).toHaveBeenCalledWith({
      escrowId: "escrow-2",
      resolution: "split",
      splitBps: 5000,
    });
  });

  it("silent-party scenario: the fallback split is the same regardless of which side went silent — no argument for 'who disputed' changes the outcome", async () => {
    resolveDisputeMock.mockResolvedValue({ xdr: "FALLBACK_XDR" });

    await EscrowService.applyDisputeTimeoutFallback(disputedChallenge({ id: "funder-silent" }));
    await EscrowService.applyDisputeTimeoutFallback(disputedChallenge({ id: "claimant-silent" }));

    expect(resolveDisputeMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ splitBps: 5000 }));
    expect(resolveDisputeMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ splitBps: 5000 }));
  });

  it("accepts a non-default split ratio for quest types that configure one", async () => {
    resolveDisputeMock.mockResolvedValue({ xdr: "FALLBACK_XDR" });
    const challenge = disputedChallenge();

    await EscrowService.applyDisputeTimeoutFallback(challenge, 7500);

    expect(resolveDisputeMock).toHaveBeenCalledWith(
      expect.objectContaining({ splitBps: 7500 }),
    );
  });

  it("failure state: resolving an already-resolved dispute surfaces as a typed conflict, not a silent no-op", async () => {
    resolveDisputeMock.mockRejectedValue(
      new EscrowConflictError("escrow-2", "resolved", "Escrow escrow-2 already resolved"),
    );
    const challenge = disputedChallenge();

    await expect(EscrowService.applyDisputeTimeoutFallback(challenge)).rejects.toBeInstanceOf(
      EscrowConflictError,
    );
  });
});
