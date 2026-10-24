import { randomUUID } from "node:crypto";

/** Risk-aware step-up verification for sensitive wallet actions. */
export type StepUpState = "not_required" | "required" | "verified" | "expired" | "failed";

export interface SensitiveActionSignals {
  action: "deposit" | "withdraw" | "claim" | "transfer" | "settings";
  amount?: number;
  accountAgeDays?: number;
  newDevice?: boolean;
  recipientChanged?: boolean;
  recentFailures?: number;
  velocityPerHour?: number;
}

export interface StepUpDecision {
  score: number;
  state: StepUpState;
  explanation: string;
  factors: string[];
}

export interface VerificationChallenge {
  id: string;
  state: StepUpState;
  issuedAt: string;
  expiresAt: string;
  action: SensitiveActionSignals["action"];
}

const HIGH_RISK_SCORE = 50;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function assessSensitiveAction(signals: SensitiveActionSignals): StepUpDecision {
  let score = signals.action === "withdraw" || signals.action === "transfer" ? 25 : 5;
  const factors: string[] = [];
  if (signals.action === "withdraw" || signals.action === "transfer") factors.push("funds_leave_vault");
  if ((signals.amount ?? 0) >= 1_000) { score += 25; factors.push("large_amount"); }
  if (signals.newDevice) { score += 20; factors.push("new_device"); }
  if (signals.recipientChanged) { score += 25; factors.push("recipient_changed"); }
  if ((signals.recentFailures ?? 0) > 0) { score += Math.min(20, signals.recentFailures! * 10); factors.push("recent_auth_failures"); }
  if ((signals.velocityPerHour ?? 0) >= 5) { score += 15; factors.push("high_velocity"); }
  if ((signals.accountAgeDays ?? 365) < 7) { score += 10; factors.push("new_account"); }
  score = Math.min(100, score);
  const required = score >= HIGH_RISK_SCORE;
  return {
    score,
    state: required ? "required" : "not_required",
    explanation: required
      ? "This action needs one extra verification because recent activity looks unusual."
      : "This action can continue without extra verification.",
    factors
  };
}

export function issueStepUpChallenge(
  signals: SensitiveActionSignals,
  now = new Date(),
  ttlMs = CHALLENGE_TTL_MS
): VerificationChallenge {
  const decision = assessSensitiveAction(signals);
  const issuedAt = now.toISOString();
  return {
    id: randomUUID(),
    state: decision.state,
    issuedAt,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    action: signals.action
  };
}

export function completeStepUpChallenge(
  challenge: VerificationChallenge,
  accepted: boolean,
  now = new Date()
): VerificationChallenge {
  if (new Date(challenge.expiresAt).getTime() <= now.getTime()) return { ...challenge, state: "expired" };
  if (challenge.state !== "required") return challenge;
  return { ...challenge, state: accepted ? "verified" : "failed" };
}

