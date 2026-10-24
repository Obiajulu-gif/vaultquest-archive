import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { ERROR_CODES } from "../src/constants.js";
import {
  ERROR_CATALOG,
  ERROR_CATEGORIES,
  describeError,
  isKnownErrorCode,
  toUserSafeError
} from "../src/errorTaxonomy.js";
import { AppError } from "../src/errors.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import correlation from "../src/middleware/correlation.js";
import { validateBody, validateQuery } from "../src/middleware/validate.js";

describe("error catalog", () => {
  it("describes every ERROR_CODE with a valid category and message", () => {
    for (const code of Object.values(ERROR_CODES)) {
      const d = ERROR_CATALOG[code];
      expect(d, code).toBeDefined();
      expect(ERROR_CATEGORIES).toContain(d.category);
      expect(d.userMessage.length).toBeGreaterThan(0);
      expect(typeof d.retryable).toBe("boolean");
    }
  });

  it("does not describe codes that are not in ERROR_CODES", () => {
    expect(Object.keys(ERROR_CATALOG).sort()).toEqual(Object.values(ERROR_CODES).sort());
  });

  it("gives retryable codes recovery guidance", () => {
    for (const d of Object.values(ERROR_CATALOG)) {
      if (d.retryable) expect(d.recovery, d.userMessage).toBeTruthy();
    }
  });

  it("falls back to the internal descriptor for unknown codes", () => {
    expect(isKnownErrorCode("NOPE")).toBe(false);
    expect(isKnownErrorCode("constructor")).toBe(false);
    expect(describeError("NOPE")).toBe(ERROR_CATALOG[ERROR_CODES.INTERNAL]);
  });
});

describe("toUserSafeError", () => {
  it("exposes authored messages for exposable 4xx codes", () => {
    const e = toUserSafeError(ERROR_CODES.NOT_FOUND, 404, "Draw proof 7 not found");
    expect(e).toMatchObject({ code: "NOT_FOUND", category: "not_found", retryable: false });
    expect(e.message).toBe("Draw proof 7 not found");
  });

  it("hides internal messages for settlement errors", () => {
    const e = toUserSafeError(ERROR_CODES.SETTLEMENT_SUBMIT_FAILED, 500, "horizon tx_bad_seq GABC...");
    expect(e.category).toBe("settlement");
    expect(e.message).not.toContain("horizon");
    expect(e.retryable).toBe(true);
  });

  it("never exposes the caller message on 5xx", () => {
    const e = toUserSafeError(ERROR_CODES.NOT_FOUND, 500, "secret");
    expect(e.message).not.toBe("secret");
  });

  it("passes through unknown 4xx codes as non-retryable validation errors", () => {
    expect(toUserSafeError("FST_ERR_X", 415, "Unsupported Media Type")).toEqual({
      code: "FST_ERR_X",
      category: "validation",
      retryable: false,
      message: "Unsupported Media Type"
    });
    expect(toUserSafeError("FST_ERR_X", 400).message).toBe(ERROR_CATALOG[ERROR_CODES.HTTP_ERROR].userMessage);
  });

  it("collapses unknown 5xx codes to INTERNAL", () => {
    const e = toUserSafeError("WEIRD", 502, "stack at line 1");
    expect(e.code).toBe("INTERNAL");
    expect(e.message).not.toContain("stack");
  });
});

function buildTestApp() {
  const app = Fastify();
  app.register(correlation);
  app.setErrorHandler(errorHandler);
  app.get("/validation", async () => {
    z.object({ n: z.number() }).parse({ n: "x" });
  });
  app.post("/body", { preHandler: validateBody(z.object({ a: z.string() })) }, async () => ({ ok: true }));
  app.get("/query", { preHandler: validateQuery(z.object({ q: z.string() })) }, async () => ({ ok: true }));
  app.get("/unauthorized", async () => {
    throw AppError.unauthorized();
  });
  app.get("/forbidden", async () => {
    throw AppError.forbidden();
  });
  app.get("/settlement", async () => {
    throw new AppError(
      ERROR_CODES.SETTLEMENT_RETRIES_EXHAUSTED,
      502,
      "horizon returned tx_bad_seq for GABCDEF secret",
      "raw detail"
    );
  });
  app.get("/boom", async () => {
    throw new Error("connection to db at 10.0.0.5 failed: password=hunter2");
  });
  app.get("/prisma-unique", async () => {
    throw new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5" });
  });
  app.get("/prisma-missing", async () => {
    throw new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "5" });
  });
  app.get("/prisma-other", async () => {
    throw new Prisma.PrismaClientKnownRequestError("SELECT * FROM secrets", { code: "P1001", clientVersion: "5" });
  });
  app.get("/prisma-validation", async () => {
    throw new Prisma.PrismaClientValidationError("bad arg", { clientVersion: "5" });
  });
  app.get("/limited", async () => {
    const err: any = new Error("Rate limit exceeded");
    err.statusCode = 429;
    err.retryAfter = 30;
    throw err;
  });
  return app;
}

