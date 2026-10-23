import type { ActionRecord } from "../types.js";

export type ActionRiskLevel = "low" | "elevated" | "high" | "critical";

export type ActionRiskAssessment = {
  score: number;
  level: ActionRiskLevel;
  requiresReview: boolean;
  factors: Array<{
    code: string;
    points: number;
    explanation: string;
  }>;
};

type RiskSignals = Pick<ActionRecord, "actionType" | "status" | "retryCount" | "errorCode">;

const ACTION_RISK: Record<ActionRecord["actionType"], { points: number; explanation: string }> = {
  deposit: { points: 5, explanation: "Deposits can move assets into a vault." },
  withdraw: { points: 25, explanation: "Withdrawals move assets out of a vault." },
  create_vault: { points: 15, explanation: "Creating a vault changes protocol state." },
  claim: { points: 5, explanation: "Claims transfer an earned reward." },
  select_winner: { points: 25, explanation: "Winner selection determines a vault payout." },
  compensating: { points: 30, explanation: "Compensating actions reverse or repair a prior operation." },
};

const AUTHORIZATION_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "VAULT_UNAUTHORIZED_OPERATION",
  "VAULT_FORBIDDEN_OPERATION",
]);

export function assessActionRisk(action: RiskSignals): ActionRiskAssessment {
  const factors: ActionRiskAssessment["factors"] = [];
  const actionRisk = ACTION_RISK[action.actionType];

  if (actionRisk.points > 0) {
    factors.push({
      code: `action_type:${action.actionType}`,
      points: actionRisk.points,
      explanation: actionRisk.explanation,
    });
  }

  const retries = Number.isSafeInteger(action.retryCount) ? Math.max(0, action.retryCount) : 0;
  const retryPoints = Math.min(retries * 10, 20);
  if (retryPoints > 0) {
    factors.push({
      code: "retries",
      points: retryPoints,
      explanation: `This action has been retried ${retries} time${retries === 1 ? "" : "s"}.`,
    });
  }

  if (action.status === "failed" || action.status === "reverted") {
    factors.push({
      code: `terminal_status:${action.status}`,
      points: 15,
      explanation: `The action ended in the ${action.status} state.`,
    });
  }

  if (action.errorCode && AUTHORIZATION_ERROR_CODES.has(action.errorCode.toUpperCase())) {
    factors.push({
      code: "authorization_denied",
      points: 35,
      explanation: "The action was rejected by an authorization check.",
    });
  }

  const score = Math.min(100, factors.reduce((total, factor) => total + factor.points, 0));
  const level: ActionRiskLevel =
    score >= 75 ? "critical" : score >= 50 ? "high" : score >= 25 ? "elevated" : "low";

  return {
    score,
    level,
    requiresReview: score >= 50,
    factors,
  };
}
