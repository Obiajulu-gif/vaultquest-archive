import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackfillService, type RawBackfillEvent } from "../src/services/backfillService.js";
import { parseArgs } from "../src/scripts/backfill.js";

describe("BackfillTool (Issue #920)", () => {
  let actionLedgerRows: Map<string, any>;
  let checkpointRow: any | null;
  let prismaMock: any;

  beforeEach(() => {
    actionLedgerRows = new Map();
    checkpointRow = {
      id: "singleton",
      latestLedger: 1000,
      lastProcessedEventId: "ev-0",
      lastSyncTime: new Date("2026-10-15T10:00:00Z"),
      lastSuccessSyncTime: new Date("2026-10-15T10:00:00Z"),
      lastError: null
    };

    prismaMock = {
      indexerCheckpoint: {
        findUnique: vi.fn(async ({ where }: any) => {
          if (where.id === checkpointRow?.id) return checkpointRow;
          return null;
        }),
        upsert: vi.fn(async ({ create, update }: any) => {
          const merged = { ...checkpointRow, ...(create || update) };
          checkpointRow = merged;
          return merged;
        })
      },
      actionLedger: {
        findUnique: vi.fn(async ({ where }: any) => {
          return actionLedgerRows.get(where.txHash) || null;
        }),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const existing = actionLedgerRows.get(where.txHash);
          const record = existing ? { ...existing, ...update } : { ...create };
          actionLedgerRows.set(where.txHash, record);
          return record;
        }),
        aggregate: vi.fn(async () => {
          let maxLedger = 0;
          for (const row of actionLedgerRows.values()) {
            if (row.observedLedger > maxLedger) maxLedger = row.observedLedger;
          }
          return { _max: { observedLedger: maxLedger || 1000 } };
        })
      }
    };
  });

  describe("CLI Argument Parsing", () => {
    it("parses CLI arguments correctly", () => {
      const args = [
        "--from", "1000",
        "--to", "1050",
        "--dry-run",
        "--limit", "50",
        "--batch-size", "25",
        "--reset-checkpoint", "990",
        "--force",
        "--json"
      ];
      const opts = parseArgs(args);
      expect(opts.fromLedger).toBe(1000);
      expect(opts.toLedger).toBe(1050);
      expect(opts.dryRun).toBe(true);
      expect(opts.limit).toBe(50);
      expect(opts.batchSize).toBe(25);
      expect(opts.resetCheckpoint).toBe(990);
      expect(opts.force).toBe(true);
      expect(opts.json).toBe(true);
    });
  });

  describe("Dry-Run Diff Preview", () => {
    it("generates creates, updates, and skips without mutating database in dry-run mode", async () => {
      // Pre-seed an existing confirmed row
      actionLedgerRows.set("tx-existing-1", {
        txHash: "tx-existing-1",
        walletAddress: "GUSER1",
        actionType: "deposit",
        status: "confirmed",
        observedLedger: 1001,
        actionPayload: { amount: "100" }
      });

      // Pre-seed an unconfirmed row needing update
      actionLedgerRows.set("tx-pending-2", {
        txHash: "tx-pending-2",
        walletAddress: "GUSER2",
        actionType: "deposit",
        status: "pending",
        observedLedger: null,
        actionPayload: { amount: "200" }
      });

      const events: RawBackfillEvent[] = [
        {
          id: "ev-1",
          ledger: 1001,
          txHash: "tx-existing-1",
          eventType: "deposit",
          payload: { amount: "100" }
        },
        {
          id: "ev-2",
          ledger: 1002,
          txHash: "tx-pending-2",
          eventType: "deposit",
          payload: { amount: "200" }
        },
        {
          id: "ev-3",
          ledger: 1003,
          txHash: "tx-new-3",
          eventType: "claim",
          payload: { who: "GUSER3", amount: "50" }
        }
      ];

      const service = new BackfillService(prismaMock);
      const report = await service.runBackfill(events, { dryRun: true });

      expect(report.dryRun).toBe(true);
      expect(report.totalScanned).toBe(3);
      expect(report.skippedCount).toBe(1);
      expect(report.appliedCount).toBe(2);
      expect(report.failedCount).toBe(0);

      // Verify diff contents
      const skipDiff = report.diffs.find((d) => d.txHash === "tx-existing-1");
      expect(skipDiff?.action).toBe("skip");
      expect(skipDiff?.reason).toBe("RECORD_ALREADY_CONFIRMED");

      const updateDiff = report.diffs.find((d) => d.txHash === "tx-pending-2");
      expect(updateDiff?.action).toBe("update");
      expect(updateDiff?.before?.status).toBe("pending");
      expect(updateDiff?.after?.status).toBe("confirmed");

      const createDiff = report.diffs.find((d) => d.txHash === "tx-new-3");
      expect(createDiff?.action).toBe("create");
      expect(createDiff?.before).toBeNull();
      expect(createDiff?.after?.actionType).toBe("claim");

      // Verify DB was NOT mutated
      expect(actionLedgerRows.has("tx-new-3")).toBe(false);
      expect(actionLedgerRows.get("tx-pending-2").status).toBe("pending");
      // Checkpoint was NOT mutated in dry-run
      expect(checkpointRow.latestLedger).toBe(1000);

      // Test formatDiffReport
      const formatted = BackfillService.formatDiffReport(report);
      expect(formatted).toContain("[DRY RUN PREVIEW - NO CHANGES APPLIED]");
      expect(formatted).toContain("+ [CREATE]");
      expect(formatted).toContain("~ [UPDATE]");
      expect(formatted).toContain("= [SKIP]");
    });
  });

  describe("Live Execution & Resumable Checkpoint", () => {
    it("applies changes and advances checkpoint monotonically in live mode", async () => {
      const events: RawBackfillEvent[] = [
        {
          id: "ev-10",
          ledger: 1005,
          txHash: "tx-live-1",
          eventType: "deposit",
          payload: { who: "GUSER10", amount: "500" }
        },
        {
          id: "ev-11",
          ledger: 1010,
          txHash: "tx-live-2",
          eventType: "vault_settlement",
          payload: { who: "GUSER11", amount: "1000" }
        }
      ];

      const service = new BackfillService(prismaMock);
      const report = await service.runBackfill(events, { dryRun: false });

      expect(report.dryRun).toBe(false);
      expect(report.appliedCount).toBe(2);
      expect(report.newCheckpoint).toBe(1010);

      // Verify records were applied
      expect(actionLedgerRows.has("tx-live-1")).toBe(true);
      expect(actionLedgerRows.has("tx-live-2")).toBe(true);
      expect(checkpointRow.latestLedger).toBe(1010);
    });

    it("resumes safely from the previous checkpoint", async () => {
      checkpointRow.latestLedger = 1500;
      const service = new BackfillService(prismaMock);

      const report = await service.runBackfill([], { dryRun: true });
      expect(report.previousCheckpoint).toBe(1500);
      expect(report.startLedger).toBe(1501);
    });
  });

  describe("Status & Verification", () => {
    it("computes gap to chain tip correctly", async () => {
      checkpointRow.latestLedger = 1000;
      const eventSource = {
        fetchEvents: vi.fn(async () => []),
        getLatestLedger: vi.fn(async () => 1720) // 720 ledgers ahead = ~1 hour
      };

      const service = new BackfillService(prismaMock, eventSource);
      const status = await service.getStatus();

      expect(status.checkpointLedger).toBe(1000);
      expect(status.latestLedger).toBe(1720);
      expect(status.gap).toBe(720);
      expect(status.estimatedHours).toBe(1);
    });

    it("verifies consistency between checkpoint and action ledger", async () => {
      checkpointRow.latestLedger = 2000;
      actionLedgerRows.set("tx-1", { txHash: "tx-1", observedLedger: 500 });

      const service = new BackfillService(prismaMock);
      const res = await service.verifyConsistency();

      expect(res.consistent).toBe(false);
      expect(res.warning).toContain("Inconsistency detected");
    });
  });
});
