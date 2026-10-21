import { describe, it, expect, beforeEach, vi } from "vitest";
import { OperationalHealthService } from "../src/services/operationalHealthService.js";

describe("OperationalHealthService", () => {
  let mockPrisma: any;
  let service: OperationalHealthService;

  beforeEach(() => {
    mockPrisma = {
      actionLedger: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      pendingEvent: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      backgroundJob: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      actionLease: { count: vi.fn(async () => 0) },
      vaultSettlement: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      repairQuarantine: { count: vi.fn(async () => 0) },
      repairProposal: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
      indexerCheckpoint: { findFirst: vi.fn(async () => null) },
      poisonEvent: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    };
    service = new OperationalHealthService(mockPrisma);
  });

  describe("generateHealthReport", () => {
    it("returns healthy status when all indicators are zero", async () => {
      const report = await service.generateHealthReport();

      expect(report.overallStatus).toBe("healthy");
      expect(report.summary.totalIssues).toBe(0);
      expect(report.summary.criticalCount).toBe(0);
      expect(report.summary.warningCount).toBe(0);
      expect(report.indicators).toHaveLength(0);
    });

    it("detects orphaned actions as warning", async () => {
      mockPrisma.actionLedger.count.mockResolvedValue(5);

      const report = await service.generateHealthReport();

      const orphanedIndicator = report.indicators.find((i) => i.category === "Orphaned Actions");
      expect(orphanedIndicator).toBeDefined();
      expect(orphanedIndicator?.count).toBe(5);
      expect(orphanedIndicator?.status).toBe("warning");
      expect(report.overallStatus).toBe("warning");
    });

    it("escalates orphaned actions to critical when > 10", async () => {
      mockPrisma.actionLedger.count.mockResolvedValue(15);

      const report = await service.generateHealthReport();

      const orphanedIndicator = report.indicators.find((i) => i.category === "Orphaned Actions");
      expect(orphanedIndicator?.status).toBe("critical");
      expect(report.overallStatus).toBe("critical");
      expect(report.summary.criticalCount).toBe(1);
    });

    it("detects stale pending events", async () => {
      mockPrisma.pendingEvent.count.mockResolvedValue(25);

      const report = await service.generateHealthReport();

      const staleIndicator = report.indicators.find((i) => i.category === "Stale Pending Events");
      expect(staleIndicator).toBeDefined();
      expect(staleIndicator?.count).toBe(25);
      expect(staleIndicator?.status).toBe("warning");
    });

    it("escalates stale pending events to critical when > 50", async () => {
      mockPrisma.pendingEvent.count.mockResolvedValue(75);

      const report = await service.generateHealthReport();

      const staleIndicator = report.indicators.find((i) => i.category === "Stale Pending Events");
      expect(staleIndicator?.status).toBe("critical");
      expect(report.summary.criticalCount).toBe(1);
    });

    it("detects failed background jobs", async () => {
      mockPrisma.backgroundJob.count.mockResolvedValue(3);

      const report = await service.generateHealthReport();

      const failedIndicator = report.indicators.find((i) => i.category === "Failed Background Jobs");
      expect(failedIndicator).toBeDefined();
      expect(failedIndicator?.count).toBe(3);
      expect(failedIndicator?.status).toBe("warning");
    });

    it("escalates failed jobs to critical when > 5", async () => {
      mockPrisma.backgroundJob.count.mockResolvedValue(8);

      const report = await service.generateHealthReport();

      const failedIndicator = report.indicators.find((i) => i.category === "Failed Background Jobs");
      expect(failedIndicator?.status).toBe("critical");
    });

    it("detects stale action leases (worker hangs)", async () => {
      mockPrisma.actionLease.count.mockResolvedValue(2);

      const report = await service.generateHealthReport();

      const leaseIndicator = report.indicators.find((i) => i.category === "Stale Action Leases");
      expect(leaseIndicator).toBeDefined();
      expect(leaseIndicator?.count).toBe(2);
      expect(leaseIndicator?.status).toBe("warning");
    });

    it("escalates stale leases to critical when > 3", async () => {
      mockPrisma.actionLease.count.mockResolvedValue(5);

      const report = await service.generateHealthReport();

      const leaseIndicator = report.indicators.find((i) => i.category === "Stale Action Leases");
      expect(leaseIndicator?.status).toBe("critical");
    });

    it("detects unresolved vault settlements", async () => {
      mockPrisma.vaultSettlement.count.mockResolvedValue(10);

      const report = await service.generateHealthReport();

      const settlementIndicator = report.indicators.find(
        (i) => i.category === "Unresolved Vault Settlements"
      );
      expect(settlementIndicator).toBeDefined();
      expect(settlementIndicator?.count).toBe(10);
      expect(settlementIndicator?.status).toBe("warning");
    });

    it("escalates unresolved settlements to critical when > 20", async () => {
      mockPrisma.vaultSettlement.count.mockResolvedValue(30);

      const report = await service.generateHealthReport();

      const settlementIndicator = report.indicators.find(
        (i) => i.category === "Unresolved Vault Settlements"
      );
      expect(settlementIndicator?.status).toBe("critical");
    });

    it("detects reconciliation drift", async () => {
      mockPrisma.repairQuarantine.count.mockResolvedValue(3);

      const report = await service.generateHealthReport();

      const driftIndicator = report.indicators.find(
        (i) => i.category === "Detected Reconciliation Drift"
      );
      expect(driftIndicator).toBeDefined();
      expect(driftIndicator?.count).toBe(3);
      expect(driftIndicator?.status).toBe("warning");
    });

    it("escalates drift to critical when > 5", async () => {
      mockPrisma.repairQuarantine.count.mockResolvedValue(8);

      const report = await service.generateHealthReport();

      const driftIndicator = report.indicators.find(
        (i) => i.category === "Detected Reconciliation Drift"
      );
      expect(driftIndicator?.status).toBe("critical");
    });

    it("detects pending repair proposals", async () => {
      mockPrisma.repairProposal.count.mockResolvedValue(2);

      const report = await service.generateHealthReport();

      const repairIndicator = report.indicators.find((i) => i.category === "Pending Repair Proposals");
      expect(repairIndicator).toBeDefined();
      expect(repairIndicator?.count).toBe(2);
      expect(repairIndicator?.status).toBe("warning");
    });

    it("detects poison events (malformed contract events)", async () => {
      mockPrisma.poisonEvent.count.mockResolvedValue(5);

      const report = await service.generateHealthReport();

      const poisonIndicator = report.indicators.find((i) => i.category === "Poison Events");
      expect(poisonIndicator).toBeDefined();
      expect(poisonIndicator?.count).toBe(5);
      expect(poisonIndicator?.status).toBe("warning");
    });

    it("escalates poison events to critical when > 10", async () => {
      mockPrisma.poisonEvent.count.mockResolvedValue(15);

      const report = await service.generateHealthReport();

      const poisonIndicator = report.indicators.find((i) => i.category === "Poison Events");
      expect(poisonIndicator?.status).toBe("critical");
    });

    it("includes investigation links for each indicator", async () => {
      mockPrisma.actionLedger.count.mockResolvedValue(3);

      const report = await service.generateHealthReport();

      const orphanedIndicator = report.indicators.find((i) => i.category === "Orphaned Actions");
      expect(orphanedIndicator?.investigationLink).toBeDefined();
      expect(orphanedIndicator?.investigationLink).toContain("action_ledger");
      expect(orphanedIndicator?.investigationLink).toContain("orphaned");
    });

    it("includes actionable guidance for each indicator", async () => {
      mockPrisma.actionLedger.count.mockResolvedValue(2);

      const report = await service.generateHealthReport();

      const indicator = report.indicators[0];
      expect(indicator.actionable).toBeDefined();
      expect(indicator.actionable.length).toBeGreaterThan(0);
    });

    it("aggregates multiple indicators correctly", async () => {
      mockPrisma.actionLedger.count.mockResolvedValue(5);
      mockPrisma.pendingEvent.count.mockResolvedValue(3);
      mockPrisma.backgroundJob.count.mockResolvedValue(1);

      const report = await service.generateHealthReport();

      expect(report.indicators.length).toBe(3);
      expect(report.summary.totalIssues).toBe(3);
      expect(report.summary.warningCount).toBe(3);
      expect(report.summary.criticalCount).toBe(0);
    });

    it("reports critical when any indicator is critical", async () => {
      mockPrisma.actionLedger.count.mockResolvedValue(15); // > 10, critical
      mockPrisma.pendingEvent.count.mockResolvedValue(3); // warning

      const report = await service.generateHealthReport();

      expect(report.overallStatus).toBe("critical");
      expect(report.summary.criticalCount).toBe(1);
      expect(report.summary.warningCount).toBe(1);
    });

    it("includes timestamp in report", async () => {
      const report = await service.generateHealthReport();

      expect(report.timestamp).toBeDefined();
      expect(report.timestamp instanceof Date).toBe(true);
    });
  });

  describe("getHealthCategoryDetails", () => {
    it("returns orphaned actions with details", async () => {
      const orphanedActions = [
        {
          id: "action-1",
          walletAddress: "GBD3...",
          actionType: "deposit",
          txHash: "tx-123",
          errorCode: "TIMEOUT",
          updatedAt: new Date(),
        },
      ];

      mockPrisma.actionLedger.findMany.mockResolvedValue(orphanedActions);
      mockPrisma.actionLedger.count.mockResolvedValue(1);

      const details = await service.getHealthCategoryDetails("Orphaned Actions");

      expect(details.total).toBe(1);
      expect(details.items).toHaveLength(1);
      expect(details.items[0].id).toBe("action-1");
      expect(details.items[0].errorCode).toBe("TIMEOUT");
    });

    it("returns failed background jobs with details", async () => {
      const failedJobs = [
        {
          id: "job-1",
          type: "draw_proof_generate",
          attempts: 3,
          updatedAt: new Date(),
        },
      ];

      mockPrisma.backgroundJob.findMany.mockResolvedValue(failedJobs);
      mockPrisma.backgroundJob.count.mockResolvedValue(1);

      const details = await service.getHealthCategoryDetails("Failed Background Jobs");

      expect(details.total).toBe(1);
      expect(details.items).toHaveLength(1);
      expect(details.items[0].type).toBe("draw_proof_generate");
      expect(details.items[0].attempts).toBe(3);
    });

    it("returns pending repair proposals with details", async () => {
      const pendingRepairs = [
        {
          id: "repair-1",
          proposerId: "operator-123",
          stepCount: 3,
          valueTotal: 1000.5,
          createdAt: new Date(),
        },
      ];

      mockPrisma.repairProposal.findMany.mockResolvedValue(pendingRepairs);
      mockPrisma.repairProposal.count.mockResolvedValue(1);

      const details = await service.getHealthCategoryDetails("Pending Repair Proposals");

      expect(details.total).toBe(1);
      expect(details.items[0].stepCount).toBe(3);
      expect(details.items[0].valueTotal).toBe(1000.5);
    });

    it("returns up to 50 items per category", async () => {
      const manyItems = Array.from({ length: 60 }, (_, i) => ({
        id: `action-${i}`,
        walletAddress: "GBD3...",
        actionType: "deposit",
        txHash: `tx-${i}`,
        errorCode: "TIMEOUT",
        updatedAt: new Date(),
      }));

      mockPrisma.actionLedger.findMany.mockResolvedValue(manyItems);
      mockPrisma.actionLedger.count.mockResolvedValue(60);

      const details = await service.getHealthCategoryDetails("Orphaned Actions");

      expect(details.total).toBe(60);
      expect(details.items.length).toBe(50);
    });

    it("redacts sensitive details in items", async () => {
      const orphanedActions = [
        {
          id: "action-1",
          walletAddress: "GBD3...",
          actionType: "deposit",
          txHash: "tx-123",
          errorCode: "TIMEOUT",
          updatedAt: new Date(),
          secret: "secret-value",
        },
      ];

      mockPrisma.actionLedger.findMany.mockResolvedValue(orphanedActions);
      mockPrisma.actionLedger.count.mockResolvedValue(1);

      const details = await service.getHealthCategoryDetails("Orphaned Actions");

      expect(details.items[0]).not.toHaveProperty("secret");
    });
  });
});
