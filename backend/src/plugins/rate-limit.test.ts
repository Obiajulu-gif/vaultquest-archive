// backend/src/plugins/rate-limit.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import rateLimitPlugin from "./rate-limit.js";

async function buildTestApp(max = 3, timeWindow = 60_000) {
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(rateLimitPlugin, { max, timeWindow });
  app.get("/test", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("rate-limit plugin", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  beforeEach(async () => {
    app = await buildTestApp(3); // allow 3 req/window for fast test cycling
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows requests within the limit", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "GET", url: "/test" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("returns 429 when the limit is exceeded", async () => {
    // Exhaust quota
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: "/test" });
    }
    // Next request must be rejected
    const res = await app.inject({ method: "GET", url: "/test" });
    expect(res.statusCode).toBe(429);
  });

  it("429 body matches the standard shape", async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "GET", url: "/test" });
    }
    const res = await app.inject({ method: "GET", url: "/test" });
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      statusCode: 429,
      error: "Too Many Requests",
    });
    expect(typeof body.message).toBe("string");
    expect(typeof body.retryAfter).toBe("string");
  });

  it("uses X-Forwarded-For for key generation", async () => {
    // Requests from different IPs should each get their own quota bucket.
    const resA = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const resB = await app.inject({
      method: "GET",
      url: "/test",
      headers: { "x-forwarded-for": "5.6.7.8" },
    });
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);
  });
});
