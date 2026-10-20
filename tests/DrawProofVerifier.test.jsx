import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import DrawProofVerifier from "@/components/app/DrawProofVerifier";

const mockVerifyDrawProofClient = vi.fn();

vi.mock("@/lib/draw-proof-verifier", () => ({
  verifyDrawProofClient: (...args) => mockVerifyDrawProofClient(...args),
  createFetchRpcClient: vi.fn(),
}));

const MOCK_PROOF = {
  proof: {
    version: "1.1.0",
    drawId: "draw-abc123def456",
    roundId: 5,
    contractId: "CDRYPPOOL123",
    snapshot: { ledgerSeq: 1000 },
    randomness: { seed: "seed123", seedHash: "seedhash", commitment: "commit" },
    winnerSelection: { method: "weighted_random", winnerAddress: "G...", proofHash: "proofhash" },
    payout: { amount: "500000", asset: "USDC", txHash: "tx", ledgerSeq: 1001, recipientConfirmed: true },
    metadata: {},
    signature: "sig",
  },
};

describe("DrawProofVerifier per-field rendering (#572)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders every VerificationField individually, not collapsed to one badge", async () => {
    mockVerifyDrawProofClient.mockResolvedValue({
      verified: false,
      verifiedAt: "2026-08-01T00:00:00Z",
      fields: [
        { name: "document_integrity", status: "pass" },
        {
          name: "winner_proof_hash",
          status: "fail",
          detail: "expected hash abc123, got hash xyz789",
        },
        { name: "seed_hash", status: "pass" },
        {
          name: "randomness_commitment",
          status: "unverified",
          detail: "No HMAC signing secret provided",
        },
      ],
    });

    render(<DrawProofVerifier proof={MOCK_PROOF} />);
    fireEvent.click(screen.getByText("Verify Proof"));

    expect(await screen.findByText("document_integrity")).toBeDefined();
    expect(screen.getByText("winner_proof_hash")).toBeDefined();
    expect(screen.getByText("seed_hash")).toBeDefined();
    expect(screen.getByText("randomness_commitment")).toBeDefined();
  });

  it("shows the failing field's detail text and the tampered field is called out", async () => {
    mockVerifyDrawProofClient.mockResolvedValue({
      verified: false,
      verifiedAt: "2026-08-01T00:00:00Z",
      fields: [
        { name: "document_integrity", status: "pass" },
        {
          name: "winner_proof_hash",
          status: "fail",
          detail: "expected hash abc123, got hash xyz789",
        },
        { name: "seed_hash", status: "pass" },
      ],
    });

    render(<DrawProofVerifier proof={MOCK_PROOF} />);
    fireEvent.click(screen.getByText("Verify Proof"));

    expect(await screen.findByText("expected hash abc123, got hash xyz789")).toBeDefined();
  });

  it("textually distinguishes fail from unverified from pass", async () => {
    mockVerifyDrawProofClient.mockResolvedValue({
      verified: false,
      verifiedAt: "2026-08-01T00:00:00Z",
      fields: [
        { name: "document_integrity", status: "pass" },
        { name: "winner_proof_hash", status: "fail", detail: "hash mismatch" },
        { name: "randomness_commitment", status: "unverified", detail: "No RPC client provided" },
      ],
    });

    render(<DrawProofVerifier proof={MOCK_PROOF} />);
    fireEvent.click(screen.getByText("Verify Proof"));

    expect(await screen.findByText("PASS")).toBeDefined();
    expect(screen.getByText("FAILED")).toBeDefined();
    expect(screen.getByText("UNVERIFIED")).toBeDefined();
  });
});
