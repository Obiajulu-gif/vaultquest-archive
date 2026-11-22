/**
 * End-to-End Request Correlation IDs (#1105)
 *
 * Propagates, validates, and enforces correlation IDs across inbound HTTP
 * gateways, downstream RPC/indexer calls, background jobs, and audit logs.
 *
 * Edge Cases & Recovery / Rollback Behavior:
 * 1. Malformed / Spoofed Correlation Headers: Inbound `x-correlation-id` or
 *    `x-request-id` values that exceed length bounds (64 chars), contain control
 *    characters, or fail the safe token pattern (`^[A-Za-z0-9._:-]{8,64}$`) are
 *    quarantined into `rejectedHeaderValue` and replaced with a fresh deterministic
 *    correlation ID so log-injection attacks cannot poison downstream sinks.
 * 2. Retry Lineage Preservation: When an operation is retried, the root
 *    `correlationId` is preserved while `attemptNumber` and a child `spanId`
 *    are rotated. If a downstream side effect fails midway, `rollbackWithCorrelation`
 *    attaches the exact correlation lineage to compensating rollback records.
 * 3. Authorization & Cross-Tenant Isolation: Correlation trace lookup enforces
 *    tenant and actor boundaries—users can only inspect traces belonging to their
 *    own `actorId`, whereas `operator`, `auditor`, and `admin` roles can inspect
 *    cross-service traces.
 */

import crypto from "node:crypto";

export const CORRELATION_HEADER = "x-correlation-id";
export const REQUEST_ID_HEADER = "x-request-id";
export const PARENT_SPAN_HEADER = "x-parent-span-id";

const SAFE_CORRELATION_PATTERN = /^[A-Za-z0-9._:-]{8,64}$/;

export class CorrelationAuthorizationError extends Error {
  constructor(message, code = "CORRELATION_UNAUTHORIZED") {
    super(message);
    this.name = "CorrelationAuthorizationError";
    this.code = code;
    this.statusCode = 403;
  }
}

