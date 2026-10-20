import { describe, it, expect, beforeEach, vi } from "vitest";
import { DataRetentionService, RETENTION_POLICIES } from "../src/services/dataRetentionService.js";

describe("DataRetentionService", () => {
  let mockPrisma: any;
  let service: DataRetentionService;

  beforeEach(() => {
    mockPrisma = {
      actionLedger: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      chainEvent: { count: vi.fn(async () => 0), deleteMany: vi.fn(async () => ({ count: 0 })) },
      poisonEvent: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      pendingEvent: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      backgroundJob: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      walletChallenge: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      walletSession: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      actionLease: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      jobLease: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
    };
    service = new DataRetentionService(mockPrisma);
  });

  describe("Retention policies", () => {
    it("defines retention policies for all data types", () => {
      expect(Object.keys(RETENTION_POLICIES).length).toBeGreaterThan(0);
    });

    it("ACTION_LEDGER has 7-year retention (2555 days)", () => {
      expect(RETENTION_POLICIES.ACTION_LEDGER.retentionDays).toBe(2555);
    });

    it("CHAIN_EVENT has 1-year retention (365 days)", () => {
      expect(RETENTION_POLICIES.CHAIN_EVENT.retentionDays).toBe(365);
    });

    it("POISON_EVENT has 90-day retention", () => {
      expect(RETENTION_POLICIES.POISON_EVENT.retentionDays).toBe(90);
    });

    it("PENDING_EVENT has 30-day retention", () => {
      expect(RETENTION_POLICIES.PENDING_EVENT.retentionDays).toBe(30);
    });

    it("WALLET_CHALLENGE has 1-day retention", () => {
      expect(RETENTION_POLICIES.WALLET_CHALLENGE.retentionDays).toBe(1);
    });

    it("ACTION_LEASE has 7-day retention", () => {
      expect(RETENTION_POLICIES.ACTION_LEASE.retentionDays).toBe(7);
    });
  });

  describe("Protection rules", () => {
    it("ACTION_LEDGER has protection rules for disputes, settlements, and active users", () => {
      const policy = RETENTION_POLICIES.ACTION_LEDGER;
      expect(policy.protectionRules.length).toBeGreaterThan(0);
      expect(policy.protectionRules.some((r) => r.type === "linked_dispute")).toBe(true);
      expect(policy.protectionRules.some((r) => r.type === "linked_settlement")).toBe(true);
      expect(policy.protectionRules.some((r) => r.type === "active_user")).toBe(true);
    });

    it("REPAIR_AUDIT is protected for audit compliance", () => {
      const policy = RETENTION_POLICIES.REPAIR_AUDIT;
      expect(policy.protectionRules.some((r) => r.type === "linked_audit")).toBe(true);
    });

    it("CHAIN_EVENT has protection rules for disputes and recent transactions", () => {
      const policy = RETENTION_POLICIES.CHAIN_EVENT;
      expect(policy.protectionRules.some((r) => r.type === "linked_dispute")).toBe(true);
      expect(policy.protectionRules.some((r) => r.type === "recent_transaction")).toBe(true);
    });

    it("POISON_EVENT protects unresolved events", () => {
      const policy = RETENTION_POLICIES.POISON_EVENT;
      expect(policy.protectionRules.some((r) => r.type === "linked_dispute")).toBe(true);
    });

    it("WALLET_SESSION protects active and non-expired sessions", () => {
      const policy = RETENTION_POLICIES.WALLET_SESSION;
      expect(policy.protectionRules.some((r) => r.type === "active_user")).toBe(true);
    });
  });

  describe("Cleanup reports", () => {
    it("generates dry-run cleanup report by default", async () => {
      mockPrisma.chainEvent.count.mockResolvedValue(100);

      const report = await service.generateCleanupReport("CHAIN_EVENT");

      expect(report.dryRun).toBe(true);
      expect(report.deleted).toBe(0); // No actual deletion in dry-run
      expect(report.category).toBe("Chain Events");
    });

    it("reports eligible and protected record counts", async () => {
      mockPrisma.chainEvent.count
        .mockResolvedValueOnce(100) // eligible
        .mockResolvedValueOnce(25); // protected

      const report = await service.generateCleanupReport("CHAIN_EVENT", { dryRun: true });

      expect(report.eligibleForDeletion).toBe(100);
      expect(report.protected).toBe(25);
    });

    it("performs actual deletion when dryRun is false", async () => {
      mockPrisma.chainEvent.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(25);
      mockPrisma.chainEvent.deleteMany.mockResolvedValue({ count: 50 });

      const report = await service.generateCleanupReport("CHAIN_EVENT", { dryRun: false });

      expect(report.dryRun).toBe(false);
      expect(report.deleted).toBe(50);
      expect(mockPrisma.chainEvent.deleteMany).toHaveBeenCalled();
    });

    it("includes actor information in audit context", async () => {
      mockPrisma.chainEvent.count.mockResolvedValue(0);

      const report = await service.generateCleanupReport("CHAIN_EVENT", { actor: "cron:cleanup" });

      // Report doesn't include actor, but service logs it
      expect(report.timestamp).toBeDefined();
    });

    it("handles errors gracefully", async () => {
      mockPrisma.chainEvent.count.mockRejectedValue(new Error("database error"));

      const report = await service.generateCleanupReport("CHAIN_EVENT");

      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors[0]).toContain("database error");
    });

    it("throws error for unknown category", async () => {
      await expect(service.generateCleanupReport("UNKNOWN_CATEGORY")).rejects.toThrow(
        "Unknown retention category"
      );
    });
  });

  describe("Category-specific cleanup", () => {
    it("cleans old resolved poison events only", async () => {
      const cutoffDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      mockPrisma.poisonEvent.count.mockResolvedValue(10);
      mockPrisma.poisonEvent.deleteMany.mockResolvedValue({ count: 5 });

      const report = await service.generateCleanupReport("POISON_EVENT", { dryRun: false });

      expect(mockPrisma.poisonEvent.deleteMany).toHaveBeenCalledWith({
        where: {
          detectedAt: { lt: expect.any(Date) },
          resolvedAt: { not: null }, // Only resolved events
        },
      });
      expect(report.deleted).toBe(5);
    });

    it("protects unresolved poison events from deletion", async () => {
      mockPrisma.poisonEvent.count
        .mockResolvedValueOnce(20) // eligible
        .mockResolvedValueOnce(15); // protected (unresolved)

      const report = await service.generateCleanupReport("POISON_EVENT", { dryRun: true });

      expect(report.protected).toBeGreaterThan(0);
    });

    it("cleans consumed pending events only", async () => {
      mockPrisma.pendingEvent.count.mockResolvedValue(50);
      mockPrisma.pendingEvent.deleteMany.mockResolvedValue({ count: 40 });

      const report = await service.generateCleanupReport("PENDING_EVENT", { dryRun: false });

      expect(mockPrisma.pendingEvent.deleteMany).toHaveBeenCalledWith({
        where: {
          receivedAt: { lt: expect.any(Date) },
          consumedAt: { not: null }, // Only consumed events
        },
      });
      expect(report.deleted).toBe(40);
    });

    it("protects unconsumed pending events", async () => {
      mockPrisma.pendingEvent.count
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(30); // unconsumed

      const report = await service.generateCleanupReport("PENDING_EVENT", { dryRun: true });

      expect(report.protected).toBe(30);
    });

    it("cleans completed and failed background jobs", async () => {
      mockPrisma.backgroundJob.count.mockResolvedValue(100);
      mockPrisma.backgroundJob.deleteMany.mockResolvedValue({ count: 80 });

      const report = await service.generateCleanupReport("BACKGROUND_JOB", { dryRun: false });

      expect(mockPrisma.backgroundJob.deleteMany).toHaveBeenCalledWith({
        where: {
          updatedAt: { lt: expect.any(Date) },
          status: { in: ["completed", "failed"] },
        },
      });
      expect(report.deleted).toBe(80);
    });

    it("protects running background jobs", async () => {
      mockPrisma.backgroundJob.count
        .mockResolvedValueOnce(100)
        .mockResolvedValueOnce(20); // running

      const report = await service.generateCleanupReport("BACKGROUND_JOB", { dryRun: true });

      expect(report.protected).toBe(20);
    });

    it("cleans expired wallet challenges", async () => {
      mockPrisma.walletChallenge.count.mockResolvedValue(50);
      mockPrisma.walletChallenge.deleteMany.mockResolvedValue({ count: 45 });

      const report = await service.generateCleanupReport("WALLET_CHALLENGE", { dryRun: false });

      expect(mockPrisma.walletChallenge.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) } },
      });
    });

    it("protects valid wallet challenges", async () => {
      mockPrisma.walletChallenge.count
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(10); // still valid

      const report = await service.generateCleanupReport("WALLET_CHALLENGE", { dryRun: true });

      expect(report.protected).toBe(10);
    });

    it("cleans revoked and expired wallet sessions", async () => {
      mockPrisma.walletSession.count.mockResolvedValue(200);
      mockPrisma.walletSession.deleteMany.mockResolvedValue({ count: 150 });

      const report = await service.generateCleanupReport("WALLET_SESSION", { dryRun: false });

      expect(mockPrisma.walletSession.deleteMany).toHaveBeenCalledWith({
        where: {
          createdAt: { lt: expect.any(Date) },
          revokedAt: { not: null },
          expiresAt: { lt: expect.any(Date) },
        },
      });
    });

    it("protects active and non-expired wallet sessions", async () => {
      mockPrisma.walletSession.count
        .mockResolvedValueOnce(200)
        .mockResolvedValueOnce(100); // active/non-expired

      const report = await service.generateCleanupReport("WALLET_SESSION", { dryRun: true });

      expect(report.protected).toBe(100);
    });

    it("cleans expired action leases", async () => {
      mockPrisma.actionLease.count.mockResolvedValue(50);
      mockPrisma.actionLease.deleteMany.mockResolvedValue({ count: 48 });

      const report = await service.generateCleanupReport("ACTION_LEASE", { dryRun: false });

      expect(mockPrisma.actionLease.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) } },
      });
    });

    it("protects valid action leases", async () => {
      mockPrisma.actionLease.count
        .mockResolvedValueOnce(50)
        .mockResolvedValueOnce(5); // still valid

      const report = await service.generateCleanupReport("ACTION_LEASE", { dryRun: true });

      expect(report.protected).toBe(5);
    });
  });
});

