/**
 * Issue #981 — Correlation-aware job enqueue helpers.
 *
 * When the API enqueues a background job, the current request's correlation
 * ID is automatically captured so the worker can rebind it during execution
 * (the `JobWorker` already passes `job.correlationId` to `withTelemetry`,
 * which calls `runWithCorrelation` so every log line the handler produces
 * carries the same ID as the originating HTTP request).
 *
 * Edge cases:
 *  - If no correlation context exists the correlationId field is set to null
 *    so the worker starts a fresh trace rather than inheriting a stale one.
 *  - Callers that explicitly pass correlationId in their EnqueueInput are
 *    not overridden.
 */

import { currentCorrelationId } from "../services/telemetry.js";
import type { JobQueue } from "./jobWorker.js";
import type { EnqueueInput } from "./types.js";
import type { AdmissionOptions } from "./queueBackpressure.js";

/**
 * Wraps `JobQueue.enqueue` so the current correlation ID is automatically
 * injected unless the caller already supplies one.
 *
 * Example:
 * ```ts
 * await enqueueWithCorrelation(queue, {
 *   type: JOB_TYPES.DRAW_PROOF_GENERATE,
 *   payload: { actionId },
 *   idempotencyKey: drawProofJobKey(actionId),
 * });
 * ```
 */
export async function enqueueWithCorrelation<P>(
  queue: JobQueue,
  input: EnqueueInput<P>,
  options?: AdmissionOptions
): ReturnType<JobQueue["enqueue"]> {
  const correlationId =
    input.correlationId !== undefined
      ? input.correlationId // caller explicitly set it (even null is honoured)
      : currentCorrelationId(); // inherit from the current async context

  return queue.enqueue({ ...input, correlationId }, options);
}
