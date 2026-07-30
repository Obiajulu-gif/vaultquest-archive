import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import DrawProofCard from "@/components/app/DrawProofCard";

const MOCK_PROOF = {
  id: "proof-uuid",
  draw_id: "draw-abc123def456",
  round_id: 5,
  contract_id: "CDRYPPOOL123",
  proof: {
    version: "1.0.0",
    drawId: "draw-abc123def456",
    roundId: 5,
    contractId: "CDRYPPOOL123",
    snapshot: {
      ledgerSeq: 1000,
      ledgerCloseTime: "2026-07-24T00:00:00Z",
      participantsHash: "abc123hash",
      participantCount: 10,
      totalDeposits: "5000000",
      poolHash: "poolhash",
    },
    randomness: {
      source: "deterministic_placeholder",
      seed: "seed123",
      seedHash: "seedhash",
      drawnAtLedger: 1000,
    },
    winnerSelection: {
      method: "deterministic_placeholder",
      ticketWeightsHash: "weights123",
      winnerAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      winnerWeight: "2000000",
      totalWeight: "5000000",
      proofHash: "proofhash",
    },
    payout: {
      amount: "500000",
      asset: "USDC",
      txHash: "tx_hash_abc123",
      ledgerSeq: 1001,
      recipientConfirmed: true,
    },
    metadata: {
      createdAt: "2026-07-24T00:00:00Z",
      engineVersion: "1.0.0",
      contractSpecHash: "spec123",
    },
    signature: "doc_signature_hash",
  },
  proof_hash: "doc_hash",
  signature: "doc_signature_hash",
  verified: true,
  verified_at: "2026-07-24T00:01:00Z",
  verification_error: null,
  created_at: "2026-07-24T00:00:00Z",
};

describe("DrawProofCard", () => {
  it("renders round number", () => {
    render(<DrawProofCard proof={MOCK_PROOF} />);
    expect(screen.getByText("Round #5")).toBeDefined();
  });

  it("renders verified badge when verified", () => {
    render(<DrawProofCard proof={MOCK_PROOF} />);
    expect(screen.getByText("Verified")).toBeDefined();
  });

  it("renders failed badge when verification error exists", () => {
    render(
      <DrawProofCard
        proof={{ ...MOCK_PROOF, verified: false, verification_error: "hash mismatch" }}
      />
    );
    expect(screen.getByText("Failed")).toBeDefined();
  });

  it("renders unverified badge when neither verified nor error", () => {
    render(
      <DrawProofCard
        proof={{ ...MOCK_PROOF, verified: false, verification_error: null }}
      />
    );
    expect(screen.getByText("Unverified")).toBeDefined();
  });

  it("renders prize amount", () => {
    render(<DrawProofCard proof={MOCK_PROOF} />);
    expect(screen.getByText("0.50 USDC")).toBeDefined();
  });

  it("renders winner address truncated", () => {
    render(<DrawProofCard proof={MOCK_PROOF} />);
    expect(screen.getByText("GBBD47...FLA5")).toBeDefined();
  });

  it("renders View Proof button when onViewProof provided", () => {
    const onViewProof = vi.fn();
    render(<DrawProofCard proof={MOCK_PROOF} onViewProof={onViewProof} />);
    expect(screen.getByText("View Proof →")).toBeDefined();
  });

  it("does not render View Proof button when onViewProof not provided", () => {
    render(<DrawProofCard proof={MOCK_PROOF} />);
    expect(screen.queryByText("View Proof →")).toBeNull();
  });

  it("returns null for null proof", () => {
    const { container } = render(<DrawProofCard proof={null} />);
    expect(container.innerHTML).toBe("");
  });
});
