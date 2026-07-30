/**
 * Exponential backoff retry utility for Soroban RPC calls (issue #274).
 *
 * All RPC I/O that can fail transiently (network errors, rate limits, bad
 * sequence numbers) should be wrapped with `withRetry` so callers never need
 * to implement their own backoff loops.
 */

import { RETRYABLE_RESULT_CODES } from "../constants.js";

export interface RetryOptions {
  /**
   * Maximum number of attempts (including the first).
   * @default 4
   */
  maxAttempts?: number;

  /**
   * Base delay in milliseconds for the first backoff interval.
   * Each subsequent interval is doubled with full-jitter applied.
   * @default 200
   */
  baseDelayMs?: number;

  /**
   * Hard cap on any single delay interval (after jitter).
   * @default 8000
   */
  maxDelayMs?: number;

  /**
   * Optional override: returns `true` when a thrown error should trigger a
   * retry. Defaults to `isRetryableError`.
   */
  isRetryable?: (err: unknown) => boolean;

  /**
   * Injected sleep function; defaults to `setTimeout`-based delay.
   * Override in tests to avoid real timers.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Determines whether a caught error is safe to retry based on the known set
 * of transient Horizon / Soroban RPC result codes.
 */
export function isRetryableError(err: unknown): boolean {
  if (err == null) return false;

  const message =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as any).resultCode === "string"
          ? (err as any).resultCode
          : "";

  const code =
    typeof (err as any).resultCode === "string"
      ? (err as any).resultCode
      : typeof (err as any).code === "string"
        ? (err as any).code
        : "";

  const haystack = `${message} ${code}`.toLowerCase();

  return RETRYABLE_RESULT_CODES.some((r) => haystack.includes(r.toLowerCase()));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps an async function with exponential backoff + full-jitter retries.
 *
 * @example
 * ```ts
 * const events = await withRetry(() => rpc.getEvents(opts), { maxAttempts: 5 });
 * ```
 *
 * @param fn        - The async operation to attempt.
 * @param options   - Retry configuration.
 * @returns The value resolved by `fn` on a successful attempt.
 * @throws  The last error thrown by `fn` when all attempts are exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 200;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      const exhausted = attempt >= maxAttempts;
      const retryable = isRetryable(err);

      if (exhausted || !retryable) {
        throw err;
      }

      // Full-jitter exponential backoff:
      //   cap = min(maxDelayMs, baseDelayMs * 2^(attempt-1))
      //   sleep = random(0, cap)
      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delay = Math.floor(Math.random() * cap);
      await sleep(delay);
    }
  }

  // Unreachable, but TypeScript needs the throw.
  throw lastError;
}
