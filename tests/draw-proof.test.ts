import { describe, it, expect, beforeAll } from "vitest";
import {
  canonicalize,
  computeHash,
  computeProofHash,
  computeDrawId,
  computeParticipantsHash,
  computeTicketWeightsHash,
  computePoolHash,
  computeWinnerProofHash,
  signProof,
  verifyProofIntegrity,
  assembleDrawProof,
  type DrawProof,
  type DrawProofInput,
  type ParticipantEntry,
  type TicketWeight,
} from "@/lib/draw-proof";
import { verifyDrawProofClient, type StellarRpcClient } from "@/lib/draw-proof-verifier";

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

const SIGNING_SECRET = "draw-proof-test-secret";

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

async function assembleSignedProof(input: DrawProofInput): Promise<DrawProof> {
  return assembleDrawProof(input, { signatureSecret: SIGNING_SECRET });
}

function expectField(result: Awaited<ReturnType<typeof verifyProofIntegrity>>, name: string, status: "pass" | "fail" | "unverified") {
  expect(result.fields).toContainEqual(expect.objectContaining({ name, status }));
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

describe("signProof", () => {
  it("uses HMAC-SHA256 rather than hashing canonical + secret", async () => {
    const proof = await assembleDrawProof(await makeInput());
    const { signature, ...body } = proof;
    const hmacSignature = await signProof(body, SIGNING_SECRET);
    const naiveSignature = await computeHash(`${canonicalize(body)}:${SIGNING_SECRET}`);

    expect(hmacSignature).toHaveLength(64);
    expect(hmacSignature).not.toBe(naiveSignature);
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

  it("marks a signed 1.1.0 proof unverified when no HMAC secret is provided", async () => {
    const proof = await assembleSignedProof(await makeInput());
    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(false);
    expectField(result, "document_integrity", "unverified");
  });

  it("keeps legacy 1.0.0 document-hash signatures explicitly verifiable", async () => {
    const proof = await assembleDrawProof(await makeInput());
    proof.version = "1.0.0";
    const { signature, ...body } = proof;
    proof.signature = await computeProofHash(body);

    const result = await verifyProofIntegrity(proof);
    expect(result.verified).toBe(true);
    expectField(result, "document_integrity", "pass");
  });

  it("marks a missing signature unverified rather than failed", async () => {
    const proof = await assembleSignedProof(await makeInput());
    delete proof.signature;

    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "document_integrity", "unverified");
    expect(result.fields.some((f) => f.name === "document_integrity" && f.status === "fail")).toBe(false);
  });

  it("passes for a properly assembled proof with real commitment evidence", async () => {
    const proof = await assembleSignedProof(await makeInput());
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(true);
    expect(result.fields.every((f) => f.status === "pass")).toBe(true);
  });

  it("fails when seedHash is tampered", async () => {
    const proof = await assembleSignedProof(await makeInput());
    proof.randomness.seedHash = "tampered_hash";
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "seed_hash", "fail");
  });

  it("fails when winner proofHash is tampered", async () => {
    const proof = await assembleSignedProof(await makeInput());
    proof.winnerSelection.proofHash = "tampered_proof_hash";
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "winner_proof_hash", "fail");
  });

  it("fails when winnerAddress is changed after proofHash was set", async () => {
    const proof = await assembleSignedProof(await makeInput());
    proof.winnerSelection.winnerAddress = "addr-b";
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "winner_proof_hash", "fail");
  });

  it("fails when participantsHash is tampered", async () => {
    const proof = await assembleSignedProof(await makeInput());
    proof.snapshot.participantsHash = "tampered";
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "winner_proof_hash", "fail");
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
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "randomness_evidence", "fail");
  });

  it("fails when the revealed seed doesn't match the commitment (substituted evidence)", async () => {
    const proof = await assembleSignedProof(await makeInput());
    proof.randomness.seed = "a-different-seed-entirely";
    proof.randomness.seedHash = await computeHash(proof.randomness.seed);
    // seedHash now matches seed (self-consistent) but no longer matches the
    // original on-chain commitment — the substitution must still be caught.
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "randomness_commitment", "fail");
  });

  it("fails when randomness evidence is bound to another round (fork/replay)", async () => {
    // Randomness evidence generated for round 2, spliced onto a round 1 proof.
    const roundTwoInput = await makeInput({ roundId: 2 });
    const roundTwoProof = await assembleSignedProof(roundTwoInput);

    const roundOneInput = await makeInput({ roundId: 1 });
    const roundOneProof = await assembleSignedProof(roundOneInput);
    roundOneProof.randomness = roundTwoProof.randomness;

    const result = await verifyProofIntegrity(roundOneProof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "winner_proof_hash", "fail");
  });

  it("fails when randomness evidence is bound to another contract", async () => {
    const otherContractInput = await makeInput({ contractId: "C_OTHER" });
    const otherContractProof = await assembleSignedProof(otherContractInput);

    const proof = await assembleSignedProof(await makeInput({ contractId: "C123" }));
    proof.randomness = otherContractProof.randomness;

    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "winner_proof_hash", "fail");
  });

  it("fails when the commitment was recorded after the draw ledger (withheld-reveal / late-choice bias)", async () => {
    const proof = await assembleSignedProof(await makeInput({ commitmentLedgerSeq: 1500, drawnAtLedger: 1000 }));
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(false);
    expectField(result, "randomness_commitment", "fail");
  });
});

