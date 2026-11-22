import { describe, expect, it } from "vitest";
import { buildReconciliationReport } from "../src/services/reconciliationReport.js";
import type { DriftRecord, ReconciliationResult } from "../src/services/reconciler.js";

const makeResult = (drifts: DriftRecord[], steps = 0): ReconciliationResult => ({
  driftsFound: drifts.length,
  stepsProposed: steps,
  stepsApplied: 0,
  quarantined: 0,
  plan: {
    drifts,
    steps: Array.from({ length: steps }, (_, index) => ({
      table: "action_ledger",
      recordId: `record-${index}`,
      action: "update" as const,
      data: { status: "orphaned" },
      provenance: `drift:test:${index}`
    })),
    dryRun: true
  }
});

const drift = (type: DriftRecord["type"], recordId: string): DriftRecord => ({
  type,
  recordType: type === "orphaned_settlement" ? "vault_settlement" : "action_ledger",
  recordId,
  details: { message: `${type} fixture` }
});

describe("buildReconciliationReport", () => {
  it("groups missing records and includes repair guidance", () => {
    const report = buildReconciliationReport(makeResult([
      drift("missing_event", "action-1"),
      drift("missing_action", "event-1"),
      drift("missing_settlement", "action-2")
    ]), "2026-09-30T00:00:00.000Z");

    expect(report.readOnly).toBe(true);
    expect(report.mode).toBe("dry-run");
    expect(report.summary.findingsByCategory.missing).toBe(3);
    expect(report.findings.every((finding) => finding.guidance.length > 0)).toBe(true);
  });

  it("identifies duplicate transaction records", () => {
    const report = buildReconciliationReport(makeResult([
      drift("duplicate_tx_hash", "action-a"),
      drift("duplicate_tx_hash", "action-b")
    ]));

    expect(report.summary.findingsByCategory.duplicate).toBe(2);
    expect(report.summary.findingsByType.duplicate_tx_hash).toBe(2);
  });

  it("identifies stale records and proposed repairs without applying them", () => {
    const report = buildReconciliationReport(makeResult([
      drift("stale_orphan", "action-old"),
      drift("orphaned_settlement", "settlement-old"),
      drift("stale_pending_event", "tx-old")
    ], 1));

    expect(report.summary.findingsByCategory.stale).toBe(3);
    expect(report.summary.proposedRepairs).toBe(1);
    expect(report.operatorGuidance[0]).toMatch(/read-only/i);
  });

  it("flags inconsistent financial state for operator review", () => {
    const report = buildReconciliationReport(makeResult([
      drift("contradiction", "action-conflict"),
      drift("insolvency_drift", "vault-1")
    ]));

    expect(report.summary.findingsByCategory.inconsistent).toBe(2);
    expect(report.operatorGuidance.join(" ")).toMatch(/operator review/i);
    expect(report.findings.find((finding) => finding.type === "insolvency_drift")?.guidance).toMatch(/financial/i);
  });
});
