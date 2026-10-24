import { describe, it, expect } from "vitest";
import {
  CriticalReadPolicy,
  CriticalReadPolicyError,
  ProviderStabilityTracker,
  type CriticalReadSample
} from "./criticalReadPolicy.js";

const NOW = 1_000_000;

function sample(
  provider: string,
  value: string,
  overrides: Partial<CriticalReadSample<string>> = {}
): CriticalReadSample<string> {
  return {
    provider,
    value,
    ledgerSequence: 1000,
    ledgerCloseTime: NOW - 1000,
    networkPassphrase: "Test SDF Network ; September 2015",
    latencyMs: 100,
    ...overrides
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
    ...overrides
  });
}

const equalStrings = (a: string, b: string) => a === b;

describe("CriticalReadPolicy", () => {
  it("accepts a quorum of fresh, agreeing, ledger-consistent providers", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [sample("horizon-a", "100"), sample("horizon-b", "100"), sample("soroban-a", "100")],
      equalStrings
    );

    expect(decision.ok).toBe(true);
    expect(decision.value).toBe("100");
    expect(decision.agreeingProviders).toEqual(["horizon-a", "horizon-b", "soroban-a"]);
    expect(decision.quarantined).toHaveLength(0);
  });

  it("quarantines and rejects a stale provider", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [
        sample("horizon-a", "100"),
        sample("horizon-b", "100", { ledgerCloseTime: NOW - 60_000 }) // way stale
      ],
      equalStrings
    );

    expect(decision.quarantined).toContainEqual(
      expect.objectContaining({ provider: "horizon-b", reason: "stale" })
    );
    // Only one surviving provider — quorum of 2 not met.
    expect(decision.ok).toBe(false);
    expect(() => policy.assertAuthorizable(decision)).toThrow(CriticalReadPolicyError);
  });

  it("rejects and quarantines conflicting responses that diverge from the majority", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [sample("horizon-a", "100"), sample("horizon-b", "100"), sample("horizon-c", "999")],
      equalStrings
    );

    expect(decision.ok).toBe(true); // majority of 2 still meets quorum
    expect(decision.value).toBe("100");
    expect(decision.quarantined).toContainEqual(
      expect.objectContaining({ provider: "horizon-c", reason: "diverges_from_majority" })
    );
  });

  it("rejects when all agreeing providers disagree in a tie with no quorum", () => {
    const policy = makePolicy({ minQuorum: 2 });
    const decision = policy.evaluate([sample("a", "100"), sample("b", "200")], equalStrings);

    expect(decision.ok).toBe(false);
    expect(decision.degraded).toBe(true);
    expect(() => policy.assertAuthorizable(decision)).toThrow(/quorum_not_met|conflicting/);
  });

  it("quarantines a slow provider and excludes it from quorum", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [
        sample("horizon-a", "100"),
        sample("horizon-b", "100"),
        sample("horizon-c", "100", { latencyMs: 9000 })
      ],
      equalStrings
    );

    expect(decision.ok).toBe(true);
    expect(decision.quarantined).toContainEqual(
      expect.objectContaining({ provider: "horizon-c", reason: "slow" })
    );
  });

  it("rejects when agreeing providers reference ledgers too far apart", () => {
    const policy = makePolicy({ maxLedgerDivergence: 1 });
    const decision = policy.evaluate(
      [
        sample("horizon-a", "100", { ledgerSequence: 1000 }),
        sample("horizon-b", "100", { ledgerSequence: 1005 })
      ],
      equalStrings
    );

    expect(decision.ok).toBe(false);
    expect(decision.reasons.some((r) => r.includes("exceeding max divergence"))).toBe(true);
  });

  it("quarantines a provider reporting the wrong network passphrase", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [
        sample("horizon-a", "100"),
        sample("horizon-b", "100"),
        sample("mainnet-leak", "100", { networkPassphrase: "Public Global Stellar Network ; September 2015" })
      ],
      equalStrings
    );

    expect(decision.quarantined).toContainEqual(
      expect.objectContaining({ provider: "mainnet-leak", reason: "wrong_network" })
    );
  });

  it("treats read errors as quarantined samples, not thrown exceptions", () => {
    const policy = makePolicy();
    const decision = policy.evaluate(
      [
        sample("horizon-a", "100"),
        sample("horizon-b", "100"),
        { ...sample("horizon-c", ""), error: new Error("connection reset") }
      ],
      equalStrings
    );

    expect(decision.ok).toBe(true);
    expect(decision.quarantined).toContainEqual(
      expect.objectContaining({ provider: "horizon-c", reason: "error" })
    );
  });

  it("quarantines a flapping provider that repeatedly alternates agree/disagree", () => {
    const policy = makePolicy();
    const stability = new ProviderStabilityTracker(2);

    // Alternate horizon-c's agreement across several evaluations.
    policy.evaluate([sample("horizon-a", "100"), sample("horizon-b", "100"), sample("horizon-c", "999")], equalStrings, stability);
    policy.evaluate([sample("horizon-a", "100"), sample("horizon-b", "100"), sample("horizon-c", "100")], equalStrings, stability);
    policy.evaluate([sample("horizon-a", "100"), sample("horizon-b", "100"), sample("horizon-c", "999")], equalStrings, stability);
    const decision = policy.evaluate(
      [sample("horizon-a", "100"), sample("horizon-b", "100"), sample("horizon-c", "100")],
      equalStrings,
      stability
    );

    expect(decision.quarantined).toContainEqual(
      expect.objectContaining({ provider: "horizon-c", reason: "flapping" })
    );
  });

  it("assertAuthorizable returns the value directly when policy is satisfied", () => {
    const policy = makePolicy();
    const decision = policy.evaluate([sample("a", "100"), sample("b", "100")], equalStrings);
    expect(policy.assertAuthorizable(decision)).toBe("100");
  });
});
