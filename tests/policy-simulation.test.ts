import { describe, expect, it, vi } from "vitest";
import {
  POLICY_CATALOG,
  IrreversiblePolicyError,
  PolicyConfirmationRequiredError,
  PolicyPreviewStaleError,
  createPolicyPreview,
  getPolicySpec,
  parsePolicyPreview,
  policyRiskRank,
  preparePolicyApplication,
  serializePolicyPreview,
  simulatePolicyChange,
  validatePolicyValue,
  type PolicyImpactMeasurement,
  type PolicyImpactSource,
} from "../lib/policy-simulation";

const CREATED_AT = "2026-10-16T12:00:00.000Z";

function measurement(overrides: Partial<PolicyImpactMeasurement> = {}): PolicyImpactMeasurement {
  return {
    affectedRecords: 120,
    affectedUsers: 40,
    sampleRecords: ["export-1", "export-2"],
    measuredAt: CREATED_AT,
    ...overrides,
  };
}

function fakeSource(overrides: Partial<Record<string, PolicyImpactMeasurement>> = {}): PolicyImpactSource {
  return {
    measure: (change) => overrides[change.policyId] ?? measurement(),
  };
}

describe("policy catalog", () => {
  it("catalogs every policy with side effects, surfaces, and rollback constraints", () => {
    expect(POLICY_CATALOG.length).toBeGreaterThanOrEqual(5);
    for (const spec of POLICY_CATALOG) {
      expect(getPolicySpec(spec.id)).toBe(spec);
      expect(spec.sideEffects.length).toBeGreaterThan(0);
      expect(spec.affectedSurfaces.length).toBeGreaterThan(0);
      expect(spec.rollbackConstraints.length).toBeGreaterThan(0);
    }
  });

  it("marks only retention as irreversible", () => {
    expect(getPolicySpec("retention.userDataExportDays")?.reversible).toBe(false);
    for (const id of [
      "notifications.optionalMuteDefaultDays",
      "featureFlag.rolloutPercent",
      "search.indexRebuildRequired",
      "access.walletSessionTtlHours",
    ]) {
      expect(getPolicySpec(id)?.reversible).toBe(true);
    }
  });
});

describe("value validation", () => {
  it("accepts in-bounds values", () => {
    expect(validatePolicyValue("featureFlag.rolloutPercent", 25)).toEqual([]);
    expect(validatePolicyValue("search.indexRebuildRequired", true)).toEqual([]);
  });

  it("rejects out-of-bounds, non-integer, and wrong-typed values", () => {
    expect(validatePolicyValue("featureFlag.rolloutPercent", 250)[0].field).toBe("value");
    expect(validatePolicyValue("access.walletSessionTtlHours", 12.5)[0].field).toBe("type");
    expect(validatePolicyValue("search.indexRebuildRequired", 1)[0].field).toBe("type");
    expect(validatePolicyValue("nope", 1)[0].field).toBe("policy");
  });
});

describe("single-change simulation", () => {
  it("previews affected records/users, side effects, and rollback constraints", () => {
    const change = simulatePolicyChange(
      { policyId: "retention.userDataExportDays", from: 30, to: 7 },
      measurement({ affectedRecords: 12_000, affectedUsers: 300 }),
    );

    expect(change.state).toBe("valid");
    expect(change.impact?.affectedRecords).toBe(12_000);
    expect(change.impact?.affectedUsers).toBe(300);
    expect(change.sideEffects.some((effect) => effect.includes("purge"))).toBe(true);
    expect(change.rollback.reversible).toBe(false);
    expect(change.rollback.constraints.some((constraint) => constraint.includes("restore"))).toBe(true);
    // 30 → 7 is a large relative change AND over the record threshold.
    expect(change.risk).toBe("high");
    expect(change.highImpact).toBe(true);
    expect(change.requiresConfirmation).toBe(true);
    expect(change.requiresApproval).toBe(true);
  });

  it("blocks a stale base value", () => {
    const change = simulatePolicyChange({ policyId: "featureFlag.rolloutPercent", from: 10, to: 50 }, measurement());
    expect(change.state).toBe("blocked");
    expect(change.issues.some((issue) => issue.field === "stale")).toBe(true);
  });

  it("blocks an invalid value", () => {
    const change = simulatePolicyChange(
      { policyId: "notifications.optionalMuteDefaultDays", from: 0, to: -5 },
      measurement(),
    );
    expect(change.state).toBe("blocked");
    expect(change.validated).toBe(false);
  });

  it("blocks unknown policies and reports loudly", () => {
    const change = simulatePolicyChange({ policyId: "does.not.exist", from: 1, to: 2 }, null);
    expect(change.state).toBe("blocked");
    expect(change.requiresApproval).toBe(true);
    expect(change.issues[0].field).toBe("policy");
  });

  it("escalates risk from measured impact thresholds", () => {
    const change = simulatePolicyChange(
      { policyId: "featureFlag.rolloutPercent", from: 0, to: 10 },
      measurement({ affectedRecords: 1, affectedUsers: 500_000 }),
    );
    expect(change.impact?.affectedUsers).toBe(500_000);
    expect(change.risk).toBe("high");
    expect(change.riskMessage).toContain("threshold");
  });

  it("treats a no-op as risk none and confirmation-free", () => {
    const change = simulatePolicyChange({ policyId: "featureFlag.rolloutPercent", from: 0, to: 0 }, measurement());
    expect(change.risk).toBe("none");
    expect(change.requiresConfirmation).toBe(false);
    expect(policyRiskRank(change.risk)).toBe(0);
  });
});

