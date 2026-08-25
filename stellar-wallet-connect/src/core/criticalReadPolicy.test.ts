import { describe, it, expect } from "vitest";
import {
  CriticalReadPolicy,
  CriticalReadPolicyError,
  ProviderStabilityTracker,
  type CriticalReadSample,
} from "./criticalReadPolicy.js";

const NOW = 1_000_000;

function sample(
  provider: string,
  value: string,
  overrides: Partial<CriticalReadSample<string>> = {},
): CriticalReadSample<string> {
  return {
    provider,
    value,
    ledgerSequence: 1000,
    ledgerCloseTime: NOW - 1000,
    networkPassphrase: "Test SDF Network ; September 2015",
    latencyMs: 100,
    ...overrides,
  };
}

function makePolicy(overrides: Partial<ConstructorParameters<typeof CriticalReadPolicy>[0]> = {}) {
  return new CriticalReadPolicy({
    minQuorum: 2,
    maxFreshnessMs: 5000,
    maxLedgerDivergence: 2,
    maxLatencyMs: 3000,
    expectedNetworkPassphrase: "Test SDF Network ; September 2015",
    now: () => NOW,
    ...overrides,
  });
}

const equalStrings = (a: string, b: string) => a === b;

describe("CriticalReadPolicy (wallet-connect)", () => {
  it("accepts a quorum of fresh, agreeing, ledger-consistent providers", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [sample("horizon-a", "100"), sample("horizon-b", "100"), sample("soroban-a", "100")],
      equalStrings,
    );

    expect(decision.ok).toBe(true);
    expect(decision.value).toBe("100");
  });

  it("rejects a stale provider and does not authorize a withdrawal read", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [sample("horizon-a", "100"), sample("horizon-b", "100", { ledgerCloseTime: NOW - 60_000 })],
      equalStrings,
    );

    expect(decision.ok).toBe(false);
    expect(() => policy.assertAuthorizable(decision)).toThrow(CriticalReadPolicyError);
  });

  it("quarantines a conflicting minority response but keeps the majority authorizable", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [sample("horizon-a", "100"), sample("horizon-b", "100"), sample("horizon-c", "999")],
      equalStrings,
    );

    expect(decision.ok).toBe(true);
    expect(decision.quarantined).toContainEqual(
      expect.objectContaining({ provider: "horizon-c", reason: "diverges_from_majority" }),
    );
  });

  it("quarantines a slow provider", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [sample("horizon-a", "100"), sample("horizon-b", "100"), sample("horizon-c", "100", { latencyMs: 9000 })],
      equalStrings,
    );

    expect(decision.quarantined).toContainEqual(expect.objectContaining({ provider: "horizon-c", reason: "slow" }));
  });

  it("detects a flapping provider across repeated evaluations", () => {
    const policy = makePolicy();
    const stability = new ProviderStabilityTracker(2);

    policy.evaluate([sample("a", "100"), sample("b", "100"), sample("c", "999")], equalStrings, stability);
    policy.evaluate([sample("a", "100"), sample("b", "100"), sample("c", "100")], equalStrings, stability);
    const decision = policy.evaluate(
      [sample("a", "100"), sample("b", "100"), sample("c", "999")],
      equalStrings,
      stability,
    );

    expect(decision.quarantined).toContainEqual(expect.objectContaining({ provider: "c", reason: "flapping" }));
  });
});
