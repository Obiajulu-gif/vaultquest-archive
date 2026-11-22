import { AppError } from "../errors.js";
import { describeError } from "../errorTaxonomy.js";
import { NonRetryableJobError, type JobFailure } from "./types.js";

export interface RetryPolicy {
  /** Total executions allowed, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000
};

/**
 * Delay before the next attempt after `attempt` failed: exponential, capped,
 * with jitter in [50%, 100%] so retries from many jobs do not synchronise.
 */
export function nextDelayMs(policy: RetryPolicy, attempt: number, rng: () => number = Math.random): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + rng() * 0.5));
}

const MESSAGE_LIMIT = 500;

/** Strips wallet addresses and tx hashes, and bounds the size, before persisting. */
export function sanitizeMessage(message: string): string {
  return message
    .replace(/\bG[A-Z2-7]{55}\b/g, "[REDACTED_WALLET]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[REDACTED_TX]")
    .slice(0, MESSAGE_LIMIT);
}

/** Turns a thrown value into a persisted failure record. */
export function toJobFailure(err: unknown, attempt: number, at: Date): JobFailure {
  let code = "INTERNAL";
  let retryable = true;
  if (err instanceof NonRetryableJobError) {
    code = err.code;
    retryable = false;
  } else if (err instanceof AppError) {
    code = err.code;
    retryable = describeError(err.code).retryable;
  }
  const message = err instanceof Error ? err.message : String(err);
  return { attempt, at: at.toISOString(), code, message: sanitizeMessage(message), retryable };
}
