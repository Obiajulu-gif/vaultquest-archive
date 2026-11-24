import Fastify from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { ERROR_CODES } from "../src/constants.js";
import { ERROR_CATALOG } from "../src/errorTaxonomy.js";
import { acceptsProblemDetails, formatProblemDetails, PROBLEM_TYPE_BASE_URI } from "../src/problemDetails.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import correlation from "../src/middleware/correlation.js";

const toProblemDetails = (code: string, status: number, message: string, errorId: string) => formatProblemDetails(code, status, { message, errorId });

const app = Fastify();
app.register(correlation);
app.setErrorHandler(errorHandler);
app.get("/ok", async () => ({ data: "ok" }));
app.get("/auth", async () => { throw AppError.unauthorized(); });
app.get("/denied", async () => { throw AppError.forbidden(); });
app.get("/invalid", async () => { throw AppError.validation("Correct the amount"); });
app.get("/boom", async () => { throw new AppError(ERROR_CODES.INTERNAL, 500, "secret SQL", "secret detail", ["secret issue"]); });
app.get("/limited", async () => { throw Object.assign(new Error("limit"), { statusCode: 429, retryAfter: 12 }); });
let attempts = 0;
app.get("/retry", async () => {
  if (attempts++ === 0) throw new AppError(ERROR_CODES.NETWORK_ERROR, 503, "secret RPC");
  return { data: "recovered" };
});
afterEach(() => { attempts = 0; });
afterAll(async () => { await app.close(); });

describe("problem details", () => {
  it("has stable unique types and catalog titles for every registered code", () => {
    const types = new Set();
    for (const [code, descriptor] of Object.entries(ERROR_CATALOG)) {
      const problem = toProblemDetails(code, 400, "message", "id");
      expect(problem.title).toBeTruthy();
      expect(problem.category).toBe(descriptor.category);
      expect(types.has(problem.type)).toBe(false);
      types.add(problem.type);
    }
  });
  it("requires explicit acceptable opt-in and respects JSON preference", () => {
    for (const accept of [undefined, "*/*", "application/json", "application/problem+json;q=0", "application/problem+json;q=garbage", "application/problem+json;q=0.2,application/json;q=0.9"]) {
      expect(acceptsProblemDetails(accept)).toBe(false);
    }
    expect(acceptsProblemDetails("application/problem+json; q=0.9, application/json;q=0.2")).toBe(true);
  });
  it("preserves legacy responses and successful responses", async () => {
    const legacy = await app.inject({ url: "/auth" });
    expect(legacy.json().error.code).toBe("UNAUTHORIZED");
    expect(legacy.headers["content-type"]).toContain("application/json");
    expect((await app.inject({ url: "/ok", headers: { accept: "application/problem+json" } })).json()).toEqual({ data: "ok" });
  });
  it("honors media quality on actual error responses and omits query secrets", async () => {
    for (const accept of ["application/problem+json;q=0", "application/problem+json;q=0.2,application/json;q=0.9"]) {
      const res = await app.inject({ url: "/auth?token=private-query", headers: { accept } });
      expect(res.headers["content-type"]).toContain("application/json");
      expect(res.json().instance).toBe("/auth");
      expect(res.body).not.toContain("private-query");
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    }
  });
  it.each([["/auth", 401, "UNAUTHORIZED"], ["/denied", 403, "FORBIDDEN"], ["/invalid", 400, "INVALID_PAYLOAD"], ["/boom", 500, "INTERNAL"]] as const)("maps %s safely", async (url, status, code) => {
    const res = await app.inject({ url, headers: { accept: "application/problem+json" } });
    expect(res.statusCode).toBe(status);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.headers.vary).toContain("Accept");
    expect(res.json()).toMatchObject({ code, status, type: expect.stringContaining(PROBLEM_TYPE_BASE_URI), error_id: expect.any(String) });
    expect(res.body).not.toContain("secret");
  });
  it("retains retry headers and recovers on retry without changing success format", async () => {
    const limited = await app.inject({ url: "/limited", headers: { accept: "application/problem+json" } });
    expect(limited.headers["retry-after"]).toBe("12");
    expect(limited.json()).toMatchObject({ code: "RATE_LIMIT_EXCEEDED", retryable: true });
    const request = { url: "/retry", headers: { accept: "application/problem+json" } };
    expect((await app.inject(request)).json()).toMatchObject({ status: 503, retryable: true });
    expect((await app.inject(request)).json()).toEqual({ data: "recovered" });
  });
  it("normalizes unknown framework errors without leaking messages", () => {
    expect(toProblemDetails("FST_PRIVATE", 403, "secret", "id")).toMatchObject({ code: "FORBIDDEN", category: "authorization", retryable: false });
    expect(JSON.stringify(toProblemDetails("UNKNOWN", 500, "secret", "id"))).not.toContain("secret");
  });
  it("uses correlation IDs as opaque occurrence identifiers", async () => {
    const res = await app.inject({ url: "/auth", headers: { accept: "application/problem+json", "correlation-id": "request-123" } });
    expect(res.headers["correlation-id"]).toBe("request-123");
    expect(res.json()).toMatchObject({ error_id: "request-123", instance: "/auth" });
  });
});
