import { describe, it, expect, vi, beforeEach } from "vitest";
import { DrawProofService } from "../src/services/drawProofService.js";
import type { RpcClient } from "../src/services/drawProofService.js";
import { canonicalize, canonicalHash, canonicalStringify } from "../src/utils/canonicalJson.js";
import canonicalLegacyFixture from "../docs/fixtures/canonical-legacy-payload.json";

function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

/** RPC stub that publishes real (non-placeholder) randomness evidence for round 1. */
function makeRpc(overrides: Partial<RpcClient> = {}): RpcClient {
  return {
    getLedger: vi.fn(),
    getTransaction: vi.fn().mockResolvedValue({ hash: "tx_hash_abc", ledger: 1000, successful: true, status: "success" }),
    getContractData: vi.fn().mockRejectedValue(new Error("not found")),
    getEvents: vi.fn().mockResolvedValue({
      events: [
        {
          id: "evt-1",
          ledger: 999,
          txHash: "reveal_tx_1",
          topicXdr: [],
          valueXdr: b64Json({
            round_id: 1,
            seed: "onchain-seed",
            commitment: "onchain-commitment-hash",
            commitment_ledger: 990,
            source: "soroban_prng",
          }),
        },
      ],
    }),
    ...overrides,
  } as RpcClient;
}

function makeDrawProofService(prisma: any, rpc: RpcClient | null) {
  const featureFlags = { isEnabled: vi.fn().mockResolvedValue(true) };
  return new DrawProofService(prisma, rpc, undefined, featureFlags);
}

function makeMockPrisma(overrides: Record<string, any> = {}) {
  return {
    actionLedger: {
      findUnique: vi.fn().mockResolvedValue(overrides.action ?? null),
      findMany: vi.fn().mockResolvedValue(overrides.actions ?? []),
    },
    drawProof: {
      findUnique: vi.fn().mockResolvedValue(overrides.existingProof ?? null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: "proof-uuid", createdAt: new Date(), ...data })
      ),
      update: vi.fn().mockImplementation(({ where, data }) =>
        Promise.resolve({ id: where.drawId, ...data })
      ),
      findMany: vi.fn().mockResolvedValue(overrides.proofs ?? []),
    },
  } as any;
}

function makeSelectWinnerAction(overrides: Record<string, any> = {}) {
  return {
    id: "action-123",
    idempotencyKey: "key-123",
    walletAddress: "admin-address",
    actionType: "select_winner",
    actionPayload: {
      contract_id: "CDRYPPOOL123",
      pool_id: "CDRYPPOOL123",
      round_id: 1,
      winner: "GBBD...LLFL",
      winnerAddress: "GBBD...LLFL",
      prize: "500000",
      amount: "500000",
      asset: "USDC",
      draw_ledger: 1000,
    },
    status: "confirmed",
    txHash: "tx_hash_abc",
    sorobanEventId: "evt-123",
    correlationId: "corr-123",
    errorCode: null,
    errorDetail: null,
    retryCount: 0,
    redactedAt: null,
    createdAt: new Date("2026-07-24T00:00:00Z"),
    updatedAt: new Date("2026-07-24T00:00:00Z"),
    submittedAt: new Date("2026-07-24T00:00:00Z"),
    confirmedAt: new Date("2026-07-24T00:00:01Z"),
    ...overrides,
  };
}

