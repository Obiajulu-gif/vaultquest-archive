import { describe, it, expect } from "vitest";
import {
  PROTOCOL_PARAMETER_CATALOG,
  createParameterDiffPreview,
  formatSimulatedValue,
  getParameterSpec,
  parseDiffPreview,
  serializeDiffPreview,
  simulateParameterChange,
  validateProposedParameter,
} from "../lib/admin-parameter-simulation";

describe("parameter catalog", () => {
  it("matches the six governance-controlled parameters on the settings page", () => {
    expect(PROTOCOL_PARAMETER_CATALOG.map((spec) => spec.id).sort()).toEqual([
      "emergencyPauseThresholdAttempts",
      "maxDepositPerVaultUnits",
      "minDepositUnits",
      "roundCadenceDays",
      "settlementQuorumOfFive",
      "treasuryFeeBps",
    ]);
  });

  it("exposes the treasury fee fallback stringency", () => {
    const fee = getParameterSpec("treasuryFeeBps");
    expect(fee?.min).toBe(0.5);
    expect(fee?.boundaryNote).toContain("0.5 bp");
  });
});

describe("parameter validation", () => {
  it("accepts a valid value", () => {
    const { valid, issues } = validateProposedParameter("roundCadenceDays", 7);
    expect(valid).toBe(true);
    expect(issues).toHaveLength(0);
  });

  it("rejects non-integer values for integer parameters", () => {
    const { valid, issues } = validateProposedParameter("settlementQuorumOfFive", 2.5);
    expect(valid).toBe(false);
    expect(issues[0].field).toBe("type");
  });

  it("rejects the fee below the 0.5 bp stringency", () => {
    const { valid, issues } = validateProposedParameter("treasuryFeeBps", 0.2);
    expect(valid).toBe(false);
    expect(issues[0].field).toBe("range");
    expect(issues[0].message).toContain("0.5");
  });

  it("rejects unknown parameters", () => {
    const { valid } = validateProposedParameter("doesNotExist", 1);
    expect(valid).toBe(false);
  });

  it("rejects a max deposit below the proposed minimum (cross-parameter)", () => {
    const { valid, issues } = validateProposedParameter("maxDepositPerVaultUnits", 50, {
      otherProposals: [{ paramId: "minDepositUnits", proposedValue: 100 }],
    });
    expect(valid).toBe(false);
    expect(issues.some((issue) => issue.field === "cross-parameter")).toBe(true);
  });
});

describe("simulation results", () => {
  it("produces an ordered before→after diff", () => {
    const result = simulateParameterChange({ paramId: "treasuryFeeBps", proposedValue: 100 });
    expect(result.fromValue).toBe(75);
    expect(result.toValue).toBe(100);
    expect(result.delta).toBe(25);
    expect(result.validated).toBe(true);
    expect(result.affectedServices).toContain("smart contract");
  });

  it("flags blocked and overridden stringency violations", () => {
    const blocked = simulateParameterChange({ paramId: "treasuryFeeBps", proposedValue: 0.1 });
    expect(blocked.blocked).toBe(true);
    expect(blocked.blockedReason).toContain("0.5 bp");

    const overridden = simulateParameterChange(
      { paramId: "treasuryFeeBps", proposedValue: 0.1 },
      { overrideBlocked: true },
    );
    expect(overridden.blocked).toBe(false);
    expect(overridden.overridden).toBe(true);
  });

  it("requires confirmation for medium/high risk changes", () => {
    const small = simulateParameterChange({ paramId: "settlementQuorumOfFive", proposedValue: 3 });
    expect(small.needsConfirmation).toBe(false);

    const jump = simulateParameterChange({ paramId: "settlementQuorumOfFive", proposedValue: 4 });
    expect(jump.needsConfirmation).toBe(true);
    expect(jump.riskLevel).toBe("medium");
  });
});

describe("diff preview", () => {
  const BASE = { createdAt: "2026-06-30T00:00:00.000Z", author: "maintainer" };

  it("summarizes total, valid, blocked, and risk counts", () => {
    const preview = createParameterDiffPreview(
      [
        { paramId: "roundCadenceDays", proposedValue: 14 },
        { paramId: "treasuryFeeBps", proposedValue: 0.1 },
      ],
      BASE,
    );
    expect(preview.summary.total).toBe(2);
    expect(preview.summary.valid).toBe(1);
    expect(preview.summary.blocked).toBe(1);
    expect(preview.summary.highRisk).toBe(2);
    expect(preview.schema).toBe("vaultquest.admin.param-simulation.v1");
  });

  it("surfaces conflicting proposals", () => {
    const preview = createParameterDiffPreview(
      [
        { paramId: "maxDepositPerVaultUnits", proposedValue: 50 },
        { paramId: "minDepositUnits", proposedValue: 100 },
      ],
      BASE,
    );
    expect(preview.conflicts.length).toBeGreaterThan(0);
  });

  it("serializes and parses the download payload round-trip", () => {
    const preview = createParameterDiffPreview(
      [{ paramId: "settlementQuorumOfFive", proposedValue: 4, rationale: "flip 3-of-5 to 4-of-5" }],
      BASE,
    );
    const raw = serializeDiffPreview(preview);
    const reparsed = parseDiffPreview(raw);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.id).toBe(preview.id);
    expect(reparsed!.proposals[0].rationale).toBe("flip 3-of-5 to 4-of-5");
  });

  it("rejects malformed payloads", () => {
    expect(parseDiffPreview("{ not json")).toBeNull();
    expect(parseDiffPreview(JSON.stringify({ schema: "other" }))).toBeNull();
  });

  it("is deterministic with a pinned createdAt", () => {
    const proposals = [{ paramId: "minDepositUnits", proposedValue: 50 }];
    const first = createParameterDiffPreview(proposals, BASE);
    const second = createParameterDiffPreview(proposals, BASE);
    expect(serializeDiffPreview(first)).toBe(serializeDiffPreview(second));
  });
});

describe("formatting", () => {
  it("renders whole values without trailing decimals", () => {
    expect(formatSimulatedValue(7, "days")).toBe("7 days");
    expect(formatSimulatedValue(3, "of 5")).toBe("3 of 5");
  });

  it("renders fractional values with a unit", () => {
    expect(formatSimulatedValue(0.75, "bps")).toMatch(/0\.75 bps/);
  });
});