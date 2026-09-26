import { describe, it, expect, vi } from "vitest";

vi.mock("@prisma/client", () => ({
  PrismaClient: class {}
}));
import Fastify from "fastify";
import { csrfProtection } from "../src/middleware/csrfProtection.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

describe("CSRF Protection Middleware", () => {
  const buildTestApp = () => {
    const app = Fastify();
    app.register(csrfProtection);
    app.setErrorHandler(errorHandler);

    app.get("/test", async () => ({ ok: true }));
    app.post("/test", async () => ({ ok: true }));
    app.post("/internal/test", async () => ({ ok: true }));

    return app;
  };

  it("sets a CSRF token cookie and header on GET requests", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/test" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-csrf-token"]).toBeDefined();
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(res.headers["set-cookie"]).toContain("csrf-token=");
    await app.close();
  });

  it("blocks POST requests without a valid CSRF token with 403 Forbidden", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/test", payload: {} });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("CSRF");
    await app.close();
  });

  it("allows POST requests with matching CSRF cookie and header", async () => {
    const app = buildTestApp();

    const getRes = await app.inject({ method: "GET", url: "/test" });
    const csrfToken = getRes.headers["x-csrf-token"] as string;
    const setCookie = getRes.headers["set-cookie"] as string;

    const postRes = await app.inject({
      method: "POST",
      url: "/test",
      headers: {
        "x-csrf-token": csrfToken,
        cookie: setCookie
      },
      payload: {}
    });

    expect(postRes.statusCode).toBe(200);
    await app.close();
  });

  it("skips CSRF check for internal routes (/internal/*)", async () => {
    const app = buildTestApp();

    const res = await app.inject({
      method: "POST",
      url: "/internal/test",
      payload: {}
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
