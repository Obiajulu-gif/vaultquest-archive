import type { JobStore } from "./jobStore.js";
import { AppError } from "../errors.js";

export type BackpressurePolicy = "REJECT" | "DROP_LOW_PRIORITY" | "DEFER";

export type BackpressureState = "normal" | "warning" | "saturated";

export interface QueueBackpressureConfig {
  /** Maximum total queued + running jobs allowed before rejecting new jobs. */
  maxQueueDepth: number;
  /** High watermark ratio (0.0 - 1.0) where warning/shedding starts. Default 0.8. */
  highWatermarkRatio: number;
  /** Low watermark ratio (0.0 - 1.0) where normal state resumes. Default 0.5. */
  lowWatermarkRatio: number;
  /** Types of jobs considered resource-expensive. */
  expensiveJobTypes: Set<string>;
  /** Stricter maximum depth specifically for expensive background jobs. */
  maxExpensiveDepth: number;
  /** Maximum concurrently running jobs. */
  maxInFlight: number;
  /** Default recommended retry delay in milliseconds when backpressured. */
  defaultRetryAfterMs: number;
}

export const DEFAULT_BACKPRESSURE_CONFIG: QueueBackpressureConfig = {
  maxQueueDepth: 500,
  highWatermarkRatio: 0.8,
  lowWatermarkRatio: 0.5,
  expensiveJobTypes: new Set([
    "settlement",
    "payout",
    "round_close",
    "indexer_backfill",
    "reconciliation",
    "batch_export",
    "recheck_orphans",
  ]),
  maxExpensiveDepth: 50,
  maxInFlight: 25,
  defaultRetryAfterMs: 5000,
};

export interface QueuePressureMetrics {
  totalDepth: number;
  queuedCount: number;
  runningCount: number;
  expensiveDepth: number;
  maxCapacity: number;
  utilization: number;
  state: BackpressureState;
  activeShedding: boolean;
  admittedTotal: number;
  rejectedTotal: number;
  droppedTotal: number;
  lastRejectedAt: Date | null;
}

export class QueueBackpressureError extends AppError {
  readonly retryAfterMs: number;
  readonly currentDepth: number;
  readonly maxCapacity: number;

  constructor(message: string, retryAfterMs = 5000, currentDepth = 0, maxCapacity = 0) {
    super("QUEUE_BACKPRESSURE", 429, message);
    this.name = "QueueBackpressureError";
    this.retryAfterMs = retryAfterMs;
    this.currentDepth = currentDepth;
    this.maxCapacity = maxCapacity;
  }
}

export interface AdmissionOptions {
  priority?: "low" | "normal" | "high" | "critical";
  bypassBackpressure?: boolean;
}

export class QueueBackpressureManager {
  private readonly config: QueueBackpressureConfig;
  private inBackpressure = false;
  private admittedTotal = 0;
  private rejectedTotal = 0;
  private droppedTotal = 0;
  private lastRejectedAt: Date | null = null;

  constructor(
    private readonly store: JobStore,
    config?: Partial<QueueBackpressureConfig>,
  ) {
    this.config = { ...DEFAULT_BACKPRESSURE_CONFIG, ...config };
  }

