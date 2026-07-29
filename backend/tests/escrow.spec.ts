import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import {
  EscrowService,
  type HorizonGateway,
  type AdminSigner,
  type TransactionAssembler,
  type SubmitResult
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
});
