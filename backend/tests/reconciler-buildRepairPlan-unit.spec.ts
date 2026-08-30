import { describe, it, expect } from "vitest";
import {
  buildRepairPlan,
  staleOrphanBucket,
  type DriftRecord
} from "../src/services/reconciler.js";
import { getPrometheusMetrics } from "../src/services/prometheusMetrics.js";

function makeDrift(overrides: Partial<DriftRecord> & { type: DriftRecord["type"] }): DriftRecord {
  return {
    recordType: "action_ledger",
    recordId: "test-id",
    details: {},
    ...overrides,
  };
}

describe("buildRepairPlan — branch coverage for every DriftType", () => {
  // ── missing_event ────────────────────────────────────────────────────────

  describe("missing_event", () => {
    it("produces an orphan step when updatedAt is > 5 minutes ago", () => {
      const drifts = [
        makeDrift({
          type: "missing_event",
          recordId: "action-old",
          details: { updatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].action).toBe("update");
      expect(plan.steps[0].table).toBe("action_ledger");
      expect(plan.steps[0].recordId).toBe("action-old");
      expect(plan.steps[0].data.status).toBe("orphaned");
    });

    it("produces no step when updatedAt is < 5 minutes ago", () => {
      const drifts = [
        makeDrift({
          type: "missing_event",
          recordId: "action-fresh",
          details: { updatedAt: new Date(Date.now() - 2 * 60 * 1000).toISOString() },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
    });

    it("produces no step exactly at the 5-minute boundary", () => {
      const drifts = [
        makeDrift({
          type: "missing_event",
          recordId: "action-boundary",
          details: { updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
    });
  });

  // ── missing_action ───────────────────────────────────────────────────────

  describe("missing_action", () => {
    it("produces a delete step when receivedAt is > 1 hour ago", () => {
      const drifts = [
        makeDrift({
          type: "missing_action",
          recordType: "pending_event",
          recordId: "tx-old",
          details: { receivedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].action).toBe("delete");
      expect(plan.steps[0].table).toBe("pending_event");
      expect(plan.steps[0].recordId).toBe("tx-old");
    });

    it("produces no step when receivedAt is < 1 hour ago", () => {
      const drifts = [
        makeDrift({
          type: "missing_action",
          recordType: "pending_event",
          recordId: "tx-recent",
          details: { receivedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
    });
  });

  // ── duplicate_tx_hash ────────────────────────────────────────────────────

  describe("duplicate_tx_hash", () => {
    it("quarantines the drift with no repair step", () => {
      const drifts = [
        makeDrift({
          type: "duplicate_tx_hash",
          recordId: "action-dup",
          details: { txHash: "tx-dup" },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
      expect(plan.drifts).toHaveLength(1);
      expect(plan.drifts[0].type).toBe("duplicate_tx_hash");
    });
  });

  // ── stale_orphan ─────────────────────────────────────────────────────────

  describe("stale_orphan", () => {
    it("produces no repair step (operator review only)", () => {
      const drifts = [
        makeDrift({
          type: "stale_orphan",
          recordId: "action-stale",
          details: { updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
    });

    it("fires the Prometheus stale_orphan counter when a stale orphan is produced", () => {
      const metrics = getPrometheusMetrics();
      const before = metrics.staleOrphansTotal.get({ bucket: "7d" });

      const drifts = [
        makeDrift({
          type: "stale_orphan",
          recordId: "action-stale",
          details: {
            txHash: "tx_stale",
            errorCode: "ORPHAN_TTL_EXPIRED",
            updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);

      // No repair step, but the metric must fire — not silence.
      expect(plan.steps).toHaveLength(0);
      expect(metrics.staleOrphansTotal.get({ bucket: "7d" })).toBe(before + 1);
    });

    it("escalates orphans older than 30 days to the 30d bucket", () => {
      const metrics = getPrometheusMetrics();
      const before = metrics.staleOrphansTotal.get({ bucket: "30d" });

      const drifts = [
        makeDrift({
          type: "stale_orphan",
          recordId: "action-very-stale",
          details: {
            txHash: "tx_very_stale",
            errorCode: "ORPHAN_TTL_EXPIRED",
            updatedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
          },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);

      expect(plan.steps).toHaveLength(0);
      expect(metrics.staleOrphansTotal.get({ bucket: "30d" })).toBe(before + 1);
      expect(
        staleOrphanBucket(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))
      ).toBe("30d");
      expect(
        staleOrphanBucket(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000))
      ).toBe("7d");
    });
  });

  // ── contradiction ────────────────────────────────────────────────────────

  describe("contradiction", () => {
    it("quarantines the drift with no repair step", () => {
      const drifts = [
        makeDrift({
          type: "contradiction",
          recordId: "action-contradict",
          details: { actionStatus: "confirmed", eventStatusHint: "reverted" },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
      expect(plan.drifts).toHaveLength(1);
      expect(plan.drifts[0].type).toBe("contradiction");
    });
  });

  // ── orphaned_settlement ──────────────────────────────────────────────────

  describe("orphaned_settlement", () => {
    it("produces an update step rolling back to Unresolved", () => {
      const drifts = [
        makeDrift({
          type: "orphaned_settlement",
          recordType: "vault_settlement",
          recordId: "settlement-1",
          details: { vaultId: "v1", state: "Resolving", attempts: 3 },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].action).toBe("update");
      expect(plan.steps[0].table).toBe("vault_settlement");
      expect(plan.steps[0].recordId).toBe("settlement-1");
      expect(plan.steps[0].data.state).toBe("Unresolved");
    });
  });

  // ── missing_settlement ───────────────────────────────────────────────────

  describe("missing_settlement", () => {
    it("produces no repair step (informational only)", () => {
      const drifts = [
        makeDrift({
          type: "missing_settlement",
          recordId: "action-no-settlement",
          details: { vaultId: "v-missing" },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
    });
  });

  // ── stale_pending_event ──────────────────────────────────────────────────

  describe("stale_pending_event", () => {
    it("produces a delete step", () => {
      const drifts = [
        makeDrift({
          type: "stale_pending_event",
          recordType: "pending_event",
          recordId: "tx-very-stale",
          details: { txHash: "tx-very-stale" },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].action).toBe("delete");
      expect(plan.steps[0].table).toBe("pending_event");
      expect(plan.steps[0].recordId).toBe("tx-very-stale");
    });
  });

  // ── default / unrecognized DriftType ─────────────────────────────────────

  describe("unrecognized DriftType (future-proofing)", () => {
    it("quarantines an unknown drift type via the default branch", () => {
      const drifts = [
        makeDrift({
          type: "insolvency_drift" as any,
          recordId: "action-future",
          details: { info: "some future drift" },
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      expect(plan.steps).toHaveLength(0);
      expect(plan.drifts).toHaveLength(1);
    });
  });

  // ── multiple drifts in a single plan ─────────────────────────────────────

  describe("mixed drifts", () => {
    it("produces correct steps for a mix of drift types", () => {
      const drifts = [
        makeDrift({
          type: "missing_event",
          recordId: "a1",
          details: { updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() },
        }),
        makeDrift({
          type: "contradiction",
          recordId: "a2",
          details: { actionStatus: "confirmed", eventStatusHint: "reverted" },
        }),
        makeDrift({
          type: "stale_pending_event",
          recordType: "pending_event",
          recordId: "tx1",
          details: {},
        }),
        makeDrift({
          type: "orphaned_settlement",
          recordType: "vault_settlement",
          recordId: "s1",
          details: {},
        }),
      ];
      const plan = buildRepairPlan(drifts, true);
      // missing_event: 1 update, stale_pending_event: 1 delete, orphaned_settlement: 1 update
      expect(plan.steps).toHaveLength(3);
      expect(plan.drifts).toHaveLength(4);
    });
  });

  // ── dryRun flag passthrough ──────────────────────────────────────────────

  describe("dryRun flag", () => {
    it("passes dryRun through to the plan", () => {
      const plan = buildRepairPlan([], true);
      expect(plan.dryRun).toBe(true);
    });

    it("passes dryRun=false through to the plan", () => {
      const plan = buildRepairPlan([], false);
      expect(plan.dryRun).toBe(false);
    });
  });

  // ── empty drifts ─────────────────────────────────────────────────────────

  describe("empty drifts", () => {
    it("returns a plan with no steps", () => {
      const plan = buildRepairPlan([], false);
      expect(plan.steps).toHaveLength(0);
      expect(plan.drifts).toHaveLength(0);
    });
  });
});
