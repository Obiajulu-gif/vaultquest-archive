import type { DriftRecord, ReconciliationResult, RepairStep } from "./reconciler.js";

export type DriftCategory = "missing" | "duplicate" | "stale" | "inconsistent";

export interface ReconciliationFinding {
  category: DriftCategory;
  type: DriftRecord["type"];
  recordType: DriftRecord["recordType"];
  recordId: string;
  details: Record<string, unknown>;
  guidance: string;
}

export interface ReconciliationReport {
  schema: "vaultquest.reconciliation-report.v1";
  generatedAt: string;
  mode: "dry-run";
  readOnly: true;
  summary: {
    driftsFound: number;
    proposedRepairs: number;
    findingsByCategory: Record<DriftCategory, number>;
    findingsByType: Partial<Record<DriftRecord["type"], number>>;
  };
  findings: ReconciliationFinding[];
  proposedRepairs: RepairStep[];
  operatorGuidance: string[];
}

const CATEGORY_BY_TYPE: Record<DriftRecord["type"], DriftCategory> = {
  missing_event: "missing",
  missing_action: "missing",
  missing_settlement: "missing",
  duplicate_tx_hash: "duplicate",
  stale_orphan: "stale",
  orphaned_settlement: "stale",
  stale_pending_event: "stale",
  contradiction: "inconsistent",
  insolvency_drift: "inconsistent"
};

const GUIDANCE_BY_TYPE: Record<DriftRecord["type"], string> = {
  missing_event: "Verify the transaction on Stellar and re-run the indexer before changing the action state.",
  missing_action: "Trace the event to its originating transaction and create or quarantine the missing intent; do not invent user activity.",
  missing_settlement: "Verify the confirmed action, vault, recipient, and amount against chain evidence before creating a settlement record.",
  duplicate_tx_hash: "Compare the duplicate intents and retain the canonical user action; resolve through an audited operator change.",
  stale_orphan: "Review the original transaction and user support history; keep the orphaned record until an operator resolves it.",
  orphaned_settlement: "Confirm worker and lease health, then retry the settlement through the controlled repair workflow.",
  stale_pending_event: "Check indexer coverage and event ownership before pruning the unconsumed event.",
  contradiction: "Compare the action, event, and canonical Stellar result; quarantine until an operator confirms the correct terminal state.",
  insolvency_drift: "Freeze automated financial repair and audit deposits, withdrawals, fees, and payouts against chain evidence."
};

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  return values.reduce<Partial<Record<T, number>>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

/** Converts a reconciliation result into a stable, JSON-friendly, read-only report. */
export function buildReconciliationReport(
  result: ReconciliationResult,
  generatedAt = new Date().toISOString()
): ReconciliationReport {
  const findings = result.plan.drifts.map((drift) => ({
    category: CATEGORY_BY_TYPE[drift.type],
    type: drift.type,
    recordType: drift.recordType,
    recordId: drift.recordId,
    details: drift.details,
    guidance: GUIDANCE_BY_TYPE[drift.type]
  }));

  const categories = findings.map((finding) => finding.category);
  const types = findings.map((finding) => finding.type);
  const operatorGuidance = [
    "This report is read-only: no production records, balances, settlements, or chain state were mutated.",
    ...(result.plan.steps.length > 0
      ? ["Review proposed repairs against current chain evidence before submitting them through the controlled repair workflow."]
      : []),
    ...(findings.some((finding) => finding.category === "inconsistent")
      ? ["Inconsistent financial state requires operator review; do not auto-apply a repair based on this report alone."]
      : [])
  ];

  return {
    schema: "vaultquest.reconciliation-report.v1",
    generatedAt,
    mode: "dry-run",
    readOnly: true,
    summary: {
      driftsFound: findings.length,
      proposedRepairs: result.plan.steps.length,
      findingsByCategory: {
        missing: categories.filter((category) => category === "missing").length,
        duplicate: categories.filter((category) => category === "duplicate").length,
        stale: categories.filter((category) => category === "stale").length,
        inconsistent: categories.filter((category) => category === "inconsistent").length
      },
      findingsByType: countBy(types)
    },
    findings,
    proposedRepairs: result.plan.steps,
    operatorGuidance
  };
}
