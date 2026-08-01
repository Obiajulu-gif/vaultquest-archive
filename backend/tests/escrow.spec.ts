import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import {
  EscrowService,
  type HorizonGateway,
  type AdminSigner,
  type TransactionAssembler,
  type SubmitResult,
  type PayoutVerifier,
  type VerifiedPayoutFacts
} from "../src/services/escrowService.js";
import { SavingsService } from "../src/services/savingsService.js";

const PASSPHRASE = "Test SDF Network ; September 2015";

function makeSigner(): AdminSigner {
  return {
    publicKey: "GADMIN0000000000000000000000000000000000000000000000000",
    async sign(xdr) {
      return `signed:${xdr}`;
    }
  };
}

const assembler: TransactionAssembler = {
  async assemble(input) {
    return {
      xdr: `xdr:${input.vaultId}:${input.sequence}`,
      sourceAccount: "GADMIN",
      sequence: input.sequence
    };
  }
};

/** Verifier stub that always returns the same (or no) finalized facts. */
function scriptedVerifier(facts: VerifiedPayoutFacts | null): PayoutVerifier & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async verify(txHash) {
      calls.push(txHash);
      return facts;
    }
  };
}

/** Horizon stub whose submit results are scripted per call. */
function scriptedHorizon(results: SubmitResult[]): HorizonGateway & { seqLoads: number; submits: string[] } {
  let seq = 100;
  const submits: string[] = [];
  let i = 0;
  return {
    seqLoads: 0,
    submits,
    async loadSequence() {
      this.seqLoads += 1;
      return String(seq++);
    },
    async submit(signedXdr) {
      submits.push(signedXdr);
      const r = results[Math.min(i, results.length - 1)] as SubmitResult;
      i += 1;
      return r;
    }
  };
}