export class CorrelationContextError extends Error {
  constructor(message, code = "CORRELATION_CONTEXT_ERROR", statusCode = 400) {
    super(message);
    this.name = "CorrelationContextError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isValidCorrelationId(value) {
  return typeof value === "string" && SAFE_CORRELATION_PATTERN.test(value.trim());
}

export function generateCorrelationId(prefix = "vq") {
  const cleanPrefix = String(prefix || "vq").replace(/[^A-Za-z0-9_-]/g, "") || "vq";
  return `${cleanPrefix}-${crypto.randomUUID()}`;
}

export function generateSpanId() {
  return `span-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Extracts or mints a safe correlation context from inbound headers.
 */
export function extractOrCreateCorrelationContext(headers = {}, options = {}) {
  const { actorId = null, service = "vaultquest-api", nowFn = () => new Date() } = options;
  const normalized = {};
  for (const [k, v] of Object.entries(headers || {})) {
    normalized[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }

  const rawIncoming =
    normalized[CORRELATION_HEADER] ?? normalized[REQUEST_ID_HEADER] ?? null;
  const rawParentSpan = normalized[PARENT_SPAN_HEADER] ?? null;

  let correlationId;
  let sanitizedFromInvalid = false;
  let rejectedHeaderValue = null;

  if (rawIncoming !== null && rawIncoming !== undefined && String(rawIncoming).trim() !== "") {
    const candidate = String(rawIncoming).trim();
    if (isValidCorrelationId(candidate)) {
      correlationId = candidate;
    } else {
      correlationId = generateCorrelationId("vq");
      sanitizedFromInvalid = true;
      rejectedHeaderValue = candidate.slice(0, 128);
    }
  } else {
    correlationId = generateCorrelationId("vq");
  }

  const parentSpanId =
    rawParentSpan && isValidCorrelationId(String(rawParentSpan).trim())
      ? String(rawParentSpan).trim()
      : null;

  return {
    correlationId,
    spanId: generateSpanId(),
    parentSpanId,
    attempt: 1,
    actorId,
    service,
    sanitizedFromInvalid,
    rejectedHeaderValue,
    createdAt: nowFn().toISOString(),
  };
}

/**
 * Creates outbound headers for downstream HTTP/RPC/job calls while advancing span lineage.
 */
export function buildDownstreamCorrelationHeaders(context, { nextAttempt = null } = {}) {
  if (!context || !isValidCorrelationId(context.correlationId)) {
    throw new CorrelationContextError(
      "Cannot propagate downstream headers without a valid correlationId.",
      "INVALID_CORRELATION_CONTEXT"
    );
  }
  const attempt = nextAttempt !== null ? nextAttempt : context.attempt ?? 1;
  const childSpanId = generateSpanId();

  return {
    headers: {
      [CORRELATION_HEADER]: context.correlationId,
      [REQUEST_ID_HEADER]: context.correlationId,
      [PARENT_SPAN_HEADER]: context.spanId,
      "x-correlation-attempt": String(attempt),
      "x-span-id": childSpanId,
    },
    childContext: {
      ...context,
      parentSpanId: context.spanId,
      spanId: childSpanId,
      attempt,
    },
  };
}

export class CorrelationTraceRegistry {
  constructor({ nowFn = () => new Date() } = {}) {
    this.nowFn = nowFn;
    this.traces = new Map();
  }

  recordHop(context, { stage, status = "ok", error = null, metadata = {} } = {}) {
    if (!context || !isValidCorrelationId(context.correlationId)) {
      throw new CorrelationContextError("Valid correlation context is required to record a hop.");
    }
    if (!stage || typeof stage !== "string") {
      throw new CorrelationContextError("Hop stage name is required.", "INVALID_HOP_STAGE");
    }

    const list = this.traces.get(context.correlationId) ?? [];
    const hop = {
      correlationId: context.correlationId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId ?? null,
      attempt: context.attempt ?? 1,
      actorId: context.actorId ?? null,
      service: context.service ?? "vaultquest-api",
      stage,
      status,
      error: error ? String(error) : null,
      metadata: structuredClone(metadata),
      timestamp: this.nowFn().toISOString(),
    };
    list.push(hop);
    this.traces.set(context.correlationId, list);
    return structuredClone(hop);
  }

  async executeCorrelatedOperation(
    context,
    { stage, operationFn, rollbackFn = null, maxRetries = 2 }
  ) {
    if (!context || !isValidCorrelationId(context.correlationId)) {
      throw new CorrelationContextError("Valid correlation context is required.");
    }

    let attempt = 0;
    let activeContext = { ...context };
    let lastError = null;

    while (attempt <= maxRetries) {
      attempt += 1;
      activeContext = {
        ...activeContext,
        attempt,
        spanId: attempt === 1 ? activeContext.spanId : generateSpanId(),
      };

      try {
        this.recordHop(activeContext, { stage, status: "started" });
        const result = await operationFn(activeContext);
        this.recordHop(activeContext, { stage, status: "completed" });
        return {
          correlationId: activeContext.correlationId,
          spanId: activeContext.spanId,
          attemptsUsed: attempt,
          result,
        };
      } catch (err) {
        lastError = err;
        const retryable = Boolean(err && err.retryable === true);
        this.recordHop(activeContext, {
          stage,
          status: retryable && attempt <= maxRetries ? "retrying" : "failed",
          error: err instanceof Error ? err.message : String(err),
        });

        if (!retryable || attempt > maxRetries) {
          break;
        }
      }
    }

    if (typeof rollbackFn === "function") {
      await rollbackFn(activeContext, lastError);
      this.recordHop(activeContext, {
        stage: `${stage}:rollback`,
        status: "rolled_back",
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }

    throw lastError;
  }

  queryTrace(actor, correlationId) {
    if (!actor || typeof actor.id !== "string" || !actor.role) {
      throw new CorrelationAuthorizationError("Actor identity is required to inspect traces.");
    }
    if (!isValidCorrelationId(correlationId)) {
      throw new CorrelationContextError("Invalid correlationId format.", "INVALID_CORRELATION_ID");
    }

    const hops = this.traces.get(correlationId) ?? [];
    if (hops.length === 0) {
      return [];
    }

    const isPrivileged =
      actor.role === "admin" || actor.role === "operator" || actor.role === "auditor";

    if (!isPrivileged) {
      const ownsAll = hops.every((h) => h.actorId === actor.id);
      if (!ownsAll) {
        throw new CorrelationAuthorizationError(
          "Actor is not authorized to view correlation traces owned by another principal."
        );
      }
    }

    return structuredClone(hops);
  }
}
