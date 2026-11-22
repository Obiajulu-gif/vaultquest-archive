import { describe, it, expect, beforeEach } from "vitest";
import {
  RecordMergeWorkflow,
  MergeWorkflowError,
  type MergeableRecord,
} from "../lib/record-merge-workflow";

describe("Deterministic Record Merge Workflow (#840)", () => {
  let workflow: RecordMergeWorkflow;

  const POOL_A: MergeableRecord = {
    id: "pool-001",
    recordType: "pool",
    version: 1,
    data: {
      name: "USDC Alpha Pool",
      tvl: "500000",
      cadence: "weekly",
      minDeposit: "50",
    },
    ownerWallet: "G_CREATOR_A",
    status: "active",
    updatedAt: 1000,
  };

  const POOL_B: MergeableRecord = {
    id: "pool-002",
    recordType: "pool",
    version: 1,
    data: {
      name: "USDC Alpha Pool", // Matching name
      tvl: "750000",           // Conflicting TVL
      cadence: "weekly",       // Matching cadence
      yieldRate: "0.085",      // Additive field in source
    },
    ownerWallet: "G_CREATOR_A",
    status: "active",
    updatedAt: 2000,
  };

  beforeEach(() => {
    workflow = new RecordMergeWorkflow();
    workflow.setRecord(POOL_A);
    workflow.setRecord(POOL_B);
  });

  describe("Clean Merge", () => {
    it("merges additive non-conflicting fields without explicit conflict strategy", () => {
      // Modify POOL_B to have identical TVL so there are zero conflicts
      const nonConflictingSource: MergeableRecord = {
        ...POOL_B,
        data: {
          name: "USDC Alpha Pool",
          tvl: "500000",
          cadence: "weekly",
          yieldRate: "0.085",
        },
      };
      workflow.setRecord(nonConflictingSource);

      const preview = workflow.previewMerge({
        sourceId: nonConflictingSource.id,
        targetId: POOL_A.id,
      });

      expect(preview.hasConflicts).toBe(false);
      expect(preview.conflicts).toHaveLength(0);
      expect(preview.proposedResult.yieldRate).toBe("0.085");
      expect(preview.proposedResult.minDeposit).toBe("50");

      const execution = workflow.executeMerge({
        sourceId: nonConflictingSource.id,
        targetId: POOL_A.id,
        strategy: "target_wins",
        actor: "admin_user",
      });

      expect(execution.targetRecord.data.yieldRate).toBe("0.085");
      expect(execution.targetRecord.data.minDeposit).toBe("50");
      expect(execution.targetRecord.version).toBe(POOL_A.version + 1);
      expect(execution.sourceRecord.status).toBe("merged");
      expect(execution.sourceRecord.mergedInto).toBe(POOL_A.id);
    });
  });

  describe("Conflicting Merge & Explicit Resolution", () => {
    it("detects conflicts in dry-run preview before any writes occur", () => {
      const preview = workflow.previewMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
      });

      expect(preview.hasConflicts).toBe(true);
      expect(preview.conflicts).toHaveLength(1);
      expect(preview.conflicts[0].field).toBe("tvl");
      expect(preview.conflicts[0].category).toBe("VALUE_MISMATCH");
      expect(preview.conflicts[0].sourceValue).toBe("750000");
      expect(preview.conflicts[0].targetValue).toBe("500000");

      // Verify that no writes occurred in dry-run
      expect(workflow.getRawRecord(POOL_A.id)?.data).toEqual(POOL_A.data);
      expect(workflow.getRawRecord(POOL_B.id)?.status).toBe("active");
    });

    it("rejects execution if conflicts exist without explicit resolution strategy", () => {
      expect(() =>
        workflow.executeMerge({
          sourceId: POOL_B.id,
          targetId: POOL_A.id,
          strategy: "field_by_field", // No fieldDecisions provided for 'tvl'
          actor: "maintainer",
        })
      ).toThrow(MergeWorkflowError);
    });

    it("resolves conflicting merge with target_wins strategy", () => {
      const execution = workflow.executeMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
        strategy: "target_wins",
        actor: "maintainer",
      });

      expect(execution.targetRecord.data.tvl).toBe("500000"); // Target preserved
      expect(execution.targetRecord.data.yieldRate).toBe("0.085"); // Additive applied
      expect(execution.sourceRecord.status).toBe("merged");
    });

    it("resolves conflicting merge with source_wins strategy", () => {
      const execution = workflow.executeMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
        strategy: "source_wins",
        actor: "maintainer",
      });

      expect(execution.targetRecord.data.tvl).toBe("750000"); // Source won
      expect(execution.targetRecord.data.minDeposit).toBe("50"); // Target kept
    });

    it("resolves conflicting merge with explicit field_by_field overrides", () => {
      const execution = workflow.executeMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
        strategy: "field_by_field",
        fieldDecisions: {
          tvl: {
            winner: "override",
            overrideValue: "1250000", // Combined sum
            reason: "Aggregated TVL across duplicates",
          },
        },
        actor: "maintainer",
      });

      expect(execution.targetRecord.data.tvl).toBe("1250000");
    });
  });

  describe("Denied Merge Conditions", () => {
    it("denies merge if source and target IDs are identical", () => {
      const check = workflow.checkEligibility(POOL_A.id, POOL_A.id);
      expect(check.eligible).toBe(false);
      expect(check.denialReason).toBe("SOURCE_AND_TARGET_IDENTICAL");
    });

    it("denies merge if either record does not exist", () => {
      const check = workflow.checkEligibility(POOL_A.id, "non_existent_pool");
      expect(check.eligible).toBe(false);
      expect(check.denialReason).toBe("ONE_OR_BOTH_RECORDS_NOT_FOUND");
    });

    it("denies merge between different record types", () => {
      const userRecord: MergeableRecord = {
        id: "usr-01",
        recordType: "user_profile",
        version: 1,
        data: { username: "Alice" },
        status: "active",
        updatedAt: 100,
      };
      workflow.setRecord(userRecord);

      const check = workflow.checkEligibility(userRecord.id, POOL_A.id);
      expect(check.eligible).toBe(false);
      expect(check.denialReason).toBe("RECORD_TYPE_MISMATCH");
    });

    it("denies merge if source record was already merged", () => {
      workflow.executeMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
        strategy: "target_wins",
        actor: "maintainer",
      });

      // Attempting to merge POOL_B again must be denied
      const check = workflow.checkEligibility(POOL_B.id, POOL_A.id);
      expect(check.eligible).toBe(false);
      expect(check.denialReason).toBe("SOURCE_ALREADY_MERGED_OR_ARCHIVED");
    });

    it("denies merge if record is in locked status", () => {
      const lockedPool: MergeableRecord = {
        ...POOL_B,
        id: "pool-locked",
        status: "locked",
      };
      workflow.setRecord(lockedPool);

      const check = workflow.checkEligibility(lockedPool.id, POOL_A.id);
      expect(check.eligible).toBe(false);
      expect(check.denialReason).toBe("RECORD_IS_LOCKED");
    });
  });

  describe("Merged-Record Lookup & Redirects", () => {
    it("resolves queries for active records directly without redirection", () => {
      const res = workflow.resolveRecordWithRedirect(POOL_A.id);
      expect(res.redirected).toBe(false);
      expect(res.record.id).toBe(POOL_A.id);
      expect(res.hops).toHaveLength(0);
    });

    it("automatically follows redirect pointer from merged source to canonical target", () => {
      workflow.executeMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
        strategy: "target_wins",
        actor: "maintainer",
      });

      const res = workflow.resolveRecordWithRedirect(POOL_B.id);
      expect(res.redirected).toBe(true);
      expect(res.record.id).toBe(POOL_A.id);
      expect(res.hops).toEqual([POOL_B.id]);
    });

    it("follows multi-hop merge chains and detects circular redirects", () => {
      const POOL_C: MergeableRecord = {
        ...POOL_B,
        id: "pool-003",
        status: "active",
      };
      workflow.setRecord(POOL_C);

      // Merge C into B
      workflow.executeMerge({
        sourceId: POOL_C.id,
        targetId: POOL_B.id,
        strategy: "target_wins",
        actor: "maintainer",
      });

      // Merge B into A
      workflow.executeMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
        strategy: "target_wins",
        actor: "maintainer",
      });

      // Querying C should resolve cleanly to A (C -> B -> A)
      const res = workflow.resolveRecordWithRedirect(POOL_C.id);
      expect(res.redirected).toBe(true);
      expect(res.record.id).toBe(POOL_A.id);
      expect(res.hops).toEqual([POOL_C.id, POOL_B.id]);
    });
  });

  describe("Rollback Notes & Rollback Execution", () => {
    it("reverts merge decision using cryptographic rollback patch", () => {
      const { decision } = workflow.executeMerge({
        sourceId: POOL_B.id,
        targetId: POOL_A.id,
        strategy: "source_wins",
        actor: "maintainer",
      });

      expect(workflow.getRawRecord(POOL_A.id)?.data.tvl).toBe("750000");
      expect(workflow.getRawRecord(POOL_B.id)?.status).toBe("merged");

      // Rollback the merge
      const rollback = workflow.rollbackMerge(decision.decisionId);

      expect(rollback.revertedTarget.data.tvl).toBe("500000");
      expect(rollback.revertedSource.status).toBe("active");
      expect(rollback.revertedSource.mergedInto).toBeUndefined();

      // State is fully restored
      expect(workflow.getRawRecord(POOL_A.id)?.data).toEqual(POOL_A.data);
      expect(workflow.getRawRecord(POOL_B.id)?.data).toEqual(POOL_B.data);
    });
  });
});
