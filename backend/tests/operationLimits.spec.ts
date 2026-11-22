import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  bodyWallet,
  chainPreHandlers,
  enforceOperationLimit,
  operationLimitsHook,
} from "../src/middleware/operationLimit.js";
import { AuditTrailService, InMemoryAuditTrailStore } from "../src/services/auditTrail.js";
import {
  DEFAULT_OPERATION_POLICIES,
  InMemoryLimitCounterStore,
  InMemoryLimitOverrideStore,
  LimitOverrideError,
  OperationLimitError,
  OperationLimitService,
  RedisLimitCounterStore,
  resolveOperationPolicies,
} from "../src/services/operationLimits.js";
import { ERROR_CODES } from "../src/constants.js";

// #815 — policy-based limits for expensive operations.

const T0 = Date.parse("2026-09-29T10:00:00.000Z"); // aligned to a minute boundary
const ADMIN = { subject: "GADMIN", role: "maintainer" as const };
const WALLET_A = "wallet:ga";
const WALLET_B = "wallet:gb";

function setup(overrideJson = '{"action.create":{"limit":3,"windowSeconds":60}}') {
  let now = T0;
  const clock = {
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
  const auditStore = new InMemoryAuditTrailStore();
  const svc = new OperationLimitService({
    policies: resolveOperationPolicies(overrideJson),
    counters: new InMemoryLimitCounterStore(() => now),
    overrides: new InMemoryLimitOverrideStore(),
    audit: new AuditTrailService(auditStore, { now: () => new Date(now) }),
    now: () => new Date(now),
  });
  return { svc, clock, auditStore };
}

describe("policy configuration (#815)", () => {
  it("covers every expensive operation with a resource classification and remediation", () => {
    const policies = resolveOperationPolicies();
    for (const policy of Object.values(policies)) {
      expect(policy.limit).toBeGreaterThan(0);
      expect(policy.windowMs).toBeGreaterThan(0);
      expect(policy.resources.length).toBeGreaterThan(0);
      expect(policy.remediation.length).toBeGreaterThan(10);
    }
    expect(Object.keys(policies).sort()).toEqual(Object.keys(DEFAULT_OPERATION_POLICIES).sort());
  });

  it("applies OPERATION_LIMITS overrides and rejects bad config at boot", () => {
    const p = resolveOperationPolicies('{"data.export":{"limit":2,"windowSeconds":30}}');
    expect(p["data.export"]).toMatchObject({ limit: 2, windowMs: 30_000 });
    expect(p["action.create"].limit).toBe(DEFAULT_OPERATION_POLICIES["action.create"].limit);
    // The shared defaults are never mutated.
    expect(DEFAULT_OPERATION_POLICIES["data.export"].limit).toBe(10);

    expect(() => resolveOperationPolicies("{nope")).toThrow(/valid JSON/);
    expect(() => resolveOperationPolicies('{"mint.everything":{"limit":1}}')).toThrow(/unknown operation/);
    expect(() => resolveOperationPolicies('{"action.create":{"limit":0}}')).toThrow(/positive integer/);
    expect(() => resolveOperationPolicies('{"action.create":{"windowSeconds":1.5}}')).toThrow(/positive integer/);
    expect(() => resolveOperationPolicies("[]")).toThrow(/JSON object/);
  });
});

describe("enforcement (#815)", () => {
  it("allows requests under the limit and reports remaining quota", async () => {
    const { svc } = setup();
    const decisions = [];
    for (let i = 0; i < 3; i++) decisions.push(await svc.enforce("action.create", WALLET_A));
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0]);
    expect(decisions.every((d) => d.allowed)).toBe(true);
    expect(decisions[0]!.resetAt).toBe(new Date(T0 + 60_000).toISOString());
  });

  it("rejects over-limit requests with a user-safe 429 and remediation", async () => {
    const { svc, clock } = setup();
    for (let i = 0; i < 3; i++) await svc.enforce("action.create", WALLET_A);
    clock.advance(18_000);

    const err = await svc.enforce("action.create", WALLET_A).catch((e) => e);
    expect(err).toBeInstanceOf(OperationLimitError);
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe(ERROR_CODES.OPERATION_LIMIT_EXCEEDED);
    expect(err.limitDetails).toEqual({
      operation: "action.create",
      limit: 3,
      window_seconds: 60,
      retry_after_seconds: 42,
      reset_at: new Date(T0 + 60_000).toISOString(),
      remediation: DEFAULT_OPERATION_POLICIES["action.create"].remediation,
    });
    expect(err.message).toContain("3 per minute");
  });

  it("keeps separate counters per scope key and per operation", async () => {
    const { svc } = setup();
    for (let i = 0; i < 3; i++) await svc.enforce("action.create", WALLET_A);
    await expect(svc.enforce("action.create", WALLET_A)).rejects.toBeInstanceOf(OperationLimitError);
    await expect(svc.enforce("action.create", WALLET_B)).resolves.toMatchObject({ allowed: true });
    await expect(svc.enforce("data.export", WALLET_A)).resolves.toMatchObject({ allowed: true });
  });

  it("resets when the window rolls over", async () => {
    const { svc, clock } = setup();
    for (let i = 0; i < 3; i++) await svc.enforce("action.create", WALLET_A);
    clock.set(T0 + 59_999);
    await expect(svc.enforce("action.create", WALLET_A)).rejects.toBeInstanceOf(OperationLimitError);
    clock.set(T0 + 60_000);
    await expect(svc.enforce("action.create", WALLET_A)).resolves.toMatchObject({ allowed: true, used: 1 });
  });

  it("explicit reset clears the window and is audited", async () => {
    const { svc, auditStore } = setup();
    for (let i = 0; i < 4; i++) await svc.consume("action.create", WALLET_A);
    await expect(svc.reset("action.create", WALLET_A, ADMIN, "")).rejects.toBeInstanceOf(LimitOverrideError);

    const after = await svc.reset("action.create", WALLET_A, ADMIN, "support ticket #42");
    expect(after.used).toBe(0);
    await expect(svc.enforce("action.create", WALLET_A)).resolves.toMatchObject({ allowed: true });

    const [record] = await auditStore.scan(0, 10);
    expect(record).toMatchObject({
      category: "limits",
      action: "limits.reset",
      actor: ADMIN,
      reason: "support ticket #42",
      target: { type: "limit_counter", id: "action.create:wallet:ga" },
      before: { used: 4, limit: 3 },
      after: { used: 0, limit: 3 },
    });
  });

  it("usage() reports without consuming", async () => {
    const { svc } = setup();
    await svc.consume("action.create", WALLET_A);
    expect(await svc.usage("action.create", WALLET_A)).toMatchObject({ used: 1, remaining: 2 });
    expect(await svc.usage("action.create", WALLET_A)).toMatchObject({ used: 1 });
  });
});