describe("EscrowService settlement pipeline", () => {
  let db: TestDb;
  beforeAll(async () => { db = await startTestDb(); });
  afterAll(async () => { await db.stop(); });
  beforeEach(async () => {
    await resetDb(db.prisma);
    await db.prisma.vaultSettlement.deleteMany({});
  });

  it("prepares, signs and submits a successful release, saving the tx hash", async () => {
    const horizon = scriptedHorizon([{ hash: "tx_abc", successful: true, resultCode: "tx_success" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v1", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome.state).toBe("Resolved");
    expect(outcome.txHash).toBe("tx_abc");
    expect(horizon.submits[0]).toContain("signed:xdr:v1");

    const row = await db.prisma.vaultSettlement.findUnique({ where: { vaultId: "v1" } });
    expect(row?.txHash).toBe("tx_abc");
    expect(row?.state).toBe("Resolved");
  });

  it("is idempotent: a resolved vault is not resubmitted", async () => {
    const horizon = scriptedHorizon([{ hash: "tx_once", successful: true, resultCode: "tx_success" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    await svc.settleVault({ vaultId: "v2", settlementType: "release", recipient: "GWIN", amount: "100" });
    const second = await svc.settleVault({ vaultId: "v2", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(second.alreadySettled).toBe(true);
    expect(second.txHash).toBe("tx_once");
    expect(horizon.submits).toHaveLength(1); // not resubmitted
  });

  it("retries on a transient tx_bad_seq, reloading the sequence each time", async () => {
    const horizon = scriptedHorizon([
      { hash: "", successful: false, resultCode: "tx_bad_seq" },
      { hash: "", successful: false, resultCode: "tx_bad_seq" },
      { hash: "tx_ok", successful: true, resultCode: "tx_success" }
    ]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v3", settlementType: "distribute", amount: "100" });

    expect(outcome.state).toBe("Resolved");
    expect(outcome.txHash).toBe("tx_ok");
    expect(outcome.attempts).toBe(3);
    expect(horizon.seqLoads).toBe(3); // sequence reloaded per attempt
  });

  it("rolls back to Unresolved when submission ultimately fails", async () => {
    const horizon = scriptedHorizon([{ hash: "", successful: false, resultCode: "tx_bad_seq" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v4", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome.state).toBe("Unresolved");
    expect(outcome.txHash).toBeNull();

    const row = await db.prisma.vaultSettlement.findUnique({ where: { vaultId: "v4" } });
    expect(row?.state).toBe("Unresolved");
    expect(row?.errorCode).toBe("SETTLEMENT_RETRIES_EXHAUSTED");
  });

  it("does not retry a non-retryable failure", async () => {
    const horizon = scriptedHorizon([{ hash: "", successful: false, resultCode: "tx_insufficient_balance" }]);
    const svc = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });

    const outcome = await svc.settleVault({ vaultId: "v5", settlementType: "release", recipient: "GWIN", amount: "100" });

    expect(outcome.state).toBe("Unresolved");
    expect(outcome.attempts).toBe(1);
    expect(horizon.submits).toHaveLength(1);
  });

  it("SavingsService settles a concluded period across vaults", async () => {
    const horizon = scriptedHorizon([{ hash: "h", successful: true, resultCode: "tx_success" }]);
    const escrow = new EscrowService({
      prisma: db.prisma, horizon, signer: makeSigner(), assembler,
      networkPassphrase: PASSPHRASE, sleep: async () => {}
    });
    const savings = new SavingsService(escrow);

    const result = await savings.settleConcludedPeriod([
      { vaultId: "p1", settlementType: "release", recipient: "GA", amount: "10" },
      { vaultId: "p2", settlementType: "refund", recipient: "GB", amount: "5" }
    ]);

    expect(result.total).toBe(2);
    expect(result.resolved).toBe(1);
    expect(result.refunded).toBe(1);
  });

  // #509: settleVault must independently confirm a payout against finalized
  // chain state before reporting Resolved, rather than trusting Horizon's
  // synchronous `successful` flag alone.
  describe("#509 payout verification", () => {
    it("resolves and reports payoutVerified when the finalized event matches", async () => {
      const horizon = scriptedHorizon([{ hash: "tx_v1", successful: true, resultCode: "tx_success" }]);
      const verifier = scriptedVerifier({ recipient: "GWIN", amount: "100" });
      const svc = new EscrowService({
        prisma: db.prisma, horizon, signer: makeSigner(), assembler, verifier,
        networkPassphrase: PASSPHRASE, sleep: async () => {}
      });

      const outcome = await svc.settleVault({ vaultId: "vv1", settlementType: "release", recipient: "GWIN", amount: "100" });

      expect(outcome.state).toBe("Resolved");
      expect(outcome.payoutVerified).toBe(true);
      expect(verifier.calls).toEqual(["tx_v1"]);
    });

    it("parks as PendingVerification (not Unresolved) when the finalized event mismatches", async () => {
      const horizon = scriptedHorizon([{ hash: "tx_v2", successful: true, resultCode: "tx_success" }]);
      // Finalized event disagrees with the intended recipient/amount.
      const verifier = scriptedVerifier({ recipient: "GATTACKER", amount: "100" });
      const svc = new EscrowService({
        prisma: db.prisma, horizon, signer: makeSigner(), assembler, verifier,
        networkPassphrase: PASSPHRASE, sleep: async () => {}
      });

      const outcome = await svc.settleVault({ vaultId: "vv2", settlementType: "release", recipient: "GWIN", amount: "100" });

      expect(outcome.state).toBe("PendingVerification");
      expect(outcome.txHash).toBe("tx_v2");
      expect(outcome.payoutVerified).toBe(false);

      const row = await db.prisma.vaultSettlement.findUnique({ where: { vaultId: "vv2" } });
      expect(row?.state).toBe("PendingVerification");
      expect(row?.errorCode).toBe("SETTLEMENT_PAYOUT_UNVERIFIED");
      // Not resubmitted — the successful submission's real hash is preserved.
      expect(horizon.submits).toHaveLength(1);
    });

    it("parks as PendingVerification when no finalized event has been indexed yet", async () => {
      const horizon = scriptedHorizon([{ hash: "tx_v3", successful: true, resultCode: "tx_success" }]);
      const verifier = scriptedVerifier(null);
      const svc = new EscrowService({
        prisma: db.prisma, horizon, signer: makeSigner(), assembler, verifier,
        networkPassphrase: PASSPHRASE, sleep: async () => {}
      });

      const outcome = await svc.settleVault({ vaultId: "vv3", settlementType: "release", recipient: "GWIN", amount: "100" });

      expect(outcome.state).toBe("PendingVerification");
      expect(outcome.txHash).toBe("tx_v3");
    });

    it("re-checks (does not resubmit) a vault already in PendingVerification, promoting to Resolved once the event catches up", async () => {
      const flakyVerifier = (() => {
        let calls = 0;
        const facts: VerifiedPayoutFacts = { recipient: "GWIN", amount: "100" };
        return {
          calls: [] as string[],
          async verify(txHash: string) {
            this.calls.push(txHash);
            calls += 1;
            // First call (during settleVault's submit path): not indexed yet.
            // Second call (a later settleVault retry): now indexed.
            return calls === 1 ? null : facts;
          }
        };
      })();
      const horizon = scriptedHorizon([{ hash: "tx_v4", successful: true, resultCode: "tx_success" }]);
      const svc = new EscrowService({
        prisma: db.prisma, horizon, signer: makeSigner(), assembler, verifier: flakyVerifier,
        networkPassphrase: PASSPHRASE, sleep: async () => {}
      });

      const first = await svc.settleVault({ vaultId: "vv4", settlementType: "release", recipient: "GWIN", amount: "100" });
      expect(first.state).toBe("PendingVerification");

      const second = await svc.settleVault({ vaultId: "vv4", settlementType: "release", recipient: "GWIN", amount: "100" });

      expect(second.state).toBe("Resolved");
      expect(second.txHash).toBe("tx_v4");
      expect(second.payoutVerified).toBe(true);
      // Still only ever submitted once — the retry re-verified, it did not resubmit.
      expect(horizon.submits).toHaveLength(1);
      expect(flakyVerifier.calls).toEqual(["tx_v4", "tx_v4"]);
    });

    it("a vault stuck in PendingVerification stays there (never resubmits) when verification still fails", async () => {
      const horizon = scriptedHorizon([{ hash: "tx_v5", successful: true, resultCode: "tx_success" }]);
      const verifier = scriptedVerifier(null); // never confirms
      const svc = new EscrowService({
        prisma: db.prisma, horizon, signer: makeSigner(), assembler, verifier,
        networkPassphrase: PASSPHRASE, sleep: async () => {}
      });

      await svc.settleVault({ vaultId: "vv5", settlementType: "release", recipient: "GWIN", amount: "100" });
      const second = await svc.settleVault({ vaultId: "vv5", settlementType: "release", recipient: "GWIN", amount: "100" });
      const third = await svc.settleVault({ vaultId: "vv5", settlementType: "release", recipient: "GWIN", amount: "100" });

      expect(second.state).toBe("PendingVerification");
      expect(third.state).toBe("PendingVerification");
      expect(horizon.submits).toHaveLength(1); // never resubmitted despite 3 calls
    });

    it("skips verification for distribute settlements (no single recipient/amount to check)", async () => {
      const horizon = scriptedHorizon([{ hash: "tx_v6", successful: true, resultCode: "tx_success" }]);
      const verifier = scriptedVerifier(null);
      const svc = new EscrowService({
        prisma: db.prisma, horizon, signer: makeSigner(), assembler, verifier,
        networkPassphrase: PASSPHRASE, sleep: async () => {}
      });

      const outcome = await svc.settleVault({ vaultId: "vv6", settlementType: "distribute", amount: "100" });

      expect(outcome.state).toBe("Resolved");
      expect(outcome.payoutVerified).toBeUndefined();
      expect(verifier.calls).toEqual([]);
    });

    it("preserves prior no-verifier behavior when no verifier is configured", async () => {
      const horizon = scriptedHorizon([{ hash: "tx_v7", successful: true, resultCode: "tx_success" }]);
      const svc = new EscrowService({
        prisma: db.prisma, horizon, signer: makeSigner(), assembler,
        networkPassphrase: PASSPHRASE, sleep: async () => {}
      });

      const outcome = await svc.settleVault({ vaultId: "vv7", settlementType: "release", recipient: "GWIN", amount: "100" });

      expect(outcome.state).toBe("Resolved");
      expect(outcome.payoutVerified).toBeUndefined();
    });
  });
});
