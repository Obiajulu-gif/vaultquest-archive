import { describe, expect, it } from "vitest";
import { buildLifecycleReport, redactLifecycleReport } from "../src/services/lifecycleAnalyticsService.js";

describe("lifecycle analytics", () => {
  it("deterministically reports conversion and abandonment without subject identifiers", () => {
    const report = buildLifecycleReport([
      { subjectId: "private-a", stage: "discovered", outcome: "entered", occurredAt: "2026-01-01T00:00:00Z" },
      { subjectId: "private-a", stage: "started", outcome: "entered", occurredAt: "2026-01-01T00:01:00Z" },
      { subjectId: "private-b", stage: "discovered", outcome: "entered", occurredAt: "2026-01-01T00:00:00Z" },
      { subjectId: "private-b", stage: "started", outcome: "abandoned", occurredAt: "2026-01-01T00:02:00Z" }
    ], "2026-01-02T00:00:00.000Z");
    expect(report.stages.discovered.entrants).toBe(2);
    expect(report.stages.started.abandoned).toBe(1);
    expect(report.transitions[0]).toEqual({ from: "discovered", to: "started", entrants: 2, conversionRate: 1 });
    expect(JSON.stringify(redactLifecycleReport(report))).not.toContain("private-a");
  });
});