describe("overrides (#815)", () => {
  it("raises the limit only for the scoped operation and key, and is audited", async () => {
    const { svc, auditStore } = setup();
    const override = await svc.grantOverride(
      { operation: "action.create", scopeKey: WALLET_A, limit: 5, durationMs: 3_600_000, reason: "market maker onboarding" },
      ADMIN,
    );
    expect(override).toMatchObject({ limit: 5, grantedBy: "GADMIN", revokedAt: null });

    for (let i = 0; i < 5; i++) {
      await expect(svc.enforce("action.create", WALLET_A)).resolves.toMatchObject({ overrideId: override.id });
    }
    await expect(svc.enforce("action.create", WALLET_A)).rejects.toMatchObject({ limitDetails: expect.objectContaining({ limit: 5 }) });
    for (let i = 0; i < 3; i++) await svc.enforce("action.create", WALLET_B);
    await expect(svc.enforce("action.create", WALLET_B)).rejects.toBeInstanceOf(OperationLimitError);

    const [grant] = await auditStore.scan(0, 10);
    expect(grant).toMatchObject({
      category: "limits",
      action: "limits.override.grant",
      actor: ADMIN,
      reason: "market maker onboarding",
      target: { type: "limit_override", id: override.id },
      before: { operation: "action.create", scopeKey: WALLET_A, limit: 3 },
      after: { operation: "action.create", scopeKey: WALLET_A, limit: 5 },
    });
  });

  it("expires automatically", async () => {
    const { svc, clock } = setup();
    await svc.grantOverride({ operation: "action.create", scopeKey: WALLET_A, limit: 10, durationMs: 30_000, reason: "burst" }, ADMIN);
    expect((await svc.usage("action.create", WALLET_A)).limit).toBe(10);
    clock.advance(30_000);
    expect((await svc.usage("action.create", WALLET_A)).limit).toBe(3);
    expect(await svc.listOverrides({ activeOnly: true })).toHaveLength(0);
  });

  it("revocation restores the base limit and is audited; revoking twice fails", async () => {
    const { svc, auditStore } = setup();
    const o = await svc.grantOverride({ operation: "action.create", scopeKey: WALLET_A, limit: 10, durationMs: 60_000, reason: "burst" }, ADMIN);
    const revoked = await svc.revokeOverride(o.id, ADMIN, "no longer needed");
    expect(revoked).toMatchObject({ revokedBy: "GADMIN" });
    expect((await svc.usage("action.create", WALLET_A)).limit).toBe(3);
    await expect(svc.revokeOverride(o.id, ADMIN, "again")).rejects.toBeInstanceOf(LimitOverrideError);
    await expect(svc.revokeOverride("missing", ADMIN, "x")).rejects.toMatchObject({ code: "NOT_FOUND" });

    const last = (await auditStore.query({ limit: 1 }))[0]!;
    expect(last).toMatchObject({ action: "limits.override.revoke", reason: "no longer needed", before: { limit: 10 }, after: { limit: 3 } });
  });

  it("allows one active override per operation and scope key", async () => {
    const { svc } = setup();
    const input = { operation: "action.create" as const, scopeKey: WALLET_A, limit: 5, durationMs: 60_000, reason: "burst" };
    await svc.grantOverride(input, ADMIN);
    await expect(svc.grantOverride(input, ADMIN)).rejects.toMatchObject({ code: "OVERRIDE_EXISTS" });
    await expect(svc.grantOverride({ ...input, scopeKey: WALLET_B }, ADMIN)).resolves.toBeTruthy();
  });

  it("validates overrides", async () => {
    const { svc } = setup();
    const ok = { operation: "action.create" as const, scopeKey: WALLET_A, limit: 5, durationMs: 60_000, reason: "burst" };
    for (const bad of [
      { ...ok, limit: 0 },
      { ...ok, limit: 3 * 100 + 1 },
      { ...ok, durationMs: 31 * 24 * 3_600_000 },
      { ...ok, reason: "" },
      { ...ok, scopeKey: "everyone" },
      { ...ok, operation: "mint.everything" as never },
    ]) {
      await expect(svc.grantOverride(bad, ADMIN)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
  });
});

describe("counter stores (#815)", () => {
  it("in-memory counters expire with their window", async () => {
    let now = 0;
    const store = new InMemoryLimitCounterStore(() => now);
    expect(await store.increment("k", 1000)).toBe(1);
    expect(await store.increment("k", 1000)).toBe(2);
    now = 1000;
    expect(await store.peek("k")).toBe(0);
    expect(await store.increment("k", 1000)).toBe(1);
  });

  it("Redis counters INCR and set the expiry once per window", async () => {
    const data = new Map<string, number>();
    const redis = {
      incr: vi.fn(async (k: string) => {
        data.set(k, (data.get(k) ?? 0) + 1);
        return data.get(k)!;
      }),
      pexpire: vi.fn(async () => 1),
      get: vi.fn(async (k: string) => (data.has(k) ? String(data.get(k)) : null)),
      del: vi.fn(async (k: string) => data.delete(k)),
    };
    const store = new RedisLimitCounterStore(redis);
    await store.increment("k", 5000);
    await store.increment("k", 5000);
    expect(redis.pexpire).toHaveBeenCalledTimes(1);
    expect(redis.pexpire).toHaveBeenCalledWith("k", 5000);
    expect(await store.peek("k")).toBe(2);
    await store.reset("k");
    expect(await store.peek("k")).toBe(0);
  });
});

describe("server-side enforcement over HTTP (#815)", () => {
  function httpApp() {
    const { svc } = setup();
    const app = Fastify();
    app.setErrorHandler(errorHandler as never);
    app.addHook(
      "preHandler",
      operationLimitsHook(svc, [{ method: "POST", url: "/actions", operation: "action.create", walletHint: bodyWallet() }]),
    );
    app.post("/actions", async () => ({ ok: true }));
    app.get("/unlimited", async () => ({ ok: true }));

    // A guarded route: the fake guard authenticates via header, then the limit
    // is keyed by the authenticated wallet, not the body.
    const guard = async (req: FastifyRequest) => {
      const wallet = req.headers["x-wallet"];
      if (typeof wallet !== "string") throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      req.principal = { role: "user", subject: wallet, walletAddress: wallet };
    };
    app.post(
      "/guarded",
      { preHandler: [chainPreHandlers(guard as never, enforceOperationLimit(svc, "action.create"))] },
      async () => ({ ok: true }),
    );
    return app;
  }

  const post = (app: ReturnType<typeof httpApp>, url: string, body: object, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, payload: body, headers });

  it("returns 429 OPERATION_LIMIT_EXCEEDED with details and Retry-After once over the limit", async () => {
    const app = httpApp();
    for (let i = 0; i < 3; i++) {
      const res = await post(app, "/actions", { wallet_address: "GA" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-operation-limit-remaining"]).toBe(String(2 - i));
    }
    const res = await post(app, "/actions", { wallet_address: "GA" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    const body = res.json();
    expect(body.error).toMatchObject({
      code: "OPERATION_LIMIT_EXCEEDED",
      category: "rate_limit",
      retryable: true,
      status_code: 429,
      details: { operation: "action.create", limit: 3, window_seconds: 60, retry_after_seconds: 60 },
    });
    expect(body.error.message).toContain("Wait for your pending actions");
    expect(body.error.details.remediation).toBeTruthy();
    // Different wallet, and unrelated routes, are unaffected.
    expect((await post(app, "/actions", { wallet_address: "GB" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/unlimited" })).statusCode).toBe(200);
    await app.close();
  });

  it("falls back to the client IP when no wallet is supplied, and normalises wallet case", async () => {
    const app = httpApp();
    for (let i = 0; i < 3; i++) await post(app, "/actions", {});
    expect((await post(app, "/actions", {})).statusCode).toBe(429);

    for (let i = 0; i < 3; i++) await post(app, "/actions", { wallet_address: "GCASE" });
    expect((await post(app, "/actions", { wallet_address: "gcase" })).statusCode).toBe(429);
    await app.close();
  });

  it("guarded routes key limits by the authenticated wallet and don't count rejected auth", async () => {
    const app = httpApp();
    for (let i = 0; i < 5; i++) expect((await post(app, "/guarded", {})).statusCode).toBe(401);
    for (let i = 0; i < 3; i++) {
      expect((await post(app, "/guarded", { wallet_address: `spoof-${i}` }, { "x-wallet": "GREAL" })).statusCode).toBe(200);
    }
    expect((await post(app, "/guarded", { wallet_address: "fresh" }, { "x-wallet": "GREAL" })).statusCode).toBe(429);
    await app.close();
  });
});