describe("DrawProofService", () => {
  describe("generateProof", () => {
    it("does not generate when the prize draw feature flag is unavailable", async () => {
      const prisma = makeMockPrisma({ action: makeSelectWinnerAction() });
      const svc = new DrawProofService(prisma, makeRpc());

      await expect(svc.generateProof({ actionId: "action-123" })).resolves.toBe(null);
      expect(prisma.actionLedger.findUnique).not.toHaveBeenCalled();
    });

    it("returns null if action not found", async () => {
      const prisma = makeMockPrisma({ action: null });
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "nonexistent" });
      expect(result).toBe(null);
    });

    it("returns null if action is not select_winner", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction({ actionType: "deposit" }),
      });
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBe(null);
    });

    it("returns null if action is not confirmed", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction({ status: "pending" }),
      });
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBe(null);
    });

    it("refuses to generate a proof when no RPC client is configured (no fabricated randomness)", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
      });
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBe(null);
      expect(prisma.drawProof.create).not.toHaveBeenCalled();
    });

    it("refuses to generate a proof when the contract published no randomness evidence for the round", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
      });
      const rpc = makeRpc({ getEvents: vi.fn().mockResolvedValue({ events: [] }) });
      const svc = makeDrawProofService(prisma, rpc);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBe(null);
      expect(prisma.drawProof.create).not.toHaveBeenCalled();
    });

    it("generates a proof for a confirmed select_winner action using real on-chain randomness evidence", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
      });
      const svc = makeDrawProofService(prisma, makeRpc());
      const result = await svc.generateProof({ actionId: "action-123" });

      expect(result).not.toBeNull();
      expect(result!.drawId).toMatch(/^draw-[0-9a-f]{16}$/);
      expect(result!.roundId).toBe(1);
      expect(result!.contractId).toBe("CDRYPPOOL123");
      expect(result!.proofJson).toBeDefined();
      expect(result!.proofJson.randomness.source).toBe("soroban_prng");
      expect(result!.proofJson.randomness.seed).toBe("onchain-seed");
      expect(prisma.drawProof.create).toHaveBeenCalled();
    });

    it("records the contract's on-chain Round.principal_snapshot on the proof when available (#642)", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
      });
      const rpc = makeRpc({
        getContractData: vi.fn().mockImplementation((_contractId: string, key: string) => {
          if (key === "Round:1") {
            return Promise.resolve({ value: JSON.stringify({ principal_snapshot: "3500000" }) });
          }
          return Promise.reject(new Error("not found"));
        }),
      });
      const svc = makeDrawProofService(prisma, rpc);
      const result = await svc.generateProof({ actionId: "action-123" });

      expect(result).not.toBeNull();
      expect(result!.proofJson.snapshot.roundPrincipalSnapshot).toBe("3500000");
    });

    it("omits roundPrincipalSnapshot (never fabricates one) when the contract round data can't be fetched", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
      });
      // Default makeRpc() rejects every getContractData call.
      const svc = makeDrawProofService(prisma, makeRpc());
      const result = await svc.generateProof({ actionId: "action-123" });

      expect(result).not.toBeNull();
      expect(result!.proofJson.snapshot.roundPrincipalSnapshot).toBeUndefined();
    });

    it("returns existing proof if already generated", async () => {
      const existingProof = {
        id: "existing-uuid",
        drawId: "draw-existing",
        roundId: 1,
        contractId: "CDRYPPOOL123",
        proofJson: { version: "1.0.0", drawId: "draw-existing" },
        proofHash: "hash",
        signature: "sig",
        verified: true,
        verifiedAt: new Date(),
        verificationError: null,
        createdAt: new Date(),
      };
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction(),
        existingProof,
      });
      const svc = makeDrawProofService(prisma, makeRpc());
      const result = await svc.generateProof({ actionId: "action-123" });

      expect(result).not.toBeNull();
      expect(result!.drawId).toBe("draw-existing");
      expect(prisma.drawProof.create).not.toHaveBeenCalled();
    });

    it("returns null if winner is missing from payload", async () => {
      const prisma = makeMockPrisma({
        action: makeSelectWinnerAction({
          actionPayload: { contract_id: "C123", round_id: 1 },
        }),
      });
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBe(null);
    });

    it("produces the same canonical proof hash for equivalent payloads with different key ordering", async () => {
      const action = makeSelectWinnerAction();
      const prismaA = makeMockPrisma({ action });
      const svcA = makeDrawProofService(prismaA, makeRpc());
      const resultA = await svcA.generateProof({ actionId: "action-123" });

      const reordered = {
        draw_ledger: 1000,
        asset: "USDC",
        amount: "500000",
        prize: "500000",
        winnerAddress: "GBBD...LLFL",
        winner: "GBBD...LLFL",
        round_id: 1,
        pool_id: "CDRYPPOOL123",
        contract_id: "CDRYPPOOL123",
      };
      const prismaB = makeMockPrisma({
        action: makeSelectWinnerAction({ actionPayload: reordered }),
      });
      const svcB = makeDrawProofService(prismaB, makeRpc());
      const resultB = await svcB.generateProof({ actionId: "action-123" });

      expect(resultA).not.toBeNull();
      expect(resultB).not.toBeNull();
      expect(resultA!.proofHash).toBe(resultB!.proofHash);
    });

    it("normalizes numeric precision and casing when computing the canonical proof hash", async () => {
      const action = makeSelectWinnerAction();
      const prismaA = makeMockPrisma({ action });
      const svcA = makeDrawProofService(prismaA, makeRpc());
      const resultA = await svcA.generateProof({ actionId: "action-123" });

      const nonCanonical = makeSelectWinnerAction();
      nonCanonical.actionPayload = {
        ...nonCanonical.actionPayload,
        prize: "500000.0000",
        amount: "500000.0000",
        asset: "usdc",
      };
      const prismaB = makeMockPrisma({ action: nonCanonical });
      const svcB = makeDrawProofService(prismaB, makeRpc());
      const resultB = await svcB.generateProof({ actionId: "action-123" });

      expect(resultA).not.toBeNull();
      expect(resultB).not.toBeNull();
      expect(resultA!.proofHash).toBe(resultB!.proofHash);
    });

    it("rejects non-canonical inputs that cannot be normalized (e.g. negative amounts)", async () => {
      const action = makeSelectWinnerAction();
      action.actionPayload = { ...action.actionPayload, prize: "-500000" };
      const prisma = makeMockPrisma({ action });
      const svc = makeDrawProofService(prisma, makeRpc());
      const result = await svc.generateProof({ actionId: "action-123" });
      expect(result).toBe(null);
    });

    const invalidPayloads: Array<[string, Record<string, unknown>]> = [
      ["malformed prize", { prize: "5e99999" }],
      ["zero prize", { prize: "0.000" }],
      ["unsafe round number", { round_id: Number.MAX_SAFE_INTEGER + 1 }],
    ];
    it.each(invalidPayloads)("refuses %s before requesting chain evidence", async (_name, invalidFields) => {
      const action = makeSelectWinnerAction();
      action.actionPayload = { ...action.actionPayload, ...invalidFields };
      const rpc = makeRpc();
      const svc = makeDrawProofService(makeMockPrisma({ action }), rpc);

      await expect(svc.generateProof({ actionId: "action-123" })).resolves.toBe(null);
      expect(rpc.getEvents).not.toHaveBeenCalled();
    });
  });

  describe("verifyProof", () => {
    it("returns null if proof not found", async () => {
      const prisma = makeMockPrisma();
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.verifyProof("nonexistent");
      expect(result).toBe(null);
    });

    it("verifies a proof and updates verification status", async () => {
      const storedProof = {
        id: "proof-uuid",
        drawId: "draw-test-001",
        roundId: 1,
        contractId: "C123",
        proofJson: {
          version: "1.0.0",
          drawId: "draw-test-001",
          roundId: 1,
          contractId: "C123",
          snapshot: {
            ledgerSeq: 1000,
            ledgerCloseTime: "2026-07-24T00:00:00Z",
            participantsHash: "abc123",
            participantCount: 1,
            totalDeposits: "1000000",
            poolHash: "pool123",
          },
          randomness: {
            source: "deterministic_placeholder",
            seed: "seed-123",
            seedHash: "seed_hash_123",
            drawnAtLedger: 1000,
          },
          winnerSelection: {
            method: "deterministic_placeholder",
            ticketWeightsHash: "weights123",
            winnerAddress: "addr-a",
            winnerWeight: "1000000",
            totalWeight: "1000000",
            proofHash: "proof123",
          },
          payout: {
            amount: "500000",
            asset: "USDC",
            txHash: "tx_abc",
            ledgerSeq: 1001,
            recipientConfirmed: true,
          },
          metadata: {
            createdAt: "2026-07-24T00:00:00Z",
            engineVersion: "1.0.0",
            contractSpecHash: "spec",
          },
          signature: "placeholder_sig",
        },
        proofHash: "hash",
        signature: "placeholder_sig",
        verified: false,
        verifiedAt: null,
        verificationError: null,
        createdAt: new Date(),
      };

      const prisma = makeMockPrisma({ existingProof: storedProof });
      prisma.drawProof.findUnique.mockResolvedValue(storedProof);
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.verifyProof("draw-test-001");

      expect(result).not.toBeNull();
      expect(result!.verification.fields.length).toBeGreaterThan(0);
      expect(prisma.drawProof.update).toHaveBeenCalled();
    });

    it("verifies a legacy proof that was stored with non-canonical key ordering", async () => {
      const legacyProof = {
        id: "legacy-uuid",
        drawId: "draw-legacy-001",
        roundId: 1,
        contractId: "C123",
        proofJson: {
          signature: "legacy_sig",
          metadata: { contractSpecHash: "spec", engineVersion: "1.0.0", createdAt: "2026-07-24T00:00:00Z" },
          payout: { recipientConfirmed: true, ledgerSeq: 1001, txHash: "tx_abc", asset: "USDC", amount: "500000" },
          winnerSelection: { proofHash: "proof123", totalWeight: "1000000", winnerWeight: "1000000", winnerAddress: "addr-a", ticketWeightsHash: "weights123", method: "deterministic_placeholder" },
          randomness: { drawnAtLedger: 1000, seedHash: "seed_hash_123", seed: "seed-123", source: "deterministic_placeholder" },
          snapshot: { poolHash: "pool123", totalDeposits: "1000000", participantCount: 1, participantsHash: "abc123", ledgerCloseTime: "2026-07-24T00:00:00Z", ledgerSeq: 1000 },
          contractId: "C123",
          roundId: 1,
          drawId: "draw-legacy-001",
          version: "1.0.0",
        },
        proofHash: "legacy-hash",
        signature: "legacy_sig",
        verified: false,
        verifiedAt: null,
        verificationError: null,
        createdAt: new Date(),
      };

      const prisma = makeMockPrisma({ existingProof: legacyProof });
      prisma.drawProof.findUnique.mockResolvedValue(legacyProof);
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.verifyProof("draw-legacy-001");

      expect(result).not.toBeNull();
      expect(result!.verification.fields.length).toBeGreaterThan(0);
    });
  });

  describe("getProof", () => {
    it("returns null if not found", async () => {
      const prisma = makeMockPrisma();
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.getProof("nonexistent");
      expect(result).toBe(null);
    });

    it("returns proof record if found", async () => {
      const storedProof = {
        id: "proof-uuid",
        drawId: "draw-123",
        roundId: 1,
        contractId: "C123",
        proofJson: { version: "1.0.0" },
        proofHash: "hash",
        signature: "sig",
        verified: true,
        verifiedAt: new Date(),
        verificationError: null,
        createdAt: new Date(),
      };
      const prisma = makeMockPrisma({ existingProof: storedProof });
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.getProof("draw-123");
      expect(result).not.toBeNull();
      expect(result!.drawId).toBe("draw-123");
    });
  });

  describe("listProofs", () => {
    it("returns paginated proofs", async () => {
      const proofs = [
        { id: "1", drawId: "d1", roundId: 1, contractId: "C1", proofJson: {}, proofHash: "h1", signature: null, verified: false, verifiedAt: null, verificationError: null, createdAt: new Date() },
        { id: "2", drawId: "d2", roundId: 2, contractId: "C1", proofJson: {}, proofHash: "h2", signature: null, verified: true, verifiedAt: new Date(), verificationError: null, createdAt: new Date() },
      ];
      const prisma = makeMockPrisma({ proofs });
      const svc = makeDrawProofService(prisma, null);
      const result = await svc.listProofs({ contractId: "C1", limit: 10 });
      expect(result.items).toHaveLength(2);
    });
  });
});

