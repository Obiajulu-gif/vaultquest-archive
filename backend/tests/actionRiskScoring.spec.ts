import { describe, expect, it } from "vitest";
import { assessActionRisk } from "../src/services/actionRiskScoring.js";

describe("explainable action risk scoring", () => {
  it("scores a normal claim as low risk without requiring review", () => {
    expect(
      assessActionRisk({
        actionType: "claim",
        status: "confirmed",
        retryCount: 0,
        errorCode: null,
      }),
    ).toEqual({
      score: 5,
      level: "low",
      requiresReview: false,
      factors: [
        {
          code: "action_type:claim",
          points: 5,
          explanation: "Claims transfer an earned reward.",
        },
      ],
    });
  });

  it("adds a failure factor while preserving the action-type explanation", () => {
    const assessment = assessActionRisk({
      actionType: "withdraw",
      status: "failed",
      retryCount: 0,
      errorCode: "NETWORK_ERROR",
    });

    expect(assessment.score).toBe(40);
    expect(assessment.level).toBe("elevated");
    expect(assessment.requiresReview).toBe(false);
    expect(assessment.factors.map(({ code }) => code)).toEqual([
      "action_type:withdraw",
      "terminal_status:failed",
    ]);
  });

  it("increases risk on retries and caps repeated retry points", () => {
    const assessment = assessActionRisk({
      actionType: "compensating",
      status: "pending",
      retryCount: 4,
      errorCode: null,
    });

    expect(assessment.score).toBe(50);
    expect(assessment.level).toBe("high");
    expect(assessment.requiresReview).toBe(true);
    expect(assessment.factors[1]).toMatchObject({
      code: "retries",
      points: 20,
      explanation: "This action has been retried 4 times.",
    });
  });

  it("scores a denied authorization separately and recommends review when warranted", () => {
    const assessment = assessActionRisk({
      actionType: "withdraw",
      status: "failed",
      retryCount: 0,
      errorCode: "VAULT_UNAUTHORIZED_OPERATION",
    });

    expect(assessment.score).toBe(75);
    expect(assessment.level).toBe("critical");
    expect(assessment.requiresReview).toBe(true);
    expect(assessment.factors.at(-1)).toEqual({
      code: "authorization_denied",
      points: 35,
      explanation: "The action was rejected by an authorization check.",
    });
  });

  it("does not add an authorization factor for unrelated errors", () => {
    const assessment = assessActionRisk({
      actionType: "claim",
      status: "failed",
      retryCount: -1,
      errorCode: "WALLET_REJECTED",
    });

    expect(assessment.score).toBe(20);
    expect(assessment.factors.map(({ code }) => code)).toEqual([
      "action_type:claim",
      "terminal_status:failed",
    ]);
  });
});