describe("errorHandler taxonomy integration", () => {
  const app = buildTestApp();

  it("validation errors keep issues and are not retryable", async () => {
    const res = await app.inject({ method: "GET", url: "/validation" });
    const { error } = res.json();
    expect(res.statusCode).toBe(400);
    expect(error).toMatchObject({
      code: "INVALID_PAYLOAD",
      category: "validation",
      retryable: false,
      status_code: 400
    });
    expect(error.recovery).toBeTruthy();
    expect(Array.isArray(error.issues)).toBe(true);
  });

  it("body and query validation middleware go through the handler with issues + error_id", async () => {
    const body = await app.inject({ method: "POST", url: "/body", payload: {} });
    expect(body.statusCode).toBe(400);
    expect(body.json().error).toMatchObject({ code: "INVALID_PAYLOAD", message: "Request body validation failed" });
    expect(body.json().error.issues.length).toBeGreaterThan(0);
    expect(body.json().error.error_id).toBeTruthy();

    const query = await app.inject({ method: "GET", url: "/query" });
    expect(query.json().error.message).toBe("Query parameter validation failed");
  });

  it("authorization errors map to stable codes with guidance", async () => {
    const u = await app.inject({ method: "GET", url: "/unauthorized" });
    expect(u.statusCode).toBe(401);
    expect(u.json().error).toMatchObject({ code: "UNAUTHORIZED", category: "authorization", retryable: false });
    expect(u.json().error.recovery).toContain("sign in");

    const f = await app.inject({ method: "GET", url: "/forbidden" });
    expect(f.statusCode).toBe(403);
    expect(f.json().error).toMatchObject({ code: "FORBIDDEN", category: "authorization" });
  });

  it("settlement errors hide internal detail but keep the stable code", async () => {
    const res = await app.inject({ method: "GET", url: "/settlement" });
    const raw = res.body;
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({
      code: "SETTLEMENT_RETRIES_EXHAUSTED",
      category: "settlement",
      retryable: false
    });
    expect(raw).not.toContain("horizon");
    expect(raw).not.toContain("GABCDEF");
    expect(res.json().error.recovery).toContain("support");
  });

  it("unexpected errors return INTERNAL without leaking internals and echo the correlation id", async () => {
    const res = await app.inject({ method: "GET", url: "/boom", headers: { "correlation-id": "corr-123" } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
    expect(res.body).not.toContain("10.0.0.5");
    const { error } = res.json();
    expect(error).toMatchObject({ code: "INTERNAL", category: "internal", retryable: true, error_id: "corr-123" });
    expect(res.headers["correlation-id"]).toBe("corr-123");
  });

  it("maps Prisma errors to safe codes", async () => {
    const unique = await app.inject({ method: "GET", url: "/prisma-unique" });
    expect(unique.statusCode).toBe(409);
    expect(unique.json().error.code).toBe("CONFLICT");
    const missing = await app.inject({ method: "GET", url: "/prisma-missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
    const other = await app.inject({ method: "GET", url: "/prisma-other" });
    expect(other.statusCode).toBe(500);
    expect(other.json().error).toMatchObject({ code: "DATABASE_ERROR", category: "dependency", retryable: true });
    expect(other.body).not.toContain("SELECT");
    const validation = await app.inject({ method: "GET", url: "/prisma-validation" });
    expect(validation.statusCode).toBe(400);
    expect(validation.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("rate limit responses are retryable and set Retry-After", async () => {
    const res = await app.inject({ method: "GET", url: "/limited" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("30");
    expect(res.json().error).toMatchObject({ code: "RATE_LIMIT_EXCEEDED", category: "rate_limit", retryable: true });
  });

  it("framework 4xx errors (unsupported media type) stay client-visible", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/body",
      headers: { "content-type": "text/weird" },
      payload: "x"
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error).toMatchObject({ category: "validation", retryable: false, status_code: 415 });
  });
});
