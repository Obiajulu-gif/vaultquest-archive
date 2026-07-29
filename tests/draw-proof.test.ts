import { describe, it, expect } from "vitest";
import {
  canonicalize,
  computeHash,
  computeProofHash,
  computeDrawId,
  computeParticipantsHash,
  computeTicketWeightsHash,
  computePoolHash,
  computeWinnerProofHash,
  verifyProofIntegrity,
  assembleDrawProof,
  type DrawProof,
  type DrawProofInput,
  type ParticipantEntry,
  type TicketWeight,
} from "@/lib/draw-proof";

const PARTICIPANTS: ParticipantEntry[] = [
  { address: "addr-b", deposit: "1000000", lockupMultiplier: 150 },
  { address: "addr-a", deposit: "2000000", lockupMultiplier: 100 },
  { address: "addr-c", deposit: "500000", lockupMultiplier: 200 },
];

const WEIGHTS: TicketWeight[] = [
  { address: "addr-a", weight: "2000000" },
  { address: "addr-b", weight: "1500000" },
  { address: "addr-c", weight: "1000000" },
];

/** Builds a valid DrawProofInput with a real commit(seed) = sha256(seed) binding. */
async function makeInput(overrides: Partial<DrawProofInput> = {}): Promise<DrawProofInput> {
  const seed = overrides.randomnessSeed ?? "seed-value";
  const commitment = await computeHash(seed);
  return {
    roundId: 1,
    contractId: "C123",
    participants: PARTICIPANTS,
    poolState: { admin: "addr-admin", total_deposited: "3500000" },
    randomnessSource: "soroban_prng",
    randomnessSeed: seed,
    randomnessCommitment: commitment,
    commitmentLedgerSeq: 999,
    revealTxHash: "reveal_tx",
    drawnAtLedger: 1000,
    winnerAddress: "addr-a",
    payoutTxHash: "tx_abc",
    payoutLedgerSeq: 1001,
    payoutAmount: "500000",
    payoutAsset: "USDC",
    payoutConfirmed: true,
    contractSpecHash: "spec_v1",
    ...overrides,
  };
}

function makeProof(overrides: Partial<DrawProof> = {}): DrawProof {
  return {
    version: "1.0.0",
    drawId: "draw-abc123",
    roundId: 1,
    contractId: "CDRYPPOOL123",
    snapshot: {
      ledgerSeq: 1000,
      ledgerCloseTime: "2026-07-24T00:00:00Z",
      participantsHash: "hash_participants",
      participantCount: 3,
      totalDeposits: "3500000",
      poolHash: "hash_pool",
    },
    randomness: {
      source: "soroban_prng",
      seed: "test-seed-123",
      seedHash: "hash_seed",
      commitment: "hash_commitment",
      commitmentLedgerSeq: 999,
      revealTxHash: "reveal_tx_123",
      drawnAtLedger: 1000,
    },
    winnerSelection: {
      method: "weighted_random",
      ticketWeightsHash: "hash_weights",
      winnerAddress: "addr-a",
      winnerWeight: "2000000",
      totalWeight: "4500000",
      proofHash: "hash_proof",
    },
    payout: {
      amount: "500000",
      asset: "USDC",
      txHash: "tx_hash_123",
      ledgerSeq: 1001,
      recipientConfirmed: true,
    },
    metadata: {
      createdAt: "2026-07-24T00:00:00Z",
      engineVersion: "1.0.0",
      contractSpecHash: "spec_hash",
    },
    signature: "sig_123",
    ...overrides,
  };
}

describe("canonicalize", () => {
  it("produces deterministic output for the same input", () => {
    const proof = makeProof();
    const { signature, ...body } = proof;
    const a = canonicalize(body);
    const b = canonicalize(body);
    expect(a).toBe(b);
  });

  it("is independent of property insertion order", () => {
    const a = canonicalize({ z: 1, a: 2, m: 3 } as any);
    const b = canonicalize({ a: 2, m: 3, z: 1 } as any);
    expect(a).toBe(b);
  });

  it("sorts nested keys", () => {
    const a = canonicalize({ b: { z: 1, a: 2 }, a: 1 } as any);
    const b = canonicalize({ a: 1, b: { a: 2, z: 1 } } as any);
    expect(a).toBe(b);
  });

  it("excludes signature field", () => {
    const withSig = canonicalize({ a: 1, signature: "abc" } as any);
    const withoutSig = canonicalize({ a: 1 } as any);
    expect(withSig).toBe(withoutSig);
  });
});

describe("computeHash", () => {
  it("returns consistent SHA-256 hex", async () => {
    const a = await computeHash("hello world");
    const b = await computeHash("hello world");
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(a)).toBe(true);
  });

  it("produces different hashes for different inputs", async () => {
    const a = await computeHash("hello");
    const b = await computeHash("world");
    expect(a).not.toBe(b);
  });
});

