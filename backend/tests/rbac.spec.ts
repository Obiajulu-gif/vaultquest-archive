import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../src/middleware/errorHandler.js";
import {
  requirePermission,
  serviceSecretResolver,
  walletSessionResolver,
} from "../src/middleware/rbac.js";
import { auditRoutes } from "../src/routes/audit.js";
import { internalRoutes } from "../src/routes/internal.js";
import { reconciliationRoutes } from "../src/routes/reconciliation.js";
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  isRole,
  roleHasPermission,
} from "../../lib/rbac.js";

const SECRET = "service-secret";
const ADMIN = "GADMIN";
const USER = "GUSER";

const sessions: Record<string, { id: string; walletAddress: string }> = {
  "admin-token": { id: "s1", walletAddress: ADMIN },
  "user-token": { id: "s2", walletAddress: USER },
};
const walletAuth = { validateSession: vi.fn(async (t: string) => sessions[t] ?? null) };

const auditSvc = {
  record: vi.fn(async (input: any) => ({
    id: "1",
    parameterName: input.parameterName,
    previousValue: null,
    newValue: null,
    actor: input.actor,
    txHash: null,
    createdAt: new Date(),
  })),
  list: vi.fn(async () => ({ items: [], nextCursor: null })),
};
const ledgerSvc = {
  reconcileEvent: vi.fn(async () => ({ matched: true })),
  updateIndexerCheckpoint: vi.fn(async () => undefined),
};
const traceSvc = { trace: vi.fn(async () => ({ txHash: "x" })) };

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.setErrorHandler(errorHandler as any);
  const wallet = walletSessionResolver(walletAuth, [ADMIN]);
  app.register(
    auditRoutes(auditSvc as any, {
      read: requirePermission("admin.audit.read", [wallet]),
      write: requirePermission("admin.audit.write", [wallet]),
      export: requirePermission("admin.audit.export", [wallet]),
    }),
  );
  app.register(internalRoutes(ledgerSvc as any, SECRET, traceSvc as any));
  app.register(reconciliationRoutes({} as any, SECRET));
  return app;
}

const validTx = "a".repeat(64);
const auditBody = { parameter_name: "fee", previous_value: 1, new_value: 2, actor: "x" };

/** Every privileged route and the credential family that may call it. */
const ADMIN_ROUTES = [
  { method: "GET", url: "/admin/audit", permission: "admin.audit.read" },
  { method: "POST", url: "/admin/audit", permission: "admin.audit.write", payload: auditBody },
  { method: "GET", url: "/admin/audit/export", permission: "admin.audit.export" },
] as const;
const SERVICE_ROUTES = [
  { method: "POST", url: "/internal/reconcile", permission: "internal.reconcile", payload: {} },
  { method: "POST", url: "/internal/checkpoint", permission: "internal.checkpoint", payload: {} },
  { method: "GET", url: `/internal/trace/${validTx}`, permission: "internal.trace" },
  {
    method: "POST",
    url: "/internal/reconciliation/proposals",
    permission: "internal.reconciliation.propose",
    payload: {},
  },
  {
    method: "POST",
    url: "/internal/reconciliation/proposals/abc/approve",
    permission: "internal.reconciliation.approve",
    payload: {},
  },
  {
    method: "POST",
    url: "/internal/reconciliation/proposals/abc/execute",
    permission: "internal.reconciliation.execute",
    payload: {},
  },
] as const;

describe("role/permission matrix (lib/rbac)", () => {
  it("defines only known permissions per role", () => {
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) expect(PERMISSIONS).toContain(p);
    }
  });

  it("makes maintainers a superset of users and keeps service isolated", () => {
    for (const p of ROLE_PERMISSIONS.user) expect(roleHasPermission("maintainer", p)).toBe(true);
    expect(roleHasPermission("user", "admin.audit.read")).toBe(false);
    expect(roleHasPermission("maintainer", "internal.reconcile")).toBe(false);
    expect(roleHasPermission("service", "admin.audit.read")).toBe(false);
    expect(roleHasPermission("service", "own.data.export")).toBe(false);
  });

  it("grants every permission to at least one role", () => {
    for (const p of PERMISSIONS) {
      expect(ROLES.some((r) => roleHasPermission(r, p))).toBe(true);
    }
  });

  it("denies unknown or missing roles", () => {
    expect(isRole("root")).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(roleHasPermission("root", "admin.audit.read")).toBe(false);
    expect(roleHasPermission(null, "admin.audit.read")).toBe(false);
    expect(hasPermission(undefined, "own.data.read")).toBe(false);
    expect(hasPermission(["user", "maintainer"], "admin.audit.read")).toBe(true);
  });
});

