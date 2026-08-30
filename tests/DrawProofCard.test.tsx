import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import DrawProofCard from "@/components/app/DrawProofCard";
import { assembleDrawProof, computeHash, computeProofHash, type DrawProofInput } from "@/lib/draw-proof";

async function buildInput(overrides: Partial<DrawProofInput> = {}): Promise<DrawProofInput> {
  return {
    roundId: 5,
    contractId: "CDRYPPOOL123",
    participants: [
      { address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", deposit: "2000000", lockupMultiplier: 100 },
      { address: "addr-b", deposit: "3000000", lockupMultiplier: 100 },
    ],
    poolState: { admin: "addr-admin", total_deposited: "5000000" },
    randomnessSource: "soroban_prng",
    randomnessSeed: "card-test-seed",
    randomnessCommitment: await computeHash("card-test-seed"),
    commitmentLedgerSeq: 999,
    revealTxHash: "reveal_tx_card",
    drawnAtLedger: 1000,
    winnerAddress: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    payoutTxHash: "tx_hash_abc123",
    payoutLedgerSeq: 1001,
    payoutAmount: "500000",
    payoutAsset: "USDC",
    payoutConfirmed: true,
    contractSpecHash: "spec123",
    ...overrides,
  };
}

/**
 * A proof whose document-integrity checks genuinely pass verifyProofIntegrity
 * with no signing secret — i.e. a legacy 1.0.0 document-hash signature, the
 * only proof shape a browser can fully self-verify without a server secret.
 */
async function buildValidProof() {
  const input = await buildInput();
  const assembled = await assembleDrawProof(input);
  const proof = { ...assembled, version: "1.0.0" as const };
  const { signature: _sig, ...body } = proof;
  proof.signature = await computeProofHash(body);
  return {
    id: "proof-uuid",
    draw_id: proof.drawId,
    round_id: proof.roundId,
    contract_id: proof.contractId,
    proof,
    proof_hash: proof.signature,
    signature: proof.signature,
    verified: true,
    verified_at: "2026-07-24T00:01:00Z",
    verification_error: null,
    created_at: "2026-07-24T00:00:00Z",
  };
}

describe("DrawProofCard", () => {
  it("renders round number", async () => {
    render(<DrawProofCard proof={await buildValidProof()} />);
    expect(screen.getByText("Round #5")).toBeDefined();
  });

  it("renders a Verified badge only after the local integrity check passes, not from the API flag alone (#621)", async () => {
    render(<DrawProofCard proof={await buildValidProof()} />);

    // Before the async local check resolves, the draw is not shown as final.
    expect(screen.queryByText("Verified")).toBeNull();

    await waitFor(() => expect(screen.getByText("Verified")).toBeInTheDocument());
  });

  it("marks the draw as Failed when the API says verified=true but the embedded proof document is tampered (#621)", async () => {
    const valid = await buildValidProof();
    const tamperedProof = {
      ...valid,
      // Backend still claims this draw verified...
      verified: true,
      verification_error: null,
      // ...but the winner in the embedded document has been swapped, which
      // breaks winner_proof_hash under recomputation. The card must not
      // display this winner as a normal, final result.
      proof: {
        ...valid.proof,
        winnerSelection: {
          ...valid.proof.winnerSelection,
          winnerAddress: "GATTACKER00000000000000000000000000000000000000000000000",
        },
      },
    };

    render(<DrawProofCard proof={tamperedProof} />);

    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
    expect(screen.queryByText("Verified")).toBeNull();
    expect(
      screen.getByText(/This draw could not be independently verified/),
    ).toBeInTheDocument();
  });

  it("renders unverified badge for a proof with no document at all", async () => {
    render(<DrawProofCard proof={{ id: "no-doc", round_id: 5, verified: false, verification_error: null }} />);
    await waitFor(() => expect(screen.getByText("Failed")).toBeInTheDocument());
  });

  it("renders prize amount", async () => {
    render(<DrawProofCard proof={await buildValidProof()} />);
    expect(screen.getByText("0.50 USDC")).toBeDefined();
  });

  it("renders winner address truncated", async () => {
    render(<DrawProofCard proof={await buildValidProof()} />);
    expect(screen.getByText("GBBD47...FLA5")).toBeDefined();
  });

  it("renders View Proof button when onViewProof provided", async () => {
    const onViewProof = vi.fn();
    render(<DrawProofCard proof={await buildValidProof()} onViewProof={onViewProof} />);
    expect(screen.getByText("View Proof →")).toBeDefined();
  });

  it("does not render View Proof button when onViewProof not provided", async () => {
    render(<DrawProofCard proof={await buildValidProof()} />);
    expect(screen.queryByText("View Proof →")).toBeNull();
  });

  it("returns null for null proof", () => {
    const { container } = render(<DrawProofCard proof={null} />);
    expect(container.innerHTML).toBe("");
  });
});