describe("canonicalJSON", () => {
  it("produces identical output for equivalent objects with different key ordering", () => {
    const a = { b: 2, a: 1, c: { z: 1, y: 2 } };
    const b = { c: { y: 2, z: 1 }, a: 1, b: 2 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("normalizes numeric precision for decimal strings", () => {
    const a = { amount: "500000.0000" };
    const b = { amount: "500000" };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("normalizes casing for asset codes", () => {
    const a = { asset: "usdc" };
    const b = { asset: "USDC" };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("strips insignificant whitespace from string values", () => {
    const a = { winner: " GBBD...LLFL " };
    const b = { winner: "GBBD...LLFL" };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it("produces the same hash for equivalent payloads", () => {
    const a = { round_id: 1, winner: "GBBD...LLFL", prize: "500000.0000" };
    const b = { prize: "500000", winner: "GBBD...LLFL", round_id: 1 };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("normalizes legacy payloads with non-canonical key ordering and precision", () => {
    const legacy = {
      signature: "legacy_sig",
      payout: { recipientConfirmed: true, ledgerSeq: 1001, txHash: "tx_abc", asset: "USDC", amount: "500000.0000" },
      version: "1.0.0",
    };
    const normalized = {
      version: "1.0.0",
      payout: { amount: "500000", asset: "USDC", txHash: "tx_abc", ledgerSeq: 1001, recipientConfirmed: true },
      signature: "legacy_sig",
    };
    expect(canonicalStringify(legacy)).toBe(canonicalStringify(normalized));
  });

  it("keeps the documented legacy payload fixture stable", () => {
    expect(canonicalStringify(canonicalLegacyFixture.legacyPayload)).toBe(canonicalLegacyFixture.canonical);
  });

  it("rejects unsupported numeric values consistently", () => {
    expect(() => canonicalize({ amount: NaN })).toThrow();
    expect(() => canonicalize({ amount: Infinity })).toThrow();
  });

  it("rejects unsafe integer values rather than hashing rounded data", () => {
    expect(() => canonicalize({ roundId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/unsafe integer/i);
    expect(() => canonicalize({ amount: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/unsafe integer/i);
  });

  it("bounds exponent expansion and rejects key collisions after trimming", () => {
    expect(() => canonicalize({ amount: "1e1025" })).toThrow(/exponent/i);
    expect(() => canonicalize({ " wallet ": "a", wallet: "b" })).toThrow(/duplicate key/i);
  });

  it("preserves a JSON __proto__ property as ordinary payload data", () => {
    const value = JSON.parse('{"__proto__":{"signed":true}}');
    expect(canonicalStringify(value)).toBe('{"__proto__":{"signed":true}}');
    expect(Object.prototype).not.toHaveProperty("signed");
  });

  it("applies field allowlists only at the top level and rejects unknown keys in strict mode", () => {
    expect(canonicalStringify({ a: 1, nested: { keep: 2, drop: 3 } }, { allowedKeys: ["a", "nested"] }))
      .toBe('{"a":"1","nested":{"drop":"3","keep":"2"}}');
    expect(() => canonicalize({ a: 1, extra: 2 }, { allowedKeys: ["a"], strict: true }))
      .toThrow(/unknown top-level key/i);
  });
});
