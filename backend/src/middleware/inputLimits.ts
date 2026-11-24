/**
 * Input size and cardinality validation middleware (#1089).
 *
 * Enforces strict limits on request payloads to prevent resource exhaustion,
 * DoS attacks, and unbounded memory consumption. All limits are enforced
 * before business logic runs, ensuring predictable memory and CPU usage.
 *
 * Acceptance criteria:
 * - Cover normal, failure, retry, and authorization paths.
 * - Add automated tests with boundary conditions.
 * - Document edge cases and recovery behavior.
 * - Preserve existing contracts (backward-compatible validation).
 */

import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { AppError } from "../errors.js";

export interface InputLimits {
  /** Maximum request body size in bytes (default: 1MB) */
  maxBodySize?: number;
  /** Maximum number of array elements in request body */
  maxArrayLength?: number;
  /** Maximum string length in request body */
  maxStringLength?: number;
  /** Maximum object nesting depth */
  maxObjectDepth?: number;
  /** Maximum number of object keys */
  maxObjectKeys?: number;
  /** Maximum query parameter count */
  maxQueryParams?: number;
  /** Maximum query parameter value length */
  maxQueryValueLength?: number;
}

export interface InputSizeValidationResult {
  valid: boolean;
  violations: string[];
  metrics: {
    bodySize: number;
    maxArrayLength: number;
    maxStringLength: number;
    maxObjectDepth: number;
    totalKeys: number;
  };
}

/** Default conservative limits suitable for most API endpoints */
export const DEFAULT_INPUT_LIMITS: Required<InputLimits> = {
  maxBodySize: 1024 * 1024, // 1MB
  maxArrayLength: 1000,
  maxStringLength: 10000,
  maxObjectDepth: 10,
  maxObjectKeys: 500,
  maxQueryParams: 50,
  maxQueryValueLength: 2000,
};

/** Stricter limits for sensitive administrative endpoints */
export const STRICT_INPUT_LIMITS: Required<InputLimits> = {
  maxBodySize: 512 * 1024, // 512KB
  maxArrayLength: 100,
  maxStringLength: 5000,
  maxObjectDepth: 5,
  maxObjectKeys: 100,
  maxQueryParams: 20,
  maxQueryValueLength: 1000,
};

/** More permissive limits for bulk import/export operations */
export const BULK_INPUT_LIMITS: Required<InputLimits> = {
  maxBodySize: 10 * 1024 * 1024, // 10MB
  maxArrayLength: 10000,
  maxStringLength: 50000,
  maxObjectDepth: 15,
  maxObjectKeys: 5000,
  maxQueryParams: 100,
  maxQueryValueLength: 5000,
};

/**
 * Validates input size and cardinality constraints against configured limits.
 * Returns detailed validation results for observability and debugging.
 */
