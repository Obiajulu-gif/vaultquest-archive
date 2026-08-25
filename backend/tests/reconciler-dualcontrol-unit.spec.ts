import { describe, it, expect, vi } from "vitest";
import {
  createRepairProposal,
  approveRepairProposal,
  executeRepairProposal,
  computeDiffHash,
  DEFAULT_REPAIR_PROPOSAL_LIMITS,
  type RepairPlan
} from "../src/services/reconciler.js";

function samplePlan(stepCount = 1): RepairPlan {
  return {
    dryRun: false,
    drifts: [],
    steps: Array.from({ length: stepCount }, (_, i) => ({
      table: "action_ledger" as const,
      recordId: `action-${i}`,
      action: "update" as const,
      data: { status: "orphaned" },
      provenance: `drift:missing_event:action-${i}`
    }))
  };
}

function makeMockPrisma(overrides: Record<string, any> = {}) {
  const proposals = new Map<string, any>();
  let seq = 0;

  return {
    repairProposal: {
      create: vi.fn(async ({ data }: any) => {
        const id = `proposal-${++seq}`;
        const record = { id, approvals: [], ...data };
        proposals.set(id, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: any) => proposals.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const record = proposals.get(where.id);
        const updated = { ...record, ...data };
        proposals.set(where.id, updated);
        return updated;
      })
    },
    repairApproval: {
      create: vi.fn(async ({ data }: any) => {
        const record = proposals.get(data.proposalId);
        record.approvals.push({ approverId: data.approverId, proposalId: data.proposalId });
        return data;
      })
    },
    repairAudit: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({}))
    },
    repairQuarantine: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({}))
    },
    actionLedger: {
      update: vi.fn(async () => ({}))
    },
    vaultSettlement: {
      update: vi.fn(async () => ({}))
    },
    pendingEvent: {
      delete: vi.fn(async () => ({}))
    },
    ...overrides
  } as any;
}

describe("reconciliation dual-control proposal workflow (#597)", () => {
  it("computes a stable diff hash for identical plans", () => {
    const a = computeDiffHash(samplePlan(2));
    const b = computeDiffHash(samplePlan(2));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("rejects proposals above the hard per-proposal step cap", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(DEFAULT_REPAIR_PROPOSAL_LIMITS.maxStepsPerProposal + 1);
    await expect(createRepairProposal(prisma, plan, "proposer-1")).rejects.toThrow(/max steps/);
  });

  it("requires two distinct approvals once the step threshold is exceeded", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(DEFAULT_REPAIR_PROPOSAL_LIMITS.dualControlStepThreshold + 1);
    const proposal = await createRepairProposal(prisma, plan, "proposer-1");
    expect(proposal.requiredApprovals).toBe(2);

    const diffHash = computeDiffHash(plan);
    await approveRepairProposal(prisma, proposal.id, "approver-a", diffHash);
    const afterOne = await prisma.repairProposal.findUnique({ where: { id: proposal.id } });
    expect(afterOne.status).toBe("pending");

    await approveRepairProposal(prisma, proposal.id, "approver-b", diffHash);
    const afterTwo = await prisma.repairProposal.findUnique({ where: { id: proposal.id } });
    expect(afterTwo.status).toBe("approved");
  });

  it("rejects the proposer approving their own proposal", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(1);
    const proposal = await createRepairProposal(prisma, plan, "proposer-1");
    await expect(
      approveRepairProposal(prisma, proposal.id, "proposer-1", computeDiffHash(plan))
    ).rejects.toThrow(/cannot also approve/);
  });

  it("rejects an approval whose diff hash no longer matches the proposal", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(1);
    const proposal = await createRepairProposal(prisma, plan, "proposer-1");
    await expect(
      approveRepairProposal(prisma, proposal.id, "approver-a", "0".repeat(64))
    ).rejects.toThrow(/diff hash does not match/);
  });

  it("rejects execution before required approvals are met", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(1);
    const proposal = await createRepairProposal(prisma, plan, "proposer-1");
    await expect(executeRepairProposal(prisma, proposal.id, "executor-1")).rejects.toThrow(/requires 1 approval/);
  });

  it("executes an approved single-approval proposal and applies its steps", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(1);
    const proposal = await createRepairProposal(prisma, plan, "proposer-1");
    await approveRepairProposal(prisma, proposal.id, "approver-a", computeDiffHash(plan));

    const result = await executeRepairProposal(prisma, proposal.id, "executor-1");
    expect(result.applied).toBe(1);
    expect(prisma.actionLedger.update).toHaveBeenCalledTimes(1);

    const final = await prisma.repairProposal.findUnique({ where: { id: proposal.id } });
    expect(final.status).toBe("executed");
  });

  it("resumes idempotently: re-executing an already-executed proposal is a safe no-op", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(1);
    const proposal = await createRepairProposal(prisma, plan, "proposer-1");
    await approveRepairProposal(prisma, proposal.id, "approver-a", computeDiffHash(plan));

    const first = await executeRepairProposal(prisma, proposal.id, "executor-1");
    expect(first.applied).toBe(1);

    const second = await executeRepairProposal(prisma, proposal.id, "executor-1");
    expect(second.applied).toBe(0);
    expect(second.quarantined).toBe(0);
    // The underlying step is only ever applied once.
    expect(prisma.actionLedger.update).toHaveBeenCalledTimes(1);
  });

  it("rejects re-execution of a proposal whose stored plan diverges from its diff hash", async () => {
    const prisma = makeMockPrisma();
    const plan = samplePlan(1);
    const proposal = await createRepairProposal(prisma, plan, "proposer-1");
    await approveRepairProposal(prisma, proposal.id, "approver-a", computeDiffHash(plan));

    // Tamper with the stored plan after approval.
    const stored = await prisma.repairProposal.findUnique({ where: { id: proposal.id } });
    stored.planJson = { ...stored.planJson, steps: [] };

    await expect(executeRepairProposal(prisma, proposal.id, "executor-1")).rejects.toThrow(
      /no longer matches its diff hash/
    );
  });
});
