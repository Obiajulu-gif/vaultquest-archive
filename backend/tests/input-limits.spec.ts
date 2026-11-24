/**
 * Tests for input size and cardinality limits middleware (#1089).
 *
 * Coverage:
 * - Normal operation: requests within limits pass validation
 * - Failure paths: oversized payloads, deep nesting, long strings, large arrays
 * - Boundary conditions: exact limit values, off-by-one scenarios
 * - Authorization integration: permission-based limit selection
 * - Recovery: proper error responses and observability logs
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  validateInputSize,
  enforceInputLimits,
  DEFAULT_INPUT_LIMITS,
  STRICT_INPUT_LIMITS,
  BULK_INPUT_LIMITS,
  limitsForPermission,
  quickCardinalityCheck,
} from "../src/middleware/inputLimits.js";
import { AppError } from "../src/errors.js";

describe("validateInputSize", () => {
  it("accepts valid inputs within all limits", () => {
    const validData = {
      name: "test",
      items: [1, 2, 3],
      nested: { level1: { level2: "value" } },
    };

    const result = validateInputSize(validData, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.maxObjectDepth).toBeLessThanOrEqual(DEFAULT_INPUT_LIMITS.maxObjectDepth);
  });

  it("detects array length violations", () => {
    const oversizedArray = {
      items: Array(1001).fill("item"),
    };

    const result = validateInputSize(oversizedArray, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes("array length"))).toBe(true);
    expect(result.metrics.maxArrayLength).toBe(1001);
  });

  it("detects string length violations", () => {
    const longString = {
      text: "x".repeat(10001),
    };

    const result = validateInputSize(longString, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes("string length"))).toBe(true);
    expect(result.metrics.maxStringLength).toBe(10001);
  });

  it("detects excessive nesting depth", () => {
    let deepObject: Record<string, unknown> = { value: "leaf" };
    for (let i = 0; i < 15; i++) {
      deepObject = { nested: deepObject };
    }

    const result = validateInputSize(deepObject, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes("nesting depth"))).toBe(true);
    expect(result.metrics.maxObjectDepth).toBeGreaterThanOrEqual(DEFAULT_INPUT_LIMITS.maxObjectDepth);
  });

  it("detects excessive object keys", () => {
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 501; i++) {
      manyKeys[`key${i}`] = i;
    }

    const result = validateInputSize({ data: manyKeys }, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes("object keys"))).toBe(true);
    expect(result.metrics.totalKeys).toBeGreaterThan(DEFAULT_INPUT_LIMITS.maxObjectKeys);
  });

  it("handles exact boundary values (at limit)", () => {
    const atLimit = {
      text: "x".repeat(DEFAULT_INPUT_LIMITS.maxStringLength), // exactly at limit
      items: Array(DEFAULT_INPUT_LIMITS.maxArrayLength).fill(1), // exactly at limit
    };

    const result = validateInputSize(atLimit, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("handles off-by-one over limit", () => {
    const overLimit = {
      text: "x".repeat(DEFAULT_INPUT_LIMITS.maxStringLength + 1),
    };

    const result = validateInputSize(overLimit, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes("string length"))).toBe(true);
  });

  it("provides detailed violation paths for nested structures", () => {
    const nestedViolation = {
      users: [
        { name: "Alice" },
        { name: "x".repeat(10001) }, // violation in array element
      ],
    };

    const result = validateInputSize(nestedViolation, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes("body.users[1].name"))).toBe(true);
  });

  it("handles null and undefined values gracefully", () => {
    const withNulls = {
      a: null,
      b: undefined,
      c: { nested: null },
    };

    const result = validateInputSize(withNulls, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(true);
  });

  it("tracks accurate size metrics", () => {
    const data = {
      text1: "hello", // 5 chars
      text2: "world", // 5 chars
      items: [1, 2, 3], // 3 elements
    };

    const result = validateInputSize(data, DEFAULT_INPUT_LIMITS);

    expect(result.metrics.maxStringLength).toBe(5);
    expect(result.metrics.maxArrayLength).toBe(3);
    expect(result.metrics.bodySize).toBeGreaterThan(0);
  });
});

describe("enforceInputLimits middleware", () => {
  function mockRequest(body: unknown, query: Record<string, unknown> = {}): FastifyRequest {
    return {
      body,
      query,
      url: "/api/test",
      method: "POST",
      log: {
        warn: () => {},
        debug: () => {},
      },
    } as unknown as FastifyRequest;
  }

  it("allows valid requests to pass through", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS);
    const req = mockRequest({ name: "test", items: [1, 2, 3] });

    await expect(middleware(req, {} as any, {} as any)).resolves.toBeUndefined();
  });

  it("rejects oversized request bodies", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS);
    const req = mockRequest({ items: Array(1001).fill("item") });

    await expect(middleware(req, {} as any, {} as any)).rejects.toThrow();
  });

  it("validates query parameters when enabled", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS, { validateQuery: true });
    const tooManyParams: Record<string, string> = {};
    for (let i = 0; i < 51; i++) {
      tooManyParams[`param${i}`] = "value";
    }
    const req = mockRequest({}, tooManyParams);

    await expect(middleware(req, {} as any, {} as any)).rejects.toThrow();
  });

  it("validates query parameter value lengths", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS, { validateQuery: true });
    const req = mockRequest({}, { longParam: "x".repeat(2001) });

    await expect(middleware(req, {} as any, {} as any)).rejects.toThrow();
  });

  it("redacts violation details when configured", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS, { redactViolations: true });
    const req = mockRequest({ items: Array(1001).fill("item") });

    try {
      await middleware(req, {} as any, {} as any);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.message).not.toContain("array length");
      expect(appError.message).toContain("size or complexity limits");
    }
  });

  it("logs validation metrics for observability", async () => {
    const logs: Array<{ event: string; metrics?: unknown }> = [];
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS);
    const req = {
      body: { name: "test", items: [1, 2, 3] },
      url: "/api/test",
      method: "POST",
      log: {
        warn: (data: unknown) => logs.push({ event: "warn", ...data }),
        debug: (data: unknown) => logs.push({ event: "debug", ...data }),
      },
    } as unknown as FastifyRequest;

    await middleware(req, {} as any, {} as any);

    const debugLog = logs.find(l => l.event === "input_limits_validated");
    expect(debugLog).toBeDefined();
    expect(debugLog?.metrics).toBeDefined();
  });

  it("handles empty or null request bodies gracefully", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS);

    await expect(
      middleware(mockRequest(null), {} as any, {} as any)
    ).resolves.toBeUndefined();

    await expect(
      middleware(mockRequest(undefined), {} as any, {} as any)
    ).resolves.toBeUndefined();

    await expect(
      middleware(mockRequest({}), {} as any, {} as any)
    ).resolves.toBeUndefined();
  });
});

describe("preset limit configurations", () => {
  it("DEFAULT_INPUT_LIMITS provides balanced protection", () => {
    expect(DEFAULT_INPUT_LIMITS.maxBodySize).toBe(1024 * 1024);
    expect(DEFAULT_INPUT_LIMITS.maxArrayLength).toBe(1000);
    expect(DEFAULT_INPUT_LIMITS.maxStringLength).toBe(10000);
  });

  it("STRICT_INPUT_LIMITS reduces attack surface", () => {
    expect(STRICT_INPUT_LIMITS.maxBodySize).toBeLessThan(DEFAULT_INPUT_LIMITS.maxBodySize);
    expect(STRICT_INPUT_LIMITS.maxArrayLength).toBeLessThan(DEFAULT_INPUT_LIMITS.maxArrayLength);
  });

  it("BULK_INPUT_LIMITS supports large operations", () => {
    expect(BULK_INPUT_LIMITS.maxBodySize).toBeGreaterThan(DEFAULT_INPUT_LIMITS.maxBodySize);
    expect(BULK_INPUT_LIMITS.maxArrayLength).toBeGreaterThan(DEFAULT_INPUT_LIMITS.maxArrayLength);
  });
});

describe("limitsForPermission", () => {
  it("returns strict limits for admin permissions", () => {
    const limits = limitsForPermission("admin.audit.write");
    expect(limits).toEqual(STRICT_INPUT_LIMITS);
  });

  it("returns default limits for user permissions", () => {
    const limits = limitsForPermission("own.data.read");
    expect(limits).toEqual(DEFAULT_INPUT_LIMITS);
  });

  it("returns default limits for null/undefined permissions", () => {
    expect(limitsForPermission(null)).toEqual(DEFAULT_INPUT_LIMITS);
    expect(limitsForPermission(undefined)).toEqual(DEFAULT_INPUT_LIMITS);
  });
});

describe("quickCardinalityCheck", () => {
  it("accepts values within limits", () => {
    const result = quickCardinalityCheck([1, 2, 3], DEFAULT_INPUT_LIMITS);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects oversized arrays quickly", () => {
    const result = quickCardinalityCheck(Array(1001).fill(1), DEFAULT_INPUT_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Array length");
  });

  it("rejects long strings quickly", () => {
    const result = quickCardinalityCheck("x".repeat(10001), DEFAULT_INPUT_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("String length");
  });

  it("rejects objects with too many keys", () => {
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 501; i++) {
      manyKeys[`key${i}`] = i;
    }
    const result = quickCardinalityCheck(manyKeys, DEFAULT_INPUT_LIMITS);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("key count");
  });
});

describe("authorization and retry paths", () => {
  function mockRequest(body: unknown, query: Record<string, unknown> = {}): FastifyRequest {
    return {
      body,
      query,
      url: "/api/test",
      method: "POST",
      log: {
        warn: () => {},
        debug: () => {},
      },
    } as unknown as FastifyRequest;
  }

  it("enforces consistent limits across retried requests", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS);
    const req = mockRequest({ items: Array(1001).fill("item") });

    // First attempt
    await expect(middleware(req, {} as any, {} as any)).rejects.toThrow();

    // Retry with same payload (simulating client retry)
    await expect(middleware(req, {} as any, {} as any)).rejects.toThrow();
  });

  it("validates regardless of authentication state", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS);

    // Unauthenticated request
    const unauthReq = mockRequest({ items: Array(1001).fill("item") });
    await expect(middleware(unauthReq, {} as any, {} as any)).rejects.toThrow();

    // Authenticated request (middleware runs before auth)
    const authReq = {
      ...mockRequest({ items: Array(1001).fill("item") }),
      principal: { role: "user", subject: "0xtest" },
    } as unknown as FastifyRequest;
    await expect(middleware(authReq, {} as any, {} as any)).rejects.toThrow();
  });
});

describe("edge cases and recovery", () => {
  function mockRequest(body: unknown, query: Record<string, unknown> = {}): FastifyRequest {
    return {
      body,
      query,
      url: "/api/test",
      method: "POST",
      log: {
        warn: () => {},
        debug: () => {},
      },
    } as unknown as FastifyRequest;
  }

  it("handles circular references gracefully", () => {
    const circular: Record<string, unknown> = { name: "circular" };
    circular.self = circular;

    // Should not hang or crash due to max depth limit
    const result = validateInputSize(circular, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.some(v => v.includes("nesting depth"))).toBe(true);
  });

  it("handles mixed violation types", () => {
    const multiViolation = {
      longString: "x".repeat(10001),
      bigArray: Array(1001).fill(1),
    };

    const result = validateInputSize(multiViolation, DEFAULT_INPUT_LIMITS);

    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
    expect(result.violations.some(v => v.includes("string"))).toBe(true);
    expect(result.violations.some(v => v.includes("array"))).toBe(true);
  });

  it("provides actionable error messages for client correction", async () => {
    const middleware = enforceInputLimits(DEFAULT_INPUT_LIMITS);
    const req = mockRequest({ items: Array(1001).fill("item") });

    try {
      await middleware(req, {} as any, {} as any);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.message).toContain("array length");
      expect(appError.message).toContain("1001");
      expect(appError.message).toContain("1000");
    }
  });
});