export function validateInputSize(
  value: unknown,
  limits: Required<InputLimits>,
  path = "body"
): InputSizeValidationResult {
  const violations: string[] = [];
  const metrics = {
    bodySize: 0,
    maxArrayLength: 0,
    maxStringLength: 0,
    maxObjectDepth: 0,
    totalKeys: 0,
  };

  function traverse(val: unknown, depth: number, currentPath: string): void {
    if (depth > limits.maxObjectDepth) {
      violations.push(
        `${currentPath}: exceeds maximum nesting depth (${depth} > ${limits.maxObjectDepth})`
      );
      return; // Stop traversing to prevent stack overflow
    }

    metrics.maxObjectDepth = Math.max(metrics.maxObjectDepth, depth);

    if (val === null || val === undefined) {
      return;
    }

    if (typeof val === "string") {
      metrics.maxStringLength = Math.max(metrics.maxStringLength, val.length);
      metrics.bodySize += val.length * 2; // Approximate UTF-16 encoding

      if (val.length > limits.maxStringLength) {
        violations.push(
          `${currentPath}: string length ${val.length} exceeds limit ${limits.maxStringLength}`
        );
      }
      return;
    }

    if (typeof val === "number" || typeof val === "boolean") {
      metrics.bodySize += 8; // Approximate size
      return;
    }

    if (Array.isArray(val)) {
      metrics.maxArrayLength = Math.max(metrics.maxArrayLength, val.length);
      metrics.bodySize += val.length * 8; // Array overhead

      if (val.length > limits.maxArrayLength) {
        violations.push(
          `${currentPath}: array length ${val.length} exceeds limit ${limits.maxArrayLength}`
        );
      }

      val.forEach((item, index) => {
        traverse(item, depth + 1, `${currentPath}[${index}]`);
      });
      return;
    }

    if (typeof val === "object") {
      const keys = Object.keys(val);
      metrics.totalKeys += keys.length;
      metrics.bodySize += keys.length * 50; // Key overhead estimate

      if (metrics.totalKeys > limits.maxObjectKeys) {
        violations.push(
          `${currentPath}: total object keys ${metrics.totalKeys} exceeds limit ${limits.maxObjectKeys}`
        );
      }

      keys.forEach((key) => {
        traverse((val as Record<string, unknown>)[key], depth + 1, `${currentPath}.${key}`);
      });
    }
  }

  traverse(value, 0, path);

  if (metrics.bodySize > limits.maxBodySize) {
    violations.push(
      `Estimated body size ${metrics.bodySize} bytes exceeds limit ${limits.maxBodySize} bytes`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
    metrics,
  };
}

/**
 * Fastify preHandler middleware that enforces input size and cardinality limits.
 * Returns 413 (Payload Too Large) when limits are exceeded, with detailed
 * violation messages for debugging (redacted in production).
 *
 * @example
 * ```typescript
 * fastify.post('/api/data', {
 *   preHandler: enforceInputLimits(DEFAULT_INPUT_LIMITS),
 * }, handler);
 * ```
 */
export function enforceInputLimits(
  limits: InputLimits = {},
  options: { validateQuery?: boolean; redactViolations?: boolean } = {}
): preHandlerHookHandler {
  const resolvedLimits: Required<InputLimits> = {
    ...DEFAULT_INPUT_LIMITS,
    ...limits,
  };

  return async function inputLimitsGuard(req: FastifyRequest): Promise<void> {
    // Validate request body
    if (req.body !== undefined && req.body !== null) {
      const result = validateInputSize(req.body, resolvedLimits, "body");

      if (!result.valid) {
        req.log.warn(
          {
            event: "input_limits_exceeded",
            url: req.url,
            method: req.method,
            violations: result.violations,
            metrics: result.metrics,
          },
          "request body exceeds input limits"
        );

        const message = options.redactViolations
          ? "Request body exceeds size or complexity limits"
          : `Input validation failed: ${result.violations.join("; ")}`;

        throw AppError.payloadTooLarge(message, {
          violations: options.redactViolations ? undefined : result.violations,
          limits: resolvedLimits,
        });
      }

      req.log.debug(
        {
          event: "input_limits_validated",
          url: req.url,
          metrics: result.metrics,
        },
        "request body passed input limits validation"
      );
    }

    // Validate query parameters if enabled
    if (options.validateQuery && req.query) {
      const queryKeys = Object.keys(req.query);

      if (queryKeys.length > resolvedLimits.maxQueryParams) {
        req.log.warn(
          {
            event: "query_params_exceeded",
            url: req.url,
            count: queryKeys.length,
            limit: resolvedLimits.maxQueryParams,
          },
          "query parameter count exceeds limit"
        );

        throw AppError.validation(
          `Query parameter count ${queryKeys.length} exceeds limit ${resolvedLimits.maxQueryParams}`,
          undefined,
          [{ path: "query", message: "Too many query parameters" }]
        );
      }

      for (const [key, value] of Object.entries(req.query)) {
        const stringValue = String(value);
        if (stringValue.length > resolvedLimits.maxQueryValueLength) {
          req.log.warn(
            {
              event: "query_value_too_long",
              url: req.url,
              key,
              length: stringValue.length,
              limit: resolvedLimits.maxQueryValueLength,
            },
            "query parameter value exceeds length limit"
          );

          throw AppError.validation(
            `Query parameter '${key}' length ${stringValue.length} exceeds limit ${resolvedLimits.maxQueryValueLength}`,
            undefined,
            [{ path: `query.${key}`, message: "Value too long" }]
          );
        }
      }
    }
  };
}

/**
 * Returns input limits appropriate for the endpoint's authorization level.
 * Administrative endpoints get stricter limits to reduce attack surface.
 */
export function limitsForPermission(permission: string | null | undefined): Required<InputLimits> {
  if (permission && permission.startsWith("admin.")) {
    return STRICT_INPUT_LIMITS;
  }
  return DEFAULT_INPUT_LIMITS;
}

/**
 * Utility to check if a value would exceed cardinality limits without
 * full validation. Useful for early rejection in streaming/chunked scenarios.
 */
export function quickCardinalityCheck(
  value: unknown,
  limits: Required<InputLimits>
): { ok: boolean; reason?: string } {
  if (Array.isArray(value) && value.length > limits.maxArrayLength) {
    return { ok: false, reason: `Array length ${value.length} exceeds limit` };
  }

  if (typeof value === "string" && value.length > limits.maxStringLength) {
    return { ok: false, reason: `String length ${value.length} exceeds limit` };
  }

  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    if (keys.length > limits.maxObjectKeys) {
      return { ok: false, reason: `Object key count ${keys.length} exceeds limit` };
    }
  }

  return { ok: true };
}
