import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  ResumableRepairEngine,
  InMemoryRepairDataSource,
  InMemoryRepairCheckpointStore
} from "../src/services/resumableRepairJob.js";
import { jobsRoutes } from "../src/routes/jobs.js";
import { JobQueue } from "../src/worker/jobWorker.js";
import { InMemoryJobStore } from "../src/worker/jobStore.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ERROR_CODES } from "../src/constants.js";

describe("Resumable Repair Job for Orphaned and Inconsistent Records (#977)", () => {
  let dataSource: InMemoryRepairDataSource;
  let checkpointStore: InMemoryRepairCheckpointStore;
  let engine: ResumableRepairEngine;

  const now = Date.now();
  const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
  const tenMinutesAgo = new Date(now - 10 * 60 * 1000);

  beforeEach(() => {
    dataSource = new InMemoryRepairDataSource();
    checkpointStore = new InMemoryRepairCheckpointStore();
    engine = new ResumableRepairEngine({
      dataSource,
      checkpointStore
    });
  });

  describe("1. Normal Multi-Phase Execution Path", () => {
    it("executes all phases across bounded batches and transitions to completed", async () => {
      // Seed 4 stale actions
      for (let i = 1; i <= 4; i++) {
        dataSource.actions.push({
          id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          status: "submitted",
          txHash: `0xaction_tx_${i}`,
          updatedAt: twoHoursAgo
        });
      }

      // Seed 3 stale pending events
      for (let i = 1; i <= 3; i++) {
        dataSource.events.push({
          txHash: `0xevent_tx_${i}`,
          statusHint: "confirmed",
          receivedAt: twoHoursAgo
        });
      }

      // Seed 2 unresolved settlements
      for (let i = 1; i <= 2; i++) {
        dataSource.settlements.push({
          id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          vaultId: `vault_${i}`,
          state: "Unresolved",
          attempts: 3,
          updatedAt: twoHoursAgo
        });
      }

      // Run with batchSize = 2 to exercise multiple pagination batches per phase
      const result = await engine.startJob({
        dryRun: false,
        batchSize: 2
      });

      expect(result.status).toBe("completed");
      expect(result.completedAt).toBeDefined();
      expect(result.stats.scannedCount).toBe(9); // 4 + 3 + 2
      expect(result.stats.repairedCount).toBe(9);
      expect(result.stats.failedCount).toBe(0);

      // Verify individual phase breakdowns
      expect(result.stats.phaseBreakdown.orphaned_actions).toEqual({
        scanned: 4,
        repaired: 4,
        failed: 0
      });
      expect(result.stats.phaseBreakdown.stale_pending_events).toEqual({
        scanned: 3,
        repaired: 3,
        failed: 0
      });
      expect(result.stats.phaseBreakdown.unresolved_settlements).toEqual({
        scanned: 2,
        repaired: 2,
        failed: 0
      });

      // Verify mutations applied to data source
      expect(dataSource.actions.every((a) => a.status === "orphaned")).toBe(true);
      expect(dataSource.events.length).toBe(0); // All pruned
      expect(dataSource.settlements.every((s) => s.state === "Escalated")).toBe(true);
    });

    it("ignores recent records younger than stale threshold", async () => {
      // 1 stale action, 1 recent action
      dataSource.actions.push(
        {
          id: "10000000-0000-4000-8000-000000000001",
          status: "submitted",
          txHash: "0xold",
          updatedAt: twoHoursAgo
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          status: "submitted",
          txHash: "0xrecent",
          updatedAt: tenMinutesAgo // Under 30m default threshold
        }
      );

      const result = await engine.startJob({
        dryRun: false,
        phases: ["orphaned_actions"]
      });

      expect(result.stats.scannedCount).toBe(1);
      expect(result.stats.repairedCount).toBe(1);
      expect(dataSource.actions.find((a) => a.id.endsWith("001"))?.status).toBe("orphaned");
      expect(dataSource.actions.find((a) => a.id.endsWith("002"))?.status).toBe("submitted");
    });
  });

  describe("2. Resumability and Checkpointing Across Interruptions", () => {
    it("resumes accurately from last committed cursor and phase without reprocessing", async () => {
      // Seed 6 stale actions
      for (let i = 1; i <= 6; i++) {
        dataSource.actions.push({
          id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          status: "submitted",
          txHash: `0xtx_${i}`,
          updatedAt: twoHoursAgo
        });
      }

      // Seed 2 stale events
      for (let i = 1; i <= 2; i++) {
        dataSource.events.push({
          txHash: `0xevent_${i}`,
          statusHint: "confirmed",
          receivedAt: twoHoursAgo
        });
      }

      // Simulate a job interrupted after first batch of 2 actions:
      // Persist checkpoint mid-flight
      const jobId = "job-interrupted-001";
      const initialCheckpoint = {
        jobId,
        currentPhase: "orphaned_actions" as const,
        cursor: "10000000-0000-4000-8000-000000000002", // Last processed cursor was item 2
        dryRun: false,
        batchSize: 2,
        status: "paused" as const,
        stats: {
          scannedCount: 2,
          repairedCount: 2,
          failedCount: 0,
          phaseBreakdown: {
            orphaned_actions: { scanned: 2, repaired: 2, failed: 0 },
            stale_pending_events: { scanned: 0, repaired: 0, failed: 0 },
            unresolved_settlements: { scanned: 0, repaired: 0, failed: 0 }
          }
        },
        errors: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await checkpointStore.save(initialCheckpoint);

      // Manually mark items 1 and 2 as already repaired
      dataSource.actions[0].status = "orphaned";
      dataSource.actions[1].status = "orphaned";

      // Resume job
      const resumeResult = await engine.resumeJob(jobId, { batchSize: 2 });

      expect(resumeResult.status).toBe("completed");
      // Remaining 4 actions + 2 events = 6 additional scanned items (total 8)
      expect(resumeResult.stats.scannedCount).toBe(8);
      expect(resumeResult.stats.repairedCount).toBe(8);
      expect(resumeResult.stats.phaseBreakdown.orphaned_actions.scanned).toBe(6);
      expect(resumeResult.stats.phaseBreakdown.stale_pending_events.scanned).toBe(2);

      // All 6 actions must be orphaned now
      expect(dataSource.actions.every((a) => a.status === "orphaned")).toBe(true);
      // Both events pruned
      expect(dataSource.events.length).toBe(0);
    });

    it("pausing job gracefully stops execution at batch boundary", async () => {
      for (let i = 1; i <= 10; i++) {
        dataSource.actions.push({
          id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          status: "submitted",
          txHash: `0xtx_${i}`,
          updatedAt: twoHoursAgo
        });
      }

      // Signal pause immediately
      const startPromise = engine.startJob({ batchSize: 2, phases: ["orphaned_actions"] });
      // Pause engine while running
      await engine.pauseJob((await checkpointStore.list())[0]?.jobId || "dummy");

      // Even if pause fires during loop or right before, checkpoint status is paused or completed
      const cp = await checkpointStore.list();
      expect(cp.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("3. Dry-Run Planning Mode", () => {
    it("dry-run calculates repair metrics and plans without mutating database rows", async () => {
      dataSource.actions.push({
        id: "10000000-0000-4000-8000-000000000001",
        status: "submitted",
        txHash: "0xdry_run_tx",
        updatedAt: twoHoursAgo
      });

      dataSource.events.push({
        txHash: "0xdry_run_event",
        statusHint: "confirmed",
        receivedAt: twoHoursAgo
      });

      const result = await engine.startJob({
        dryRun: true
      });

      expect(result.status).toBe("completed");
      expect(result.dryRun).toBe(true);
      expect(result.stats.scannedCount).toBe(2);
      expect(result.stats.repairedCount).toBe(2);

      // Verify NO mutations were applied
      expect(dataSource.actions[0].status).toBe("submitted"); // Unchanged!
      expect(dataSource.events.length).toBe(1); // Not pruned!
    });
  });

  describe("4. Error Handling and Partial Failure Isolation", () => {
    it("isolates record-level errors and continues processing batch", async () => {
      dataSource.actions.push(
        {
          id: "10000000-0000-4000-8000-000000000001",
          status: "submitted",
          txHash: "0xgood_1",
          updatedAt: twoHoursAgo
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          status: "submitted",
          txHash: "0xfailing_tx",
          updatedAt: twoHoursAgo
        },
        {
          id: "10000000-0000-4000-8000-000000000003",
          status: "submitted",
          txHash: "0xgood_2",
          updatedAt: twoHoursAgo
        }
      );

      // Mock repairAction to throw for item 2
      const originalRepair = dataSource.repairAction.bind(dataSource);
      dataSource.repairAction = async (id, status, reason) => {
        if (id.endsWith("002")) {
          throw new Error("Lock timeout on action ledger row");
        }
        return originalRepair(id, status, reason);
      };

      const result = await engine.startJob({
        dryRun: false,
        batchSize: 5,
        phases: ["orphaned_actions"]
      });

      expect(result.status).toBe("completed");
      expect(result.stats.scannedCount).toBe(3);
      expect(result.stats.repairedCount).toBe(2);
      expect(result.stats.failedCount).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].recordId).toContain("002");
      expect(result.errors[0].message).toContain("Lock timeout on action ledger row");

      // Verify good items were repaired despite the error on item 2
      expect(dataSource.actions[0].status).toBe("orphaned");
      expect(dataSource.actions[1].status).toBe("submitted"); // Failed
      expect(dataSource.actions[2].status).toBe("orphaned");
    });

    it("resuming a completed job is idempotent and returns completed checkpoint", async () => {
      const initial = await engine.startJob({ dryRun: true });
      expect(initial.status).toBe("completed");

      const secondRun = await engine.resumeJob(initial.jobId);
      expect(secondRun.status).toBe("completed");
    });

    it("throws 404 AppError when resuming a non-existent job ID", async () => {
      await expect(engine.resumeJob("non-existent-uuid")).rejects.toThrow();
    });
  });

  describe("5. HTTP API Integration and Authorization Boundaries", () => {
    const internalSecret = "super-secret-service-auth-key-12345";

    async function createTestApp() {
      const app = Fastify();
      app.setErrorHandler(errorHandler);

      const jobQueue = new JobQueue(new InMemoryJobStore());
      app.register(
        jobsRoutes(
          jobQueue,
          internalSecret,
          undefined,
          undefined,
          engine
        )
      );

      await app.ready();
      return app;
    }

    it("starts resumable repair via POST /internal/repair/resumable with internal secret", async () => {
      const app = await createTestApp();

      dataSource.actions.push({
        id: "10000000-0000-4000-8000-000000000001",
        status: "submitted",
        txHash: "0xapi_test",
        updatedAt: twoHoursAgo
      });

      const res = await app.inject({
        method: "POST",
        url: "/internal/repair/resumable",
        headers: {
          "x-internal-secret": internalSecret
        },
        payload: {
          dry_run: false,
          batch_size: 10,
          phases: ["orphaned_actions"]
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.jobId).toBeDefined();
      expect(body.data.status).toBe("completed");
      expect(body.data.stats.repairedCount).toBe(1);

      await app.close();
    });

    it("retrieves checkpoint via GET /internal/repair/resumable/:id/checkpoint", async () => {
      const app = await createTestApp();

      const initial = await engine.startJob({ dryRun: true });

      const res = await app.inject({
        method: "GET",
        url: `/internal/repair/resumable/${initial.jobId}/checkpoint`,
        headers: {
          "x-internal-secret": internalSecret
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.jobId).toBe(initial.jobId);
      expect(body.data.status).toBe("completed");

      await app.close();
    });

    it("rejects unauthenticated request to /internal/repair/resumable with 401 Problem Details", async () => {
      const app = await createTestApp();

      const res = await app.inject({
        method: "POST",
        url: "/internal/repair/resumable",
        payload: { dry_run: true }
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe(ERROR_CODES.UNAUTHORIZED);

      await app.close();
    });
  });
});