describe("assembleDrawProof", () => {
  it("produces a valid proof with correct hash chain", async () => {
    const proof = await assembleSignedProof(await makeInput({ payoutTxHash: "tx_hash" }));

    expect(proof.version).toBe("1.1.0");
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
    const proof = await assembleSignedProof(
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
    const proof = await assembleSignedProof(await makeInput());
    expect(proof.randomness.source).toBe("soroban_prng");
    expect(proof.winnerSelection.method).toBe("weighted_random");
  });

  it("carries external_beacon source through unchanged", async () => {
    const proof = await assembleSignedProof(await makeInput({ randomnessSource: "external_beacon" }));
    expect(proof.randomness.source).toBe("external_beacon");
    expect(proof.winnerSelection.method).toBe("weighted_random");
  });

  it("handles single participant", async () => {
    const single = [PARTICIPANTS[0]];
    const proof = await assembleSignedProof(
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
    const result = await verifyProofIntegrity(proof, SIGNING_SECRET);
    expect(result.verified).toBe(true);
  });

  // ─── roundPrincipalSnapshot wiring (#642) ───────────────────────────────────
  // The drip-pool contract already freezes a deterministic cutoff balance
  // (`Round.principal_snapshot`) at `lock_round`. These tests confirm that
  // value is wired into the proof's snapshot rather than silently dropped.

  it("records roundPrincipalSnapshot on the proof when the caller supplies it", async () => {
    const proof = await assembleSignedProof(
      await makeInput({ roundPrincipalSnapshot: "3500000" })
    );
    expect(proof.snapshot.roundPrincipalSnapshot).toBe("3500000");
  });

  it("omits roundPrincipalSnapshot when the caller has no on-chain round data (never fabricates one)", async () => {
    const proof = await assembleSignedProof(await makeInput());
    expect(proof.snapshot.roundPrincipalSnapshot).toBeUndefined();
  });
});

// ─── verifyDrawProofClient: round snapshot cross-check (#642) ────────────────

function makeMockRpc(overrides: Partial<StellarRpcClient> = {}): StellarRpcClient {
  return {
    getLedger: async (sequence: number) => ({
      id: "ledger-id",
      sequence,
      closedAt: "2026-07-24T00:00:00Z",
      hash: "ledger-hash",
    }),
    getTransaction: async (hash: string) => ({
      hash,
      ledger: 1001,
      successful: true,
      status: "SUCCESS",
    }),
    getContractData: async () => ({ value: "{}", lastModifiedLedger: 1000 }),
    ...overrides,
  };
}

describe("verifyDrawProofClient — round snapshot cross-check", () => {
  it("passes when the on-chain principal_snapshot matches the proof's recorded value", async () => {
    const input = await makeInput({ roundPrincipalSnapshot: "3500000" });
    const proof = await assembleSignedProof(input);

    const rpc = makeMockRpc({
      getContractData: async (_contractId, key) => {
        if (key === "Round:1") {
          return { value: JSON.stringify({ principal_snapshot: "3500000" }), lastModifiedLedger: 1000 };
        }
        return { value: "{}", lastModifiedLedger: 1000 };
      },
    });

    const result = await verifyDrawProofClient(proof, rpc);
    expect(result.fields).toContainEqual(
      expect.objectContaining({ name: "round_snapshot", status: "pass" })
    );
  });

  it("fails when the on-chain principal_snapshot disagrees with the proof's recorded value", async () => {
    const input = await makeInput({ roundPrincipalSnapshot: "3500000" });
    const proof = await assembleSignedProof(input);

    const rpc = makeMockRpc({
      getContractData: async (_contractId, key) => {
        if (key === "Round:1") {
          // A substituted/stale snapshot — the contract's frozen cutoff disagrees.
          return { value: JSON.stringify({ principal_snapshot: "9999999" }), lastModifiedLedger: 1000 };
        }
        return { value: "{}", lastModifiedLedger: 1000 };
      },
    });

    const result = await verifyDrawProofClient(proof, rpc);
    expect(result.fields).toContainEqual(
      expect.objectContaining({ name: "round_snapshot", status: "fail" })
    );
    expect(result.verified).toBe(false);
  });

  it("is unverified (not failed) for a pre-#642 proof with no recorded roundPrincipalSnapshot", async () => {
    const input = await makeInput();
    const proof = await assembleSignedProof(input);
    expect(proof.snapshot.roundPrincipalSnapshot).toBeUndefined();

    const rpc = makeMockRpc();
    const result = await verifyDrawProofClient(proof, rpc);
    expect(result.fields).toContainEqual(
      expect.objectContaining({ name: "round_snapshot", status: "unverified" })
    );
  });

  it("is unverified when no RPC client is provided at all", async () => {
    const input = await makeInput({ roundPrincipalSnapshot: "3500000" });
    const proof = await assembleSignedProof(input);

    const result = await verifyDrawProofClient(proof);
    expect(result.fields).toContainEqual(
      expect.objectContaining({ name: "round_snapshot", status: "unverified" })
    );
  });
});

// ─── reconcileRewardEntry (#634) ──────────────────────────────────────────────

import { reconcileRewardEntry } from "@/lib/draw-proof-verifier";

describe("reconcileRewardEntry", () => {
  let baseProof: DrawProof;

  beforeAll(async () => {
    baseProof = await assembleSignedProof(
      await makeInput({
        participants: PARTICIPANTS,
        poolState: {},
        winnerAddress: PARTICIPANTS[0].address,
        payoutAmount: "50",
        payoutAsset: "USDC",
        payoutConfirmed: true,
      })
    );
  });

  it("verifies a clean proof and a confirmed claim tx", async () => {
    const result = await reconcileRewardEntry({
      roundId: 1,
      proof: baseProof,
      isWon: true,
      claimTxHash: "tx-abc",
      claimTxSuccessful: true,
    });
    expect(result.proofStatus).toBe("verified");
    expect(result.claimStatus).toBe("claimed");
  });

  it("reports tampered when round ID does not match", async () => {
    const result = await reconcileRewardEntry({
      roundId: 999,
      proof: baseProof,
      isWon: true,
      claimTxHash: null,
      claimTxSuccessful: undefined,
    });
    expect(result.proofStatus).toBe("tampered");
    expect(result.proofDetail).toMatch(/round id mismatch/i);
    expect(result.claimStatus).toBe("unclaimed");
  });

  it("reports missing when no proof provided for a won entry", async () => {
    const result = await reconcileRewardEntry({
      roundId: 1,
      proof: null,
      isWon: true,
      claimTxHash: null,
    });
    expect(result.proofStatus).toBe("missing");
    expect(result.claimStatus).toBe("unclaimed");
  });

  it("reports pending proof for a pending (not-won) entry", async () => {
    const result = await reconcileRewardEntry({
      roundId: 1,
      proof: undefined,
      isWon: false,
      claimTxHash: null,
    });
    expect(result.proofStatus).toBe("pending");
  });

  it("reports claim pending when txHash exists but result unknown", async () => {
    const result = await reconcileRewardEntry({
      roundId: 1,
      proof: baseProof,
      isWon: true,
      claimTxHash: "tx-pending",
      claimTxSuccessful: undefined,
    });
    expect(result.claimStatus).toBe("pending");
  });

  it("reports claim failed when tx was unsuccessful", async () => {
    const result = await reconcileRewardEntry({
      roundId: 1,
      proof: baseProof,
      isWon: true,
      claimTxHash: "tx-failed",
      claimTxSuccessful: false,
    });
    expect(result.claimStatus).toBe("failed");
  });
});