  /**
   * Evaluates queue pressure and admits or rejects the incoming background job.
   */
  async checkAdmission(
    jobType: string,
    options: AdmissionOptions = {},
  ): Promise<{ admitted: boolean; reason?: string; retryAfterMs?: number }> {
    // Emergency or administrative bypass
    if (options.bypassBackpressure || options.priority === "critical") {
      this.admittedTotal++;
      return { admitted: true };
    }

    const [queuedJobs, runningJobs] = await Promise.all([
      this.store.list({ status: "queued", limit: this.config.maxQueueDepth + 50 }),
      this.store.list({ status: "running", limit: this.config.maxInFlight + 50 }),
    ]);

    const queuedCount = queuedJobs.length;
    const runningCount = runningJobs.length;
    const totalDepth = queuedCount + runningCount;

    const highWatermark = Math.floor(this.config.maxQueueDepth * this.config.highWatermarkRatio);
    const lowWatermark = Math.floor(this.config.maxQueueDepth * this.config.lowWatermarkRatio);

    // Hysteresis state transition
    if (!this.inBackpressure && totalDepth >= highWatermark) {
      this.inBackpressure = true;
    } else if (this.inBackpressure && totalDepth <= lowWatermark) {
      this.inBackpressure = false;
    }

    // 1. Expensive Job Specific Bounded Limit
    const isExpensive = this.config.expensiveJobTypes.has(jobType);
    if (isExpensive) {
      const expensiveCount =
        queuedJobs.filter((j) => j.type === jobType).length +
        runningJobs.filter((j) => j.type === jobType).length;

      if (expensiveCount >= this.config.maxExpensiveDepth) {
        this.rejectedTotal++;
        this.lastRejectedAt = new Date();
        throw new QueueBackpressureError(
          `Queue backpressure: expensive job type '${jobType}' reached limit (${expensiveCount}/${this.config.maxExpensiveDepth})`,
          this.config.defaultRetryAfterMs,
          expensiveCount,
          this.config.maxExpensiveDepth,
        );
      }
    }

    // 2. Concurrency In-Flight Saturation
    if (runningCount >= this.config.maxInFlight && options.priority !== "high") {
      this.rejectedTotal++;
      this.lastRejectedAt = new Date();
      throw new QueueBackpressureError(
        `Queue backpressure: concurrent workers saturated (${runningCount}/${this.config.maxInFlight} in-flight)`,
        this.config.defaultRetryAfterMs,
        runningCount,
        this.config.maxInFlight,
      );
    }

    // 3. Overall Queue Saturation Check
    if (totalDepth >= this.config.maxQueueDepth) {
      this.rejectedTotal++;
      this.lastRejectedAt = new Date();
      throw new QueueBackpressureError(
        `Queue backpressure: total queue depth exceeded (${totalDepth}/${this.config.maxQueueDepth})`,
        this.config.defaultRetryAfterMs,
        totalDepth,
        this.config.maxQueueDepth,
      );
    }

    // 4. Load Shedding: Drop low priority jobs while in backpressure mode
    if (this.inBackpressure && options.priority === "low") {
      this.droppedTotal++;
      return {
        admitted: false,
        reason: "DROPPED_LOW_PRIORITY",
        retryAfterMs: this.config.defaultRetryAfterMs * 2,
      };
    }

    this.admittedTotal++;
    return { admitted: true };
  }

  /**
   * Retrieves current queue pressure metrics for health checks and observability.
   */
  async getMetrics(): Promise<QueuePressureMetrics> {
    const [queuedJobs, runningJobs] = await Promise.all([
      this.store.list({ status: "queued", limit: this.config.maxQueueDepth + 50 }),
      this.store.list({ status: "running", limit: this.config.maxInFlight + 50 }),
    ]);

    const queuedCount = queuedJobs.length;
    const runningCount = runningJobs.length;
    const totalDepth = queuedCount + runningCount;

    const expensiveDepth =
      queuedJobs.filter((j) => this.config.expensiveJobTypes.has(j.type)).length +
      runningJobs.filter((j) => this.config.expensiveJobTypes.has(j.type)).length;

    const utilization = Math.min(1.0, Math.round((totalDepth / this.config.maxQueueDepth) * 1000) / 1000);

    let state: BackpressureState = "normal";
    if (totalDepth >= this.config.maxQueueDepth || runningCount >= this.config.maxInFlight) {
      state = "saturated";
    } else if (this.inBackpressure || totalDepth >= Math.floor(this.config.maxQueueDepth * this.config.highWatermarkRatio)) {
      state = "warning";
    }

    return {
      totalDepth,
      queuedCount,
      runningCount,
      expensiveDepth,
      maxCapacity: this.config.maxQueueDepth,
      utilization,
      state,
      activeShedding: this.inBackpressure,
      admittedTotal: this.admittedTotal,
      rejectedTotal: this.rejectedTotal,
      droppedTotal: this.droppedTotal,
      lastRejectedAt: this.lastRejectedAt,
    };
  }

  reset(): void {
    this.inBackpressure = false;
    this.admittedTotal = 0;
    this.rejectedTotal = 0;
    this.droppedTotal = 0;
    this.lastRejectedAt = null;
  }
}
