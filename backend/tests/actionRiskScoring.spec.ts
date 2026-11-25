import { describe, expect, it } from "vitest";
import { assessActionRisk, assessManualFailureRisk } from "../src/services/actionRiskScoring.js";

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

describe("manual failure risk (recovery resolve)", () => {
  const tx = "ab".repeat(32);

  it("requires review to fail a withdrawal whose transaction may still confirm, and explains why", () => {
    expect(assessManualFailureRisk({ actionType: "withdraw", txHash: tx })).toEqual({
      score: 55,
      level: "high",
      requiresReview: true,
      factors: [
        { code: "action_type:withdraw", points: 25, explanation: "Withdrawals move assets out of a vault." },
        {
          code: "submitted_on_chain",
          points: 30,
          explanation: "A transaction hash was recorded, so the transaction may still confirm on-chain after the ledger marks it failed.",
        },
      ],
    });
  });

  it.each([
    ["deposit", tx, 35, false],
    ["withdraw", null, 25, false],
    ["select_winner", tx, 55, true],
    ["compensating", tx, 60, true],
  ])("scores %s (tx hash: %s) as %i, review %s", (actionType, txHash, score, requiresReview) => {
    expect(assessManualFailureRisk({ actionType, txHash })).toMatchObject({ score, requiresReview });
  });

  it("treats an unrecognised action type as high impact instead of throwing", () => {
    const assessment = assessManualFailureRisk({ actionType: "bridge_out", txHash: tx });
    expect(assessment).toMatchObject({ score: 55, requiresReview: true });
    expect(assessment.factors[0]!.code).toBe("action_type:unknown");
  });
});
