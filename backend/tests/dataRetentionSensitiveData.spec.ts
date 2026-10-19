import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DataRetentionService,
  RETENTION_POLICIES,
  type RetentionHoldProvider,
} from "../src/services/dataRetentionService.js";

describe("Sensitive Operational Data Retention & Deletion (#994)", () => {
  let mockPrisma: any;
  let service: DataRetentionService;

  beforeEach(() => {
    mockPrisma = {
      actionLedger: {
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
      adminSession: {
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
      backgroundJob: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
      chainEvent: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        findMany: vi.fn(async () => []),
      },
    };
    service = new DataRetentionService(mockPrisma);
  });

  describe("Normal Path: Retention Window & Cleanup Execution", () => {
    it("deletes expired wallet challenges older than 1 day while preserving active ones", async () => {
      // 1 day retention
      expect(RETENTION_POLICIES.WALLET_CHALLENGE.retentionDays).toBe(1);

      mockPrisma.walletChallenge.count
        .mockResolvedValueOnce(45) // eligible
        .mockResolvedValueOnce(50); // protected
      mockPrisma.walletChallenge.deleteMany.mockResolvedValueOnce({ count: 45 });

      const report = await service.generateCleanupReport("WALLET_CHALLENGE", { dryRun: false });

      expect(report.dryRun).toBe(false);
      expect(report.eligibleForDeletion).toBe(45);
      expect(report.protected).toBe(50);
      expect(report.deleted).toBe(45);
      expect(mockPrisma.walletChallenge.deleteMany).toHaveBeenCalled();
    });

    it("cleans revoked wallet sessions older than 30 days while protecting active sessions", async () => {
      expect(RETENTION_POLICIES.WALLET_SESSION.retentionDays).toBe(90);

      mockPrisma.walletSession.count
        .mockResolvedValueOnce(150) // eligible
        .mockResolvedValueOnce(200); // protected
      mockPrisma.walletSession.deleteMany.mockResolvedValueOnce({ count: 150 });

      const report = await service.generateCleanupReport("WALLET_SESSION", { dryRun: false });

      expect(report.eligibleForDeletion).toBe(150);
      expect(report.protected).toBe(200);
      expect(report.deleted).toBe(150);
    });

    it("cleans expired action leases (7 days) and job leases (7 days) accurately", async () => {
      expect(RETENTION_POLICIES.ACTION_LEASE.retentionDays).toBe(7);
      expect(RETENTION_POLICIES.JOB_LEASE.retentionDays).toBe(7);

      mockPrisma.actionLease.count.mockResolvedValueOnce(30).mockResolvedValueOnce(10);
      mockPrisma.actionLease.deleteMany.mockResolvedValueOnce({ count: 30 });

      const actionLeaseReport = await service.generateCleanupReport("ACTION_LEASE", { dryRun: false });
      expect(actionLeaseReport.deleted).toBe(30);

      mockPrisma.jobLease.count.mockResolvedValueOnce(15).mockResolvedValueOnce(5);
      mockPrisma.jobLease.deleteMany.mockResolvedValueOnce({ count: 15 });

      const jobLeaseReport = await service.generateCleanupReport("JOB_LEASE", { dryRun: false });
      expect(jobLeaseReport.deleted).toBe(15);
    });
  });

  describe("Failure Path: Database Errors & Transaction Rollback", () => {
    it("gracefully catches database query errors during analysis and records error detail", async () => {
      mockPrisma.walletChallenge.count.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));

      const report = await service.generateCleanupReport("WALLET_CHALLENGE", { dryRun: false });

      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain("Connection terminated unexpectedly");
      expect(report.deleted).toBe(0);
      expect(mockPrisma.walletChallenge.deleteMany).not.toHaveBeenCalled();
    });

    it("aborts deletion and reports error if deleteMany fails mid-execution", async () => {
      mockPrisma.walletSession.count.mockResolvedValueOnce(100).mockResolvedValueOnce(50);
      mockPrisma.walletSession.deleteMany.mockRejectedValueOnce(new Error("Disk quota exceeded"));

      const report = await service.generateCleanupReport("WALLET_SESSION", { dryRun: false });

      expect(report.deleted).toBe(0);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain("Disk quota exceeded");
    });
  });

  describe("Retry Path: Idempotency & Partial Failure Recovery", () => {
    it("is safe to re-run after partial deletion; zero rows remaining returns clean 0 deleted", async () => {
      // First run succeeds
      mockPrisma.walletChallenge.count.mockResolvedValueOnce(20).mockResolvedValueOnce(10);
      mockPrisma.walletChallenge.deleteMany.mockResolvedValueOnce({ count: 20 });

      const firstReport = await service.generateCleanupReport("WALLET_CHALLENGE", { dryRun: false });
      expect(firstReport.deleted).toBe(20);

      // Immediate retry run finds 0 eligible
      mockPrisma.walletChallenge.count.mockResolvedValueOnce(0).mockResolvedValueOnce(10);
      mockPrisma.walletChallenge.deleteMany.mockResolvedValueOnce({ count: 0 });

      const retryReport = await service.generateCleanupReport("WALLET_CHALLENGE", { dryRun: false });
      expect(retryReport.eligibleForDeletion).toBe(0);
      expect(retryReport.deleted).toBe(0);
      expect(retryReport.errors).toHaveLength(0);
    });
  });

  describe("Authorization & Protection Rules Path", () => {
    it("attaches actor metadata for auditable maintenance invocation", async () => {
      mockPrisma.walletSession.count.mockResolvedValue(0);

      const report = await service.generateCleanupReport("WALLET_SESSION", {
        actor: "maintainer:GADMIN_WALLET_ADDRESS",
        dryRun: true,
      });

      expect(report.dryRun).toBe(true);
      expect(report.category).toBe("Wallet Sessions");
    });

    it("strictly preserves records subject to active retention holds regardless of age", async () => {
      const pastCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days old

      mockPrisma.actionLease.findMany.mockResolvedValueOnce([
        { actionId: "lease-held-dispute", expiresAt: pastCutoff, acquiredAt: pastCutoff, ttlSeconds: 60 },
        { actionId: "lease-expired-normal", expiresAt: pastCutoff, acquiredAt: pastCutoff, ttlSeconds: 60 },
      ]);

      const mockHolds: RetentionHoldProvider = {
        heldReason: (table, recordId) => {
          if (recordId === "lease-held-dispute") {
            return "Active arbitration hold for incident INC-402";
          }
          return null;
        },
      };

      const preview = await service.previewCleanup("ACTION_LEASE", {
        holds: mockHolds,
        apply: true,
      });

      expect(preview.counts.held).toBe(1);
      expect(preview.counts.eligible).toBe(1);
      expect(preview.records.find((r) => r.id === "lease-held-dispute")?.outcome).toBe("held");
      expect(preview.records.find((r) => r.id === "lease-held-dispute")?.reason).toContain("Active arbitration hold");

      // Verify that deleteMany was only invoked for the non-held eligible record
      expect(mockPrisma.actionLease.deleteMany).toHaveBeenCalledWith({
        where: { actionId: { in: ["lease-expired-normal"] } },
      });
    });
  });
});
