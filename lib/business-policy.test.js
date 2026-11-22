import { describe, expect, it } from "vitest";
import { BusinessPolicyEngine } from "./business-policy";
import { createSavingsService } from "../services/savingsService";

describe("BusinessPolicyEngine", () => {
  it("preserves current default deposit and lockup boundaries", () => {
    const policy = new BusinessPolicyEngine();
    expect(policy.evaluate({ rule: "deposit", amount: 0 }).code).toBe("InvalidAmount");
    expect(policy.evaluate({ rule: "deposit", amount: Number.NaN }).status).toBe("deny");
    expect(policy.evaluate({ rule: "deposit", amount: Number.MIN_VALUE }).status).toBe("allow");
    expect(policy.evaluate({ rule: "withdrawal", lockedUntilLedger: 10, currentLedger: 9 }).code)
      .toBe("LockupActive");
    expect(policy.evaluate({ rule: "withdrawal", lockedUntilLedger: 10, currentLedger: 10 }).status)
      .toBe("allow");
  });

  it("applies configurable deposit limits at the exact boundary", () => {
    const policy = new BusinessPolicyEngine({ maximumDeposit: 250 });
    expect(policy.evaluate({ rule: "deposit", amount: 250 }).status).toBe("allow");
    const decision = policy.evaluate({ rule: "deposit", amount: 250.01 });
    expect(decision).toMatchObject({ status: "deny", code: "DepositLimitExceeded" });
    expect(decision.message).toContain("Lower the amount");
  });

  it("applies prize and participant eligibility thresholds inclusively", () => {
    const policy = new BusinessPolicyEngine({ minimumPrize: 10, minimumEligibleParticipants: 3 });
    expect(policy.evaluate({ rule: "draw", prize: 10, eligibleParticipants: 3 }).status).toBe("deny");
    expect(policy.evaluate({ rule: "draw", prize: 10.01, eligibleParticipants: 2 }).code)
      .toBe("NoEligibleParticipants");
    expect(policy.evaluate({ rule: "draw", prize: 10.01, eligibleParticipants: 3 }).status).toBe("allow");
  });

  it("preserves claim no-op and exact-deadline behavior", () => {
    const policy = new BusinessPolicyEngine();
    expect(policy.evaluate({ rule: "claim", availableAmount: 0, deadline: 100, now: 100 }).status)
      .toBe("noop");
    expect(policy.evaluate({ rule: "claim", availableAmount: 1, deadline: 100, now: 101 }).code)
      .toBe("ClaimDeadlinePassed");
  });

  it("rejects inconsistent override configuration", () => {
    expect(() => new BusinessPolicyEngine({ minimumDeposit: 100, maximumDeposit: 100 }))
      .toThrow(/InvalidPolicyConfiguration/);
    expect(() => new BusinessPolicyEngine({ lockupWeightTiers: [{ maxDays: 7, multiplierBps: 100 }] }))
      .toThrow(/InvalidPolicyConfiguration/);
  });
});

describe("SavingsService with configured policy", () => {
  it("returns actionable policy errors before mutating savings state", async () => {
    const savings = createSavingsService({ maximumDeposit: 50 });
    const participation = {
      questId: "q",
      userAddress: "GUSER",
      currentBalance: 20,
      streakDays: 1,
      lastDepositAt: null,
      yieldAccrued: 0,
      prize: 0,
      claimedReward: 0,
      lockedUntilLedger: 0,
      milestoneProgress: [],
      isEligibleForReward: true
    };
    const error = await savings.trackDeposit({ milestones: [] }, participation, 51).catch((value) => value);

    expect(error).toMatchObject({ code: "DepositLimitExceeded" });
    expect(error.userMessage).toContain("Lower the amount");
    expect(participation.currentBalance).toBe(20);
  });
});