describe("privileged route enforcement", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe.each(ADMIN_ROUTES)("$method $url ($permission)", (route) => {
    const call = (headers: Record<string, string> = {}) =>
      app.inject({ method: route.method, url: route.url, headers, payload: (route as any).payload });

    it("rejects missing credentials with 401", async () => {
      app = buildApp();
      expect((await call()).statusCode).toBe(401);
    });

    it("rejects forged bearer tokens with 401", async () => {
      app = buildApp();
      expect((await call({ authorization: "Bearer forged" })).statusCode).toBe(401);
    });

    it("rejects a non-maintainer user session with 403", async () => {
      app = buildApp();
      expect((await call({ authorization: "Bearer user-token" })).statusCode).toBe(403);
    });

    it("rejects the service secret with 401/403 (wrong role family)", async () => {
      app = buildApp();
      expect([401, 403]).toContain((await call({ "x-internal-secret": SECRET })).statusCode);
    });

    it("allows a maintainer session", async () => {
      app = buildApp();
      expect((await call({ authorization: "Bearer admin-token" })).statusCode).toBeLessThan(300);
    });
  });

  describe.each(SERVICE_ROUTES)("$method $url ($permission)", (route) => {
    const call = (headers: Record<string, string> = {}) =>
      app.inject({ method: route.method, url: route.url, headers, payload: (route as any).payload });

    it("rejects missing credentials with 401", async () => {
      app = buildApp();
      expect((await call()).statusCode).toBe(401);
    });

    it("rejects a wrong secret with 401", async () => {
      app = buildApp();
      expect((await call({ "x-internal-secret": "nope" })).statusCode).toBe(401);
    });

    it("rejects even a maintainer wallet session (services only)", async () => {
      app = buildApp();
      expect((await call({ authorization: "Bearer admin-token" })).statusCode).toBe(401);
    });

    it("passes the guard with the service secret", async () => {
      app = buildApp();
      const res = await call({ "x-internal-secret": SECRET });
      expect([401, 403]).not.toContain(res.statusCode);
    });
  });

  it("covers every internal/admin permission with at least one guarded route", () => {
    const covered = new Set<string>([...ADMIN_ROUTES, ...SERVICE_ROUTES].map((r) => r.permission));
    const privileged = PERMISSIONS.filter((p) => p.startsWith("admin.") || p.startsWith("internal."));
    // admin.ledger.verify / admin.export.any are declared for routes gated elsewhere
    const deferred = new Set(["admin.ledger.verify", "admin.export.any"]);
    for (const p of privileged) {
      if (!deferred.has(p)) expect(covered.has(p)).toBe(true);
    }
  });

  it("records the maintainer wallet as the audit actor, not the client-supplied one", async () => {
    app = buildApp();
    await app.inject({
      method: "POST",
      url: "/admin/audit",
      headers: { authorization: "Bearer admin-token" },
      payload: { ...auditBody, actor: "spoofed" },
    });
    expect(auditSvc.record).toHaveBeenCalledWith(expect.objectContaining({ actor: ADMIN }));
  });
});

describe("resolvers", () => {
  it("falls through to the next resolver when the first has no credential", async () => {
    const app = Fastify();
    app.setErrorHandler(errorHandler as any);
    app.get(
      "/x",
      {
        preHandler: requirePermission("internal.trace", [
          walletSessionResolver(walletAuth, [ADMIN]),
          serviceSecretResolver(SECRET, "indexer"),
        ]),
      },
      async (req) => ({ subject: req.principal?.subject, role: req.principal?.role }),
    );
    const res = await app.inject({ method: "GET", url: "/x", headers: { "x-internal-secret": SECRET } });
    expect(res.json()).toEqual({ subject: "indexer", role: "service" });
    await app.close();
  });

  it("treats a blank bearer token as unauthenticated", async () => {
    const resolve = walletSessionResolver(walletAuth, [ADMIN]);
    expect(await resolve({ headers: { authorization: "Bearer   " } } as any)).toBeNull();
    expect(await resolve({ headers: {} } as any)).toBeNull();
  });

  it("matches admin wallets case-insensitively and ignores blanks", async () => {
    const resolve = walletSessionResolver(walletAuth, [" gadmin ", ""]);
    const p = await resolve({ headers: { authorization: "Bearer admin-token" } } as any);
    expect(p?.role).toBe("maintainer");
  });
});
