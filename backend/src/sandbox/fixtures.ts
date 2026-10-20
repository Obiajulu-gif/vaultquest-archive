import type { VerifiedPayoutFacts } from "../services/escrowService.js";
import type { SandboxScenario } from "./config.js";

export interface SandboxScenarioFixture {
  description: string;
  expectedState: "Resolved" | "Unresolved" | "PendingVerification";
  payoutFacts: VerifiedPayoutFacts | null;
  mismatchPayoutFacts?: VerifiedPayoutFacts;
}

export const SANDBOX_RECIPIENT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
export const SANDBOX_AMOUNT = "25.00";

export const SANDBOX_FIXTURES: Record<SandboxScenario, SandboxScenarioFixture> = {
  success: {
    description: "single successful submission and matching finalized payout",
    expectedState: "Resolved",
    payoutFacts: { recipient: SANDBOX_RECIPIENT, amount: SANDBOX_AMOUNT, asset: "USDC" }
  },
  retry_once: {
    description: "one tx_bad_seq response followed by a successful submission",
    expectedState: "Resolved",
    payoutFacts: { recipient: SANDBOX_RECIPIENT, amount: SANDBOX_AMOUNT, asset: "USDC" }
  },
  timeout_once: {
    description: "one deterministic timeout followed by a successful submission",
    expectedState: "Resolved",
    payoutFacts: { recipient: SANDBOX_RECIPIENT, amount: SANDBOX_AMOUNT, asset: "USDC" }
  },
  submit_failure: {
    description: "permanent tx_bad_auth rejection without a retry",
    expectedState: "Unresolved",
    payoutFacts: null
  },
  verification_pending: {
    description: "submission accepted while finalized payout evidence is unavailable",
    expectedState: "PendingVerification",
    payoutFacts: null
  },
  verification_mismatch: {
    description: "submission accepted but finalized payout facts do not match the intent",
    expectedState: "PendingVerification",
    payoutFacts: null,
    mismatchPayoutFacts: { recipient: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCD", amount: "99.00", asset: "USDC" }
  }
};