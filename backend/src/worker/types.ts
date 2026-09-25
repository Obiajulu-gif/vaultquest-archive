/**
 * #771 — background job framework: payload format.
 *
 * Jobs are durable rows identified by a caller-supplied idempotency key.
 * Delivery is at-least-once, so every handler must be safe to run twice for
 * the same job.
 */
export const JOB_STATUSES = ["queued", "running", "succeeded", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** One failed attempt, kept on the job so a dead-lettered job explains itself. */
export interface JobFailure {
  attempt: number;
  at: string;
  /** Stable taxonomy code (see errorTaxonomy.ts), or INTERNAL. */
  code: string;
  /** Redacted, length-limited error message. */
  message: string;
  retryable: boolean;
}

export interface JobRecord<P = unknown> {
  id: string;
  type: string;
  payload: P;
  idempotencyKey: string;
  status: JobStatus;
  /** Number of times the job has been claimed for execution. */
  attempts: number;
  maxAttempts: number;
  /** Earliest time the job may run; also the retry schedule. */
  runAt: Date;
  lockedBy: string | null;
  lockedAt: Date | null;
  correlationId: string | null;
  lastError: JobFailure | null;
  failures: JobFailure[];
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface EnqueueInput<P = unknown> {
  type: string;
  payload: P;
  /** Two enqueues with the same key produce a single job. */
  idempotencyKey: string;
  runAt?: Date;
  maxAttempts?: number;
  correlationId?: string | null;
}

export interface ListJobsParams {
  status?: JobStatus;
  type?: string;
  limit?: number;
}

export type JobHandler<P = unknown> = (job: JobRecord<P>) => Promise<void>;

/** Thrown by handlers (or the framework) to skip remaining retries. */
export class NonRetryableJobError extends Error {
  readonly code: string;
  constructor(message: string, code = "INTERNAL") {
    super(message);
    this.name = "NonRetryableJobError";
    this.code = code;
  }
}
