import { describe, expect, it } from "vitest";
import { assessSensitiveAction, completeStepUpChallenge, issueStepUpChallenge } from "../src/services/stepUpVerification.js";

describe("risk based step-up verification", () => {
  it("allows low-risk actions without friction", () => {
    expect(assessSensitiveAction({ action: "claim", accountAgeDays: 90 }).state).toBe("not_required");
  });

  it("requires verification for unusual high-risk activity", () => {
    const decision = assessSensitiveAction({ action: "withdraw", amount: 2_000, newDevice: true, recipientChanged: true });
    expect(decision.state).toBe("required");
    expect(decision.factors).toEqual(expect.arrayContaining(["large_amount", "new_device", "recipient_changed"]));
  });

  it("supports success, failure, and expiry paths", () => {
    const issued = issueStepUpChallenge({ action: "transfer", amount: 2_000 }, new Date("2026-01-01T00:00:00Z"));
    expect(completeStepUpChallenge(issued, true, new Date("2026-01-01T00:01:00Z")).state).toBe("verified");
    expect(completeStepUpChallenge(issued, false, new Date("2026-01-01T00:01:00Z")).state).toBe("failed");
    expect(completeStepUpChallenge(issued, true, new Date("2026-01-01T00:06:00Z")).state).toBe("expired");
  });
});
