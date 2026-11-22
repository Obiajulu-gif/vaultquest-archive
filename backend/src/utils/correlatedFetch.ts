/**
 * Issue #981 — Request correlation across API, workers, and external calls.
 *
 * A thin wrapper around `fetch` that automatically propagates the current
 * `Correlation-Id` header to outbound HTTP requests so that external
 * services, indexers, and RPC providers can correlate their logs with
 * the originating VaultQuest request.
 *
 * Usage:
 *   import { correlatedFetch } from "../utils/correlatedFetch.js";
 *   const resp = await correlatedFetch("https://horizon.stellar.org/...");
 *
 * The wrapper:
 *  - Reads the correlation ID from the AsyncLocalStorage context set by the
 *    `correlation` middleware (via `currentCorrelationId()`).
 *  - Injects it as `Correlation-Id` if not already present on the request.
 *  - Never throws; callers still receive the raw `fetch` rejection on network
 *    errors, and no sensitive header values are added.
 *
 * Edge cases / rollback:
 *  - If `currentCorrelationId()` returns null (background job without a
 *    bound ID) the header is omitted — no generated ID is silently injected
 *    for external callers.
 *  - If the caller already sets `Correlation-Id` their value is preserved.
 *  - The wrapper is a drop-in replacement; callers that pass `RequestInit`
 *    options continue to work unmodified.
 */

import { currentCorrelationId } from "../services/telemetry.js";

export type CorrelatedFetchInit = RequestInit & {
  /**
   * Optional explicit correlation ID to use instead of the one from the
   * async context. Useful for worker jobs that carry a correlationId field.
   */
  correlationId?: string | null;
};

/**
 * Wraps the global `fetch` with automatic `Correlation-Id` propagation.
 */
export async function correlatedFetch(
  input: string | URL | Request,
  init?: CorrelatedFetchInit
): Promise<Response> {
  const id = init?.correlationId !== undefined
    ? init.correlationId
    : currentCorrelationId();

  if (!id) {
    // No correlation context — delegate to bare fetch to avoid injecting
    // a random ID that the caller did not choose.
    const { correlationId: _dropped, ...rest } = init ?? {};
    return fetch(input, rest as RequestInit);
  }

  // Merge the correlation ID into the outbound headers without mutating
  // the caller's object.
  const headers = new Headers(init?.headers);
  if (!headers.has("Correlation-Id")) {
    headers.set("Correlation-Id", id);
  }

  const { correlationId: _dropped, ...rest } = init ?? {};
  return fetch(input, { ...rest, headers });
}
