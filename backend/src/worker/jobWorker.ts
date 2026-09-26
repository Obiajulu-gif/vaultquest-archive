import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { withTelemetry } from "../services/telemetry.js";
import type { JobStore } from "./jobStore.js";
import { DEFAULT_RETRY_POLICY, nextDelayMs, toJobFailure, type RetryPolicy } from "./retryPolicy.js";
import { NonRetryableJobError, type EnqueueInput, type JobHandler, type JobRecord, type ListJobsParams } from "./types.js";

export interface JobQueueOptions {
  store: JobStore;
  /** Default policy; `maxAttempts` may be overridden per enqueue. */
  policy?: RetryPolicy;
  now?: () => Date;
}

/** Producer/inspection side: enqueue jobs and look at their state. */
export class JobQueue {
  readonly store: JobStore;
  readonly policy: RetryPolicy;
  private readonly now: () => Date;

  constructor(opts: JobQueueOptions) {
    this.store = opts.store;
    this.policy = opts.policy ?? DEFAULT_RETRY_POLICY;
    this.now = opts.now ?? (() => new Date());
  }

  /** Idempotent: repeating an enqueue with the same key returns the existing job. */
  enqueue<P>(input: EnqueueInput<P>): Promise<{ job: JobRecord<P>; created: boolean }> {
    return this.store.enqueue(
      { ...input, maxAttempts: input.maxAttempts ?? this.policy.maxAttempts },
      this.now()
    ) as Promise<{ job: JobRecord<P>; created: boolean }>;
  }

  getJob(id: string): Promise<JobRecord | null> {
    return this.store.get(id);
  }

  listJobs(params?: ListJobsParams): Promise<JobRecord[]> {
    return this.store.list(params);
  }

  /** Gives a dead-lettered job a fresh attempt budget (operator action). */
  retryDeadJob(id: string): Promise<JobRecord | null> {
    return this.store.requeueDead(id, this.now());
  }
}

export interface JobWorkerOptions {
  queue: JobQueue;
  handlers: Record<string, JobHandler>;
  workerId?: string;
  logger?: Logger;
  batchSize?: number;
  pollIntervalMs?: number;
  /** How long a `running` job may stay locked before another worker reclaims it. */
  visibilityTimeoutMs?: number;
  now?: () => Date;
  rng?: () => number;
}

export interface RunSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  dead: number;
}

/** Consumer side: claims due jobs, runs handlers, applies the retry policy. */
export class JobWorker {
  readonly workerId: string;
  private readonly queue: JobQueue;
  private readonly handlers: Record<string, JobHandler>;
  private readonly logger?: Logger;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly visibilityTimeoutMs: number;
  private readonly now: () => Date;
  private readonly rng: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;

  constructor(opts: JobWorkerOptions) {
    this.queue = opts.queue;
    this.handlers = opts.handlers;
    this.logger = opts.logger;
    this.workerId = opts.workerId ?? `job-worker-${randomUUID().slice(0, 8)}`;
    this.batchSize = opts.batchSize ?? 10;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.visibilityTimeoutMs = opts.visibilityTimeoutMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => new Date());
    this.rng = opts.rng ?? Math.random;
  }

  /** Claims and processes one batch. Exposed for tests and one-shot CLI runs. */
  async runOnce(): Promise<RunSummary> {
    const summary: RunSummary = { claimed: 0, succeeded: 0, retried: 0, dead: 0 };
    const jobs = await this.queue.store.claim({
      workerId: this.workerId,
      now: this.now(),
      visibilityTimeoutMs: this.visibilityTimeoutMs,
      limit: this.batchSize
    });
    summary.claimed = jobs.length;
    for (const job of jobs) {
      const outcome = await this.process(job);
      summary[outcome] += 1;
    }
    return summary;
  }

  private async process(job: JobRecord): Promise<"succeeded" | "retried" | "dead"> {
    const log = this.logger?.child({ job_id: job.id, job_type: job.type, correlation_id: job.correlationId });
    try {
      const handler = this.handlers[job.type];
      if (!handler) throw new NonRetryableJobError(`no handler registered for job type ${job.type}`);
      await withTelemetry(
        { operation: "worker.job", actorType: "worker", correlationId: job.correlationId, detail: job.type },
        () => handler(job)
      );
      if (!(await this.queue.store.complete(job.id, this.workerId, this.now()))) {
        log?.warn("job finished but its lock was lost; another worker owns it now");
      } else {
        log?.info({ attempts: job.attempts }, "job succeeded");
      }
      return "succeeded";
    } catch (err) {
      const now = this.now();
      const failure = toJobFailure(err, job.attempts, now);
      const dead = !failure.retryable || job.attempts >= job.maxAttempts;
      const retryAt = dead ? undefined : new Date(now.getTime() + nextDelayMs(this.queue.policy, job.attempts, this.rng));
      const recorded = await this.queue.store.fail(job.id, this.workerId, { failure, dead, retryAt }, now);
      if (!recorded) log?.warn("job failed but its lock was lost; another worker owns it now");
      if (dead) {
        log?.error({ failure, attempts: job.attempts }, "job moved to dead-letter");
        return "dead";
      }
      log?.warn({ failure, retry_at: retryAt?.toISOString() }, "job failed; will retry");
      return "retried";
    }
  }

  /** Starts polling. Ticks never overlap and errors never escape the timer. */
  start(): void {
    if (this.timer) return;
    const tick = () => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch((err) => this.logger?.error({ err }, "job worker poll failed"))
        .finally(() => {
          this.running = null;
        });
    };
    this.timer = setInterval(tick, this.pollIntervalMs);
    this.timer.unref?.();
    tick();
  }

  /** Stops polling and waits for the in-flight batch to finish. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