describe("computeProofHash", () => {
  it("returns deterministic hash for same proof body", async () => {
    const proof = makeProof();
    const { signature, ...body } = proof;
    const a = await computeProofHash(body);
    const b = await computeProofHash(body);
    expect(a).toBe(b);
  });

  it("changes when any field changes", async () => {
    const base = makeProof();
    const { signature: _, ...body } = base;
    const original = await computeProofHash(body);

    const modified = { ...body, roundId: 2 };
    const changed = await computeProofHash(modified);
    expect(changed).not.toBe(original);
  });
});

describe("computeDrawId", () => {
  it("returns deterministic draw ID", async () => {
    const a = await computeDrawId("C123", 1, 1000);
    const b = await computeDrawId("C123", 1, 1000);
    expect(a).toBe(b);
    expect(a).toMatch(/^draw-[0-9a-f]{16}$/);
  });

  it("changes with different inputs", async () => {
    const a = await computeDrawId("C123", 1, 1000);
    const b = await computeDrawId("C123", 2, 1000);
    expect(a).not.toBe(b);
  });
});

describe("computeParticipantsHash", () => {
  it("is order-independent", async () => {
    const a = await computeParticipantsHash(PARTICIPANTS);
    const reversed = [...PARTICIPANTS].reverse();
    const b = await computeParticipantsHash(reversed);
    expect(a).toBe(b);
  });

  it("changes with different participants", async () => {
    const a = await computeParticipantsHash(PARTICIPANTS);
    const fewer = PARTICIPANTS.slice(0, 2);
    const b = await computeParticipantsHash(fewer);
    expect(a).not.toBe(b);
  });
});

describe("computeTicketWeightsHash", () => {
  it("is order-independent", async () => {
    const a = await computeTicketWeightsHash(WEIGHTS);
    const reversed = [...WEIGHTS].reverse();
    const b = await computeTicketWeightsHash(reversed);
    expect(a).toBe(b);
  });
});

describe("computePoolHash", () => {
  it("is key-order independent", async () => {
    const a = await computePoolHash({ x: 1, y: 2, z: 3 });
    const b = await computePoolHash({ z: 3, x: 1, y: 2 });
    expect(a).toBe(b);
  });

  it("changes with different state", async () => {
    const a = await computePoolHash({ total: "100" });
    const b = await computePoolHash({ total: "200" });
    expect(a).not.toBe(b);
  });
});

describe("computeWinnerProofHash", () => {
  it("produces deterministic hash", async () => {
    const a = await computeWinnerProofHash("C1", 1, "addr-a", "seed_hash", "part_hash");
    const b = await computeWinnerProofHash("C1", 1, "addr-a", "seed_hash", "part_hash");
    expect(a).toBe(b);
  });

  it("changes with different winner", async () => {
    const a = await computeWinnerProofHash("C1", 1, "addr-a", "seed", "part");
    const b = await computeWinnerProofHash("C1", 1, "addr-b", "seed", "part");
    expect(a).not.toBe(b);
  });

  it("changes with different seed", async () => {
    const a = await computeWinnerProofHash("C1", 1, "addr-a", "seed1", "part");
    const b = await computeWinnerProofHash("C1", 1, "addr-a", "seed2", "part");
    expect(a).not.toBe(b);
  });

  it("changes with different participants", async () => {
    const a = await computeWinnerProofHash("C1", 1, "addr-a", "seed", "part1");
    const b = await computeWinnerProofHash("C1", 1, "addr-a", "seed", "part2");
    expect(a).not.toBe(b);
  });

  it("changes with different round (blocks cross-round replay)", async () => {
    const a = await computeWinnerProofHash("C1", 1, "addr-a", "seed", "part");
    const b = await computeWinnerProofHash("C1", 2, "addr-a", "seed", "part");
    expect(a).not.toBe(b);
  });

  it("changes with different contract (blocks wrong-contract substitution)", async () => {
    const a = await computeWinnerProofHash("C1", 1, "addr-a", "seed", "part");
    const b = await computeWinnerProofHash("C2", 1, "addr-a", "seed", "part");
    expect(a).not.toBe(b);
  });
});