describe("full preview", () => {
  it("produces a deterministic preview with a confirmation token bound to impact", async () => {
    const requests = [
      { policyId: "notifications.optionalMuteDefaultDays", from: 0, to: 3 },
      { policyId: "featureFlag.rolloutPercent", from: 0, to: 100 },
    ];
    const first = await createPolicyPreview(requests, fakeSource(), { createdAt: CREATED_AT });
    const second = await createPolicyPreview(requests, fakeSource(), { createdAt: CREATED_AT });

    expect(first.id).toBe(second.id);
    expect(first.confirmationToken).toBe(second.confirmationToken);
    expect(first.summary.valid).toBe(2);
    expect(first.summary.totalAffectedRecords).toBe(240);
    expect(first.summary.totalAffectedUsers).toBe(80);
    expect(first.rollbackPlan.reversible).toBe(true);

    const differentImpact = await createPolicyPreview(requests, fakeSource({
      "featureFlag.rolloutPercent": measurement({ affectedUsers: 999 }),
    }), { createdAt: CREATED_AT });
    expect(differentImpact.confirmationToken).not.toBe(first.confirmationToken);
  });

  it("fails loudly when the impact source throws", async () => {
    const source: PolicyImpactSource = {
      measure: (change) => {
        if (change.policyId === "search.indexRebuildRequired") throw new Error("db timeout");
        return measurement();
      },
    };
    const preview = await createPolicyPreview(
      [
        { policyId: "search.indexRebuildRequired", from: false, to: true },
        { policyId: "featureFlag.rolloutPercent", from: 0, to: 5 },
      ],
      source,
      { createdAt: CREATED_AT },
    );
    const broken = preview.changes.find((change) => change.request.policyId === "search.indexRebuildRequired")!;
    expect(broken.state).toBe("blocked");
    expect(broken.issues.some((issue) => issue.field === "impact" && issue.message.includes("db timeout"))).toBe(true);
    expect(preview.summary.blocked).toBe(1);
  });

  it("aggregates an irreversible rollback plan with a warning", async () => {
    const preview = await createPolicyPreview(
      [{ policyId: "retention.userDataExportDays", from: 30, to: 7 }],
      fakeSource(),
      { createdAt: CREATED_AT },
    );
    expect(preview.rollbackPlan.reversible).toBe(false);
    expect(preview.rollbackPlan.warning).toContain("irreversible");
    expect(preview.summary.irreversible).toBe(1);
  });

  it("still blocks invalid changes (validation wins over measurement)", async () => {
    const measure = vi.fn(() => measurement());
    const preview = await createPolicyPreview(
      [{ policyId: "access.walletSessionTtlHours", from: 72, to: 2.5 }],
      { measure },
      { createdAt: CREATED_AT },
    );
    expect(measure).toHaveBeenCalledTimes(1); // measured, but validation still blocks
    expect(preview.summary.blocked).toBe(1);
  });

  it("round-trips through serialization", async () => {
    const preview = await createPolicyPreview(
      [{ policyId: "featureFlag.rolloutPercent", from: 0, to: 10 }],
      fakeSource(),
      { createdAt: CREATED_AT },
    );
    const parsed = parsePolicyPreview(serializePolicyPreview(preview));
    expect(parsed?.confirmationToken).toBe(preview.confirmationToken);
    expect(parsePolicyPreview("{nope")).toBeNull();
    expect(parsePolicyPreview(JSON.stringify({ schema: "other" }))).toBeNull();
  });
});

describe("application gatekeeping", () => {
  async function previewFor(requests: Parameters<typeof createPolicyPreview>[0]) {
    return createPolicyPreview(requests, fakeSource(), { createdAt: CREATED_AT });
  }

  it("requires the exact confirmation token for confirmed previews", async () => {
    const preview = await previewFor([{ policyId: "featureFlag.rolloutPercent", from: 0, to: 100 }]);
    expect(preview.changes[0].requiresConfirmation).toBe(true);

    expect(() => preparePolicyApplication(preview)).toThrow(PolicyConfirmationRequiredError);
    expect(() => preparePolicyApplication(preview, { confirmedToken: "wrong" })).toThrow(PolicyPreviewStaleError);

    const plan = preparePolicyApplication(preview, { confirmedToken: preview.confirmationToken });
    expect(plan.activated).toBe(false);
    expect(plan.changes).toEqual([{ policyId: "featureFlag.rolloutPercent", from: 0, to: 100 }]);
    expect(plan.rollbackSteps.length).toBeGreaterThan(0);
  });

  it("refuses blocked previews even with a token", async () => {
    const preview = await previewFor([{ policyId: "featureFlag.rolloutPercent", from: 0, to: 500 }]);
    expect(() => preparePolicyApplication(preview, { confirmedToken: preview.confirmationToken })).toThrow(
      /blocked/i,
    );
  });

  it("requires explicit acknowledgement for irreversible changes", async () => {
    const preview = await previewFor([{ policyId: "retention.userDataExportDays", from: 30, to: 7 }]);
    expect(() =>
      preparePolicyApplication(preview, { confirmedToken: preview.confirmationToken }),
    ).toThrow(IrreversiblePolicyError);

    const plan = preparePolicyApplication(preview, {
      confirmedToken: preview.confirmationToken,
      acknowledgeIrreversible: true,
    });
    expect(plan.irreversibleAcknowledged).toBe(true);
    expect(plan.activated).toBe(false);
  });

  it("allows a no-op application without a token", async () => {
    const preview = await previewFor([{ policyId: "notifications.optionalMuteDefaultDays", from: 0, to: 0 }]);
    const plan = preparePolicyApplication(preview);
    expect(plan.changes[0].to).toBe(0);
  });
});
