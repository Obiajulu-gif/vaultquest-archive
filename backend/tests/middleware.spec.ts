import { describe, it, expect } from "vitest";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import correlation from "../src/middleware/correlation.js";
import { requireServiceAuth } from "../src/middleware/service-auth.js";

describe("correlation middleware", () => {
  it("generates a correlation id when none provided", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({ method: "GET", url: "/echo" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["correlation-id"]).toBeDefined();
    expect(res.json().id).toBe(res.headers["correlation-id"]);
    await app.close();
  });

  it("echoes an incoming correlation id", async () => {
    const app = Fastify();
    await app.register(correlation);
    app.get("/echo", async (req: FastifyRequest) => ({ id: req.correlationId }));
    const res = await app.inject({
      method: "GET",
      url: "/echo",
      headers: { "correlation-id": "abc-123" }
    });
    expect(res.headers["correlation-id"]).toBe("abc-123");
    await app.close();
  });
});

describe("service-auth middleware", () => {
  it("rejects missing secret", async () => {
    const app = Fastify();
    const guard = requireServiceAuth("top-secret");
    app.post("/internal", { preHandler: guard }, async () => ({ ok: true }));
    app.setErrorHandler((err: Error, _req: FastifyRequest, reply: FastifyReply) => {
      if (err.name === "AppError") {
        reply.status((err as unknown as { statusCode: number }).statusCode).send({ error: err.message });
        return;
      }
      reply.status(500).send({ error: "x" });
    });
    const res = await app.inject({ method: "POST", url: "/internal" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts correct secret", async () => {
    const app = Fastify();
    const guard = requireServiceAuth("top-secret");
    app.post("/internal", { preHandler: guard }, async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/internal",
      headers: { "x-internal-secret": "top-secret" }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("rejects a near-miss secret (last character differs) — issue #584", async () => {
    const app = Fastify();
    const guard = requireServiceAuth("top-secret");
    app.post("/internal", { preHandler: guard }, async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/internal",
      headers: { "x-internal-secret": "top-secrex" }
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a secret of a different length without throwing — issue #584", async () => {
    const app = Fastify();
    const guard = requireServiceAuth("top-secret");
    app.post("/internal", { preHandler: guard }, async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/internal",
      headers: { "x-internal-secret": "top-secret-but-much-longer" }
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("etag middleware", () => {
  it("computes ETags for public GET routes and returns 304 on match", async () => {
    const app = Fastify();
    const { etagPlugin } = await import("../src/middleware/etag.js");
    await app.register(etagPlugin);
    app.get("/api/metrics", async () => ({ status: "ok", count: 42 }));
    
    // First request
    const res1 = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(res1.statusCode).toBe(200);
    const etag = res1.headers["etag"] as string;
    expect(etag).toBeDefined();
    expect(res1.headers["cache-control"]).toBe("public, no-cache");

    // Second request with If-None-Match
    const res2 = await app.inject({
      method: "GET",
      url: "/api/metrics",
      headers: { "if-none-match": etag }
    });
    expect(res2.statusCode).toBe(304);
    expect(res2.body).toBe("");
    await app.close();
  });

  it("forces private cache headers for private GET routes", async () => {
    const app = Fastify();
    const { etagPlugin } = await import("../src/middleware/etag.js");
    await app.register(etagPlugin);
    app.get("/saved-pools", async () => ({ items: [] }));
    const res = await app.inject({ method: "GET", url: "/saved-pools" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store, no-cache, must-revalidate");
    expect(res.headers["etag"]).toBeUndefined();
    await app.close();
  });
});