describe("verifyProofIntegrity", () => {
  it("passes for a properly assembled proof with real commitment evidence", async () => {
    const proof = await assembleDrawProof(await makeInput());
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(true);
    expect(result.fields.every((f) => f.status === "pass")).toBe(true);
  });

  it("fails when seedHash is tampered", async () => {
    const proof = await assembleDrawProof(await makeInput());
    proof.randomness.seedHash = "tampered_hash";
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
    expect(result.fields.some((f) => f.status === "fail")).toBe(true);
  });

  it("fails when winner proofHash is tampered", async () => {
    const proof = await assembleDrawProof(await makeInput());
    proof.winnerSelection.proofHash = "tampered_proof_hash";
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
  });

  it("fails when winnerAddress is changed after proofHash was set", async () => {
    const proof = await assembleDrawProof(await makeInput());
    proof.winnerSelection.winnerAddress = "addr-b";
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
  });

  it("fails when participantsHash is tampered", async () => {
    const proof = await assembleDrawProof(await makeInput());
    proof.snapshot.participantsHash = "tampered";
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
  });

  it("fails when randomness evidence is missing (schema rejects deterministic_placeholder source)", async () => {
    const proof = makeProof({
      randomness: {
        source: "deterministic_placeholder" as any,
        seed: "predictable-seed",
        seedHash: "hash_seed",
        commitment: "hash_commitment",
        commitmentLedgerSeq: 999,
        revealTxHash: "reveal_tx",
        drawnAtLedger: 1000,
      },
    });
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
  });

  it("fails when the revealed seed doesn't match the commitment (substituted evidence)", async () => {
    const proof = await assembleDrawProof(await makeInput());
    proof.randomness.seed = "a-different-seed-entirely";
    proof.randomness.seedHash = await computeHash(proof.randomness.seed);
    // seedHash now matches seed (self-consistent) but no longer matches the
    // original on-chain commitment — the substitution must still be caught.
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
    expect(result.fields.some((f) => f.name === "randomness_commitment" && f.status === "fail")).toBe(true);
  });

  it("fails when randomness evidence is bound to another round (fork/replay)", async () => {
    // Randomness evidence generated for round 2, spliced onto a round 1 proof.
    const roundTwoInput = await makeInput({ roundId: 2 });
    const roundTwoProof = await assembleDrawProof(roundTwoInput);

    const roundOneInput = await makeInput({ roundId: 1 });
    const roundOneProof = await assembleDrawProof(roundOneInput);
    roundOneProof.randomness = roundTwoProof.randomness;

    const result = await verifyProofIntegrity(roundOneProof);
    expect(result.verified).toBe(false);
    expect(result.fields.some((f) => f.name === "winner_proof_hash" && f.status === "fail")).toBe(true);
  });

  it("fails when randomness evidence is bound to another contract", async () => {
    const otherContractInput = await makeInput({ contractId: "C_OTHER" });
    const otherContractProof = await assembleDrawProof(otherContractInput);

    const proof = await assembleDrawProof(await makeInput({ contractId: "C123" }));
    proof.randomness = otherContractProof.randomness;

    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
  });

  it("fails when the commitment was recorded after the draw ledger (withheld-reveal / late-choice bias)", async () => {
    const proof = await assembleDrawProof(await makeInput({ commitmentLedgerSeq: 1500, drawnAtLedger: 1000 }));
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
    expect(result.fields.some((f) => f.name === "randomness_commitment" && f.status === "fail")).toBe(true);
  });
});

describe("assembleDrawProof", () => {
  it("produces a valid proof with correct hash chain", async () => {
    const proof = await assembleDrawProof(await makeInput({ payoutTxHash: "tx_hash" }));

    expect(proof.version).toBe("1.0.0");
    expect(proof.drawId).toMatch(/^draw-[0-9a-f]{16}$/);
    expect(proof.roundId).toBe(1);
    expect(proof.contractId).toBe("C123");
    expect(proof.snapshot.participantCount).toBe(3);
    expect(proof.snapshot.totalDeposits).toBe("3500000");
    expect(proof.winnerSelection.winnerAddress).toBe("addr-a");
    expect(proof.payout.txHash).toBe("tx_hash");
    expect(proof.signature).toBeDefined();
  });

  it("computes correct total weight from deposit * lockup_multiplier", async () => {
    const proof = await assembleDrawProof(
      await makeInput({ payoutAmount: "100", payoutAsset: "XLM", payoutConfirmed: false })
    );

    // addr-a: 2000000 * 100 = 200000000
    // addr-b: 1000000 * 150 = 150000000
    // addr-c: 500000 * 200  = 100000000
    // total = 450000000
    expect(proof.winnerSelection.totalWeight).toBe("450000000");
    expect(proof.winnerSelection.winnerWeight).toBe("200000000");
  });

  it("always uses weighted_random method (no placeholder method remains)", async () => {
    const proof = await assembleDrawProof(await makeInput());
    expect(proof.randomness.source).toBe("soroban_prng");
    expect(proof.winnerSelection.method).toBe("weighted_random");
  });

  it("carries external_beacon source through unchanged", async () => {
    const proof = await assembleDrawProof(await makeInput({ randomnessSource: "external_beacon" }));
    expect(proof.randomness.source).toBe("external_beacon");
    expect(proof.winnerSelection.method).toBe("weighted_random");
  });

  it("handles single participant", async () => {
    const single = [PARTICIPANTS[0]];
    const proof = await assembleDrawProof(
      await makeInput({
        participants: single,
        poolState: {},
        winnerAddress: single[0].address,
        payoutAmount: "100",
        payoutAsset: "XLM",
        payoutConfirmed: false,
      })
    );

    expect(proof.snapshot.participantCount).toBe(1);
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(true);
  });
});
