import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryJobStore } from "../src/worker/jobStore.js";
import { JobQueue } from "../src/worker/jobWorker.js";
import {
  QueueBackpressureManager,
  QueueBackpressureError,
  type QueueBackpressureConfig
} from "../src/worker/queueBackpressure.js";
import { buildApp } from "../src/app.js";

describe("QueueBackpressureManager", () => {
  let store: InMemoryJobStore;
  let manager: QueueBackpressureManager;
  const config: QueueBackpressureConfig = {
    maxQueueDepth: 10,
    highWatermarkRatio: 0.8, // 8 jobs
    lowWatermarkRatio: 0.5,  // 5 jobs
    expensiveJobTypes: new Set(["settlement", "indexer_backfill"]),
    maxExpensiveDepth: 3,
    maxInFlight: 4,
    defaultRetryAfterMs: 3000
  };

  beforeEach(() => {
    store = new InMemoryJobStore();
    manager = new QueueBackpressureManager(store, config);
  });

  it("admits jobs when queue depth is within normal limits", async () => {
    const admission = await manager.checkAdmission("draw_proof");
    expect(admission.admitted).toBe(true);

    const metrics = await manager.getMetrics();
    expect(metrics.state).toBe("normal");
    expect(metrics.admittedTotal).toBe(1);
    expect(metrics.rejectedTotal).toBe(0);
    expect(metrics.utilization).toBe(0);
  });

  it("enforces stricter bounded depth on expensive background jobs", async () => {
    const now = new Date();
    // Enqueue 3 expensive jobs (reaching maxExpensiveDepth = 3)
    for (let i = 0; i < 3; i++) {
      await store.enqueue({ type: "settlement", idempotencyKey: `settle-${i}`, payload: {} }, now);
    }

    // A 4th expensive job should be rejected
    await expect(manager.checkAdmission("settlement")).rejects.toThrow(QueueBackpressureError);

    try {
      await manager.checkAdmission("settlement");
    } catch (err: any) {
      expect(err).toBeInstanceOf(QueueBackpressureError);
      expect(err.statusCode).toBe(429);
      expect(err.retryAfterMs).toBe(3000);
      expect(err.currentDepth).toBe(3);
      expect(err.maxCapacity).toBe(3);
    }

    // Non-expensive job should still be admitted if total capacity permits
    const otherAdmission = await manager.checkAdmission("draw_proof");
    expect(otherAdmission.admitted).toBe(true);
  });

  it("enforces concurrency in-flight limits with priority bypass", async () => {
    const now = new Date();
    // Enqueue and claim 4 running jobs (reaching maxInFlight = 4)
    for (let i = 0; i < 4; i++) {
      await store.enqueue({ type: "general", idempotencyKey: `job-${i}`, payload: {} }, now);
    }
    await store.claim({ workerId: "worker-1", now, visibilityTimeoutMs: 60_000, limit: 4 });

    // Normal job should be rejected due to worker saturation
    await expect(manager.checkAdmission("general")).rejects.toThrow(QueueBackpressureError);

    // High priority job should bypass in-flight worker saturation
    const highPri = await manager.checkAdmission("general", { priority: "high" });
    expect(highPri.admitted).toBe(true);

    // Critical priority job should bypass unconditionally
    const critPri = await manager.checkAdmission("general", { priority: "critical" });
    expect(critPri.admitted).toBe(true);

    // Admin bypass flag should bypass unconditionally
    const bypass = await manager.checkAdmission("general", { bypassBackpressure: true });
    expect(bypass.admitted).toBe(true);
  });

  it("rejects jobs when total queue depth exceeds maxQueueDepth", async () => {
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      await store.enqueue({ type: "general", idempotencyKey: `job-${i}`, payload: {} }, now);
    }

    await expect(manager.checkAdmission("general")).rejects.toThrow(QueueBackpressureError);

    const metrics = await manager.getMetrics();
    expect(metrics.state).toBe("saturated");
    expect(metrics.totalDepth).toBe(10);
    expect(metrics.rejectedTotal).toBeGreaterThanOrEqual(1);
    expect(metrics.lastRejectedAt).toBeInstanceOf(Date);
  });

  it("maintains backpressure state using hysteresis and sheds low priority jobs", async () => {
    const now = new Date();
    // Fill to 8 jobs (high watermark: 10 * 0.8 = 8)
    for (let i = 0; i < 8; i++) {
      await store.enqueue({ type: "general", idempotencyKey: `job-${i}`, payload: {} }, now);
    }

    // Normal job check triggers high watermark hysteresis
    const normal = await manager.checkAdmission("general");
    expect(normal.admitted).toBe(true);

    // Low priority job should now be shed (dropped)
    const low = await manager.checkAdmission("general", { priority: "low" });
    expect(low.admitted).toBe(false);
    expect(low.reason).toBe("DROPPED_LOW_PRIORITY");

    const metrics = await manager.getMetrics();
    expect(metrics.state).toBe("warning");
    expect(metrics.activeShedding).toBe(true);
    expect(metrics.droppedTotal).toBe(1);

    // Drain queue down to 4 jobs (below low watermark: 10 * 0.5 = 5)
    const claimed = await store.claim({ workerId: "w1", now, visibilityTimeoutMs: 60_000, limit: 4 });
    for (const job of claimed) {
      await store.complete(job.id, "w1", now);
    }

    // Check again: hysteresis should reset back to normal
    const normalAfterDrain = await manager.checkAdmission("general");
    expect(normalAfterDrain.admitted).toBe(true);

    // Low priority should now be admitted again
    const lowAfterDrain = await manager.checkAdmission("general", { priority: "low" });
    expect(lowAfterDrain.admitted).toBe(true);
  });

  it("integrates with JobQueue.enqueue seamlessly", async () => {
    const queue = new JobQueue({
      store,
      backpressureManager: manager
    });

    const res1 = await queue.enqueue({ type: "draw_proof", idempotencyKey: "k1", payload: {} });
    expect(res1.created).toBe(true);
    expect(res1.job.id).toBeDefined();

    // Fill to high watermark
    const now = new Date();
    for (let i = 0; i < 7; i++) {
      await store.enqueue({ type: "general", idempotencyKey: `fill-${i}`, payload: {} }, now);
    }

    // Low priority enqueue is dropped
    const shedRes = await queue.enqueue({ type: "general", idempotencyKey: "k2", payload: {} }, { priority: "low" });
    expect(shedRes.dropped).toBe(true);
    expect(shedRes.reason).toBe("DROPPED_LOW_PRIORITY");
  });

  it("reports pressure metrics via GET /internal/jobs/pressure", async () => {
    const queue = new JobQueue({
      store,
      backpressureManager: manager
    });

    const secret = "test-internal-secret";
    const app = await buildApp({
      prisma: {} as any,
      internalSecret: secret,
      jobQueue: queue
    });

    // Without auth -> 401
    const unauth = await app.inject({
      method: "GET",
      url: "/internal/jobs/pressure"
    });
    expect(unauth.statusCode).toBe(401);

    // With auth -> 200 and metrics
    const authed = await app.inject({
      method: "GET",
      url: "/internal/jobs/pressure",
      headers: { "x-internal-secret": secret }
    });
    expect(authed.statusCode).toBe(200);
    const body = authed.json();
    expect(body.data.enabled).toBe(true);
    expect(body.data.metrics).toMatchObject({
      totalDepth: 0,
      state: "normal",
      maxCapacity: 10
    });

    await app.close();
  });
});
