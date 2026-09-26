/**
 * Behavioral conformance tests for frontend service mocks (#651).
 *
 * Mirrors the drip-pool contract's *behavioral* edge cases (deposits, lockup
 * windows, claim no-ops, yield caps, draw prizes, funded quests, lockup
 * weight tiers) and asserts that the wallet mock client and the savings/quest
 * service mocks reproduce them exactly. Every fixture shares the canonical
 * evaluator in `lib/conformance-spec.ts`, so any drift between the contract's
 * documented behavior and a frontend mock fails CI here.
 *
 * Run (from repo root): pnpm test:conformance
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  BEHAVIORAL_FIXTURES,
  runCanonicalCase,
  type ConformanceCase,
  type ConformanceEvaluation,
} from "../../lib/conformance-spec";
import {
  createMockVaultClient,
  SAMPLE_ADDRESS,
} from "@vaultquest/stellar-wallet-connect/src/vault/contract/mockClient";
import { SavingsService } from "../../services/savingsService";
import {
  createChallenge,
  joinChallenge,
  updateProgress,
  __resetQuestDb,
} from "../../services/questService";

function savingsParticipation() {
  return {
    questId: "q_1",
    userAddress: "GUSER",
    currentBalance: 0,
    streakDays: 0,
    lastDepositAt: null,
    yieldAccrued: 0,
    prize: 0,
    claimedReward: 0,
    lockedUntilLedger: 0,
    milestoneProgress: [],
    isEligibleForReward: false,
  };
}

describe("Behavioral fixtures are self-consistent", () => {
  it("every fixture resolves through the canonical evaluator", () => {
    for (const cs of BEHAVIORAL_FIXTURES) {
      const result = runCanonicalCase(cs);
      if (cs.expected.status === "error") {
        expect(result.status).toBe("error");
        expect(result.error).toBe(cs.expected.error);
      } else if (cs.expected.status === "noop") {
        expect(result.status).toBe("noop");
        expect(result.value).toBe(0);
      } else {
        expect(result.status).toBe("ok");
        if (cs.expected.value !== undefined) {
          expect(result.value).toBe(cs.expected.value);
        }
      }
    }
  });

  it("every fixture has a contract reference", () => {
    for (const cs of BEHAVIORAL_FIXTURES) {
      expect(cs.reference, `fixture ${cs.id} is missing a contract reference`).toMatch(/contract|vault\.rs|services\//);
    }
  });
});

describe("Mock vault client conforms to contract fixtures", () => {
  async function expectMockMatchesFixture(cs: ConformanceCase) {
    const client = createMockVaultClient({ connected: true });
    const action = cs.domain === "withdraw" ? "withdraw" : "drip";
    const input = {
      poolId: "pool-1",
      walletAddress: SAMPLE_ADDRESS,
      amount: cs.inputs.amount != null ? String(cs.inputs.amount) : undefined,
    };

    if (cs.expected.status === "error") {
      await expect(client.submitAction(action, input)).rejects.toMatchObject({
        kind: "contract_error",
        message: cs.expected.error,
      });
    } else {
      const result = await client.submitAction(action, input);
      expect(result.status).toBe("submitted");
    }
  }

  it("rejects non-positive deposits exactly like the contract", async () => {
    await expectMockMatchesFixture(BEHAVIORAL_FIXTURES.find((f) => f.id === "deposit-zero-rejected")!);
  });

  it("rejects negative deposits", async () => {
    await expectMockMatchesFixture(BEHAVIORAL_FIXTURES.find((f) => f.id === "deposit-negative-rejected")!);
  });

  it("accepts positive deposits", async () => {
    await expectMockMatchesFixture(BEHAVIORAL_FIXTURES.find((f) => f.id === "deposit-positive-accepted")!);
  });

  it("rejects a withdrawal inside its lockup window", async () => {
    const client = createMockVaultClient({
      connected: true,
      lockupWindows: { "pool-1": 1000 },
      currentLedger: 999,
    });
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "withdraw-before-lockup-rejected")!;
    await expect(
      client.submitAction("withdraw", { poolId: "pool-1", walletAddress: SAMPLE_ADDRESS, amount: "500" }),
    ).rejects.toMatchObject({ kind: "contract_error", message: "LockupActive" });
    expect(cs.expected.status).toBe("error");
  });

  it("allows a withdrawal once the lockup window has passed", async () => {
    const client = createMockVaultClient({
      connected: true,
      lockupWindows: { "pool-1": 1000 },
      currentLedger: 1000,
    });
    const result = await client.submitAction("withdraw", {
      poolId: "pool-1",
      walletAddress: SAMPLE_ADDRESS,
      amount: "500",
    });
    expect(result.status).toBe("submitted");
  });

  it("treats an empty claim as a successful no-op (Ok(0))", async () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "claim-nothing-available-is-noop")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "noop", value: 0 });
    const client = createMockVaultClient({ connected: true });
    const result = await client.submitAction("claim", { poolId: "pool-1", walletAddress: SAMPLE_ADDRESS });
    expect(result.status).toBe("submitted");
  });
});

describe("Savings service conforms to contract fixtures", () => {
  it("rejects a zero deposit with InvalidAmount", () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "deposit-zero-rejected")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "error", error: "InvalidAmount" });
    expect(() => SavingsService.validateDeposit(0)).toThrow("InvalidAmount");
  });

  it("rejects a negative deposit with InvalidAmount", () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "deposit-negative-rejected")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "error", error: "InvalidAmount" });
    expect(() => SavingsService.validateDeposit(-10)).toThrow("InvalidAmount");
  });

  it("accepts a positive deposit", () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "deposit-positive-accepted")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "ok" });
    expect(() => SavingsService.validateDeposit(100)).not.toThrow();
  });

  it("rejects a locked withdrawal", () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "withdraw-before-lockup-rejected")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "error", error: "LockupActive" });
    const p = savingsParticipation();
    p.lockedUntilLedger = 1000;
    expect(() => SavingsService.validateWithdrawal(p, 999)).toThrow("LockupActive");
  });

  it("allows withdrawal once unlocked", () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "withdraw-after-lockup-succeeds")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "ok", value: 500 });
    const p = savingsParticipation();
    p.lockedUntilLedger = 1000;
    expect(() => SavingsService.validateWithdrawal(p, 1000)).not.toThrow();
  });

  it("treats an empty claim as a no-op (Ok(0)), not an error", async () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "claim-nothing-available-is-noop")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "noop", value: 0 });
    const p = savingsParticipation();
    expect(await SavingsService.claimReward(p, 5)).toBe(0);
    expect(p.claimedReward).toBe(0);
  });

  it("returns a no-op when rewards are already fully claimed", async () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "claim-fully-claimed-is-noop")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "noop", value: 0 });
    const p = savingsParticipation();
    p.yieldAccrued = 100;
    p.claimedReward = 100;
    expect(await SavingsService.claimReward(p, 5)).toBe(0);
  });

  it("pays the claimable delta on a positive balance", async () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "claim-available-succeeds")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "ok", value: 75 });
    const p = savingsParticipation();
    p.yieldAccrued = 100;
    p.prize = 25;
    p.claimedReward = 50;
    expect(await SavingsService.claimReward(p, 5)).toBe(75);
  });

  it("rejects a claim after the deadline has passed", async () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "claim-after-deadline-rejected")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "error", error: "ClaimDeadlinePassed" });
    const p = savingsParticipation();
    p.yieldAccrued = 100;
    p.claimDeadline = 1000;
    await expect(SavingsService.claimReward(p, 1001)).rejects.toThrow("ClaimDeadlinePassed");
  });

  it("computes lockup weight tiers from the vault contract", () => {
    const lockupIds = ["lockup-flexible-weight", "lockup-short-weight", "lockup-medium-weight", "lockup-long-weight"];
    for (const id of lockupIds) {
      const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === id)!;
      expect(SavingsService.lockupWeightBps(cs.inputs.lockupDays!)).toBe(cs.expected.value);
    }
  });
});

describe("Quest service conforms to contract fixtures", () => {
  beforeEach(() => {
    __resetQuestDb();
  });

  it("rejects an unfunded (zero-reward) quest", async () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "quest-zero-reward-rejected")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "error", error: "InvalidAmount" });
    await expect(createChallenge("test", "desc", "G", 0, "USDC", [10])).rejects.toThrow("InvalidAmount");
  });

  it("creates a funded quest", async () => {
    const cs = BEHAVIORAL_FIXTURES.find((f) => f.id === "quest-positive-reward-succeeds")!;
    expect(runCanonicalCase(cs)).toMatchObject({ status: "ok" });
    const quest = await createChallenge("test", "desc", "G", 500, "USDC", [10, 20]);
    expect(quest.rewardAmount).toBe(500);
  });

  it("enrolls a user and keeps progress monotonic", async () => {
    const quest = await createChallenge("test", "desc", "G", 500, "USDC", [10, 20], "escrow_1");
    const participation = await joinChallenge(quest.id, "GUSER");
    expect(participation.currentBalance).toBe(0);
    await updateProgress(quest.id, "GUSER", 15);
    await expect(updateProgress(quest.id, "GUSER", 5)).rejects.toThrow("InvalidAmount");
  });
});