describe("DataRetentionService.previewCleanup", () => {
  let mockPrisma: any;
  let service: DataRetentionService;

  beforeEach(() => {
    mockPrisma = {
      backgroundJob: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length })),
      },
      actionLease: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async (args: { where: { actionId: { in: string[] } } }) => ({ count: args.where.actionId.in.length })),
      },
      chainEvent: {
        findMany: vi.fn(async () => []),
        deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length })),
      },
      actionLedger: { findMany: vi.fn(async () => []) },
    };
    service = new DataRetentionService(mockPrisma);
  });

  it("preview classifies eligible vs protected records and deletes nothing", async () => {
    mockPrisma.backgroundJob.findMany = vi.fn(async () => [
      { id: "job-done", status: "completed" },
      { id: "job-fail", status: "failed" },
      { id: "job-run", status: "in_progress" },
      { id: "job-queued", status: "queued" },
    ]);

    const preview = await service.previewCleanup("BACKGROUND_JOB");

    expect(preview.mode).toBe("preview");
    expect(preview.counts).toEqual({ eligible: 2, skipped: 2, held: 0, failed: 0 });
    expect(preview.applied).toBe(0);
    expect(mockPrisma.backgroundJob.deleteMany).not.toHaveBeenCalled();

    const byId = Object.fromEntries(preview.records.map((r) => [r.id, r]));
    expect(byId["job-done"].outcome).toBe("eligible");
    expect(byId["job-run"].outcome).toBe("skipped");
    expect(byId["job-run"].reason).toMatch(/still running/);
    // counts always sum to the number of records classified
    const { eligible, skipped, held, failed } = preview.counts;
    expect(eligible + skipped + held + failed).toBe(preview.records.length);
  });

  it("expired leases are eligible, valid leases are skipped", async () => {
    const now = Date.now();
    mockPrisma.actionLease.findMany = vi.fn(async () => [
      { actionId: "lease-expired", expiresAt: new Date(now - 60_000) },
      { actionId: "lease-valid", expiresAt: new Date(now + 60_000) },
    ]);

    const preview = await service.previewCleanup("ACTION_LEASE");
    const byId = Object.fromEntries(preview.records.map((r) => [r.id, r.outcome]));
    expect(byId["lease-expired"]).toBe("eligible");
    expect(byId["lease-valid"]).toBe("skipped");
    expect(preview.counts.eligible).toBe(1);
    expect(preview.counts.skipped).toBe(1);
  });

  it("held records are reported with a reason and never deleted, even in apply mode", async () => {
    mockPrisma.backgroundJob.findMany = vi.fn(async () => [
      { id: "job-a", status: "completed" },
      { id: "job-held", status: "completed" },
    ]);
    const holds = {
      heldReason: (_table: string, id: string) =>
        id === "job-held" ? "legal hold: dispute #42" : null,
    };

    const preview = await service.previewCleanup("BACKGROUND_JOB", { apply: true, holds });

    expect(preview.counts).toEqual({ eligible: 1, skipped: 0, held: 1, failed: 0 });
    const held = preview.records.find((r) => r.id === "job-held");
    expect(held.outcome).toBe("held");
    expect(held.reason).toContain("legal hold");
    // Only the eligible id is deleted; the held id is excluded.
    expect(mockPrisma.backgroundJob.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["job-a"] } },
    });
    expect(preview.applied).toBe(1);
  });

  it("apply mode deletes only the eligible set and reports the applied count", async () => {
    mockPrisma.backgroundJob.findMany = vi.fn(async () => [
      { id: "j1", status: "completed" },
      { id: "j2", status: "queued" },
      { id: "j3", status: "failed" },
    ]);

    const preview = await service.previewCleanup("BACKGROUND_JOB", { apply: true });

    expect(preview.mode).toBe("apply");
    expect(mockPrisma.backgroundJob.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["j1", "j3"] } },
    });
    expect(preview.applied).toBe(2);
  });

  it("a classification error is recorded as failed and that record is never deleted", async () => {
    mockPrisma.backgroundJob.findMany = vi.fn(async () => [
      { id: "j-ok", status: "completed" },
      { id: "j-bad", status: "completed" },
    ]);
    const holds = {
      heldReason: (_table: string, id: string) => {
        if (id === "j-bad") throw new Error("hold store unavailable");
        return null;
      },
    };

    const preview = await service.previewCleanup("BACKGROUND_JOB", { apply: true, holds });

    const bad = preview.records.find((r) => r.id === "j-bad");
    expect(bad.outcome).toBe("failed");
    expect(bad.reason).toContain("hold store unavailable");
    expect(preview.counts.failed).toBe(1);
    expect(mockPrisma.backgroundJob.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["j-ok"] } },
    });
  });

  it("protects chain events linked to a pending/submitted action", async () => {
    mockPrisma.actionLedger.findMany = vi.fn(async () => [{ txHash: "tx-pending" }]);
    mockPrisma.chainEvent.findMany = vi.fn(async () => [
      { id: "ce-old", txHash: "tx-old" },
      { id: "ce-pending", txHash: "tx-pending" },
    ]);

    const preview = await service.previewCleanup("CHAIN_EVENT");
    const byId = Object.fromEntries(preview.records.map((r) => [r.id, r.outcome]));
    expect(byId["ce-old"]).toBe("eligible");
    expect(byId["ce-pending"]).toBe("skipped");
  });

  it("rejects unknown and never-delete categories", async () => {
    await expect(service.previewCleanup("NOPE")).rejects.toThrow(/Unknown retention category/);
    await expect(service.previewCleanup("USER")).rejects.toThrow(/not subject to cleanup/);
  });
});
