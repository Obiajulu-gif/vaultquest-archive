import { describe, it, expect, vi, beforeEach } from "vitest";
import { EscrowService } from "./escrowService";
import { EscrowConflictError, EscrowProviderError } from "@/lib/escrow/types";
import type { Challenge } from "@/types/challenge";

const refundMock = vi.fn();
const releaseFundsMock = vi.fn();

vi.mock("@/lib/escrow/trustlessWork", () => ({
  TrustlessWorkClient: {
    refund: (...args: unknown[]) => refundMock(...args),
    releaseFunds: (...args: unknown[]) => releaseFundsMock(...args),
    createEscrow: vi.fn(),
    getStatus: vi.fn(),
    dispute: vi.fn(),
    resolveDispute: vi.fn(),
  },
}));

function pastDeadlineChallenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "q-1",
    title: "Save $100",
    description: "",
    funderAddress: "GFUNDER",
    amount: "1000000",
    assetCode: "XLM",
    deadline: new Date(Date.now() - 60_000).toISOString(),
    escrowId: "escrow-1",
    status: "funded",
    ...overrides,
  };
}

describe("EscrowService.refundExpiredChallenge (#741)", () => {
  beforeEach(() => {
    refundMock.mockReset();
    releaseFundsMock.mockReset();
  });

  it("main path: refunds a quest past its deadline that was never completed", async () => {
    refundMock.mockResolvedValue({ xdr: "REFUND_XDR" });
    const challenge = pastDeadlineChallenge();

    const result = await EscrowService.refundExpiredChallenge(challenge);

    expect(result).toEqual({ xdr: "REFUND_XDR" });
    expect(refundMock).toHaveBeenCalledWith({
      escrowId: "escrow-1",
      reason: "Quest expired unclaimed",
    });
  });

  it("edge case: refuses to refund before the deadline, without calling the provider", async () => {
    const challenge = pastDeadlineChallenge({
      deadline: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(EscrowService.refundExpiredChallenge(challenge)).rejects.toThrow(/has not reached its deadline/);
    expect(refundMock).not.toHaveBeenCalled();
  });

  it("edge case: refuses to refund a challenge with no escrow", async () => {
    const challenge = pastDeadlineChallenge({ escrowId: undefined });
    await expect(EscrowService.refundExpiredChallenge(challenge)).rejects.toThrow(/no escrow to refund/);
    expect(refundMock).not.toHaveBeenCalled();
  });

  describe("completion-vs-refund race (#741 core requirement)", () => {
    it("refund loses the race: a completion that landed first surfaces as a typed EscrowConflictError, not a generic failure", async () => {
      refundMock.mockRejectedValue(
        new EscrowConflictError("escrow-1", "released", "Escrow escrow-1 already released"),
      );
      const challenge = pastDeadlineChallenge();

      await expect(EscrowService.refundExpiredChallenge(challenge)).rejects.toBeInstanceOf(
        EscrowConflictError,
      );
      // The conflict must be identifiable as such, not swallowed into a plain Error.
      await expect(EscrowService.refundExpiredChallenge(challenge)).rejects.toMatchObject({
        kind: "escrow_conflict",
        currentStatus: "released",
      });
    });

    it("refund wins the race: a genuinely unclaimed quest at the deadline refunds cleanly", async () => {
      refundMock.mockResolvedValue({ xdr: "REFUND_XDR" });
      const challenge = pastDeadlineChallenge();

      await expect(EscrowService.refundExpiredChallenge(challenge)).resolves.toEqual({
        xdr: "REFUND_XDR",
      });
    });

    it("does not pre-check status before refunding — refund() is called directly, not preceded by a getStatus() read", async () => {
      refundMock.mockResolvedValue({ xdr: "REFUND_XDR" });
      const challenge = pastDeadlineChallenge();

      await EscrowService.refundExpiredChallenge(challenge);

      // A check-then-act sequence would call getStatus before refund, which
      // reopens the exact race window #741 exists to close.
      expect(refundMock).toHaveBeenCalledTimes(1);
    });
  });

  it("failure state: an unexpected provider error becomes a typed EscrowProviderError", async () => {
    refundMock.mockRejectedValue(new Error("ECONNRESET"));
    const challenge = pastDeadlineChallenge();

    await expect(EscrowService.refundExpiredChallenge(challenge)).rejects.toBeInstanceOf(
      EscrowProviderError,
    );
  });
});
