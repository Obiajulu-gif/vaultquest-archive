/**
 * Tests for Issue #996 — Stale session and token revocation after security
 * events.
 *
 * Covers:
 *  - SecurityRevocationService.revokeForSecurityEvent: normal revocation
 *  - SecurityRevocationService.revokeForSecurityEvent: network-scoped
 *  - SecurityRevocationService.revokeForSecurityEvent: idle-threshold filter
 *  - SecurityRevocationService.revokeForSecurityEvent: no-op when nothing active
 *  - SecurityRevocationService.revokeForSecurityEvent: writes audit record
 *  - SecurityRevocationService.pruneStaleSessionsGlobally: prunes idle sessions
 *  - POST /admin/security/revoke-sessions: auth enforcement
 *  - POST /admin/security/revoke-sessions: valid revocation
 *  - POST /admin/security/prune-stale-sessions: prune endpoint
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  SecurityRevocationService,
} from "../src/services/securityRevocationService.js";
import { securityRevocationRoutes } from "../src/routes/securityRevocation.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Session = {
  walletAddress: string;
  network: string;
  revokedAt: Date | null;
  lastUsedAt: Date;
  expiresAt: Date;
};

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    walletAddress: "GTEST",
    network: "TESTNET",
    revokedAt: null,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000), // 1 hour from now
    ...overrides,
  };
}

function makePrisma(sessions: Session[]) {
  return {
    walletSession: {
      count: async (opts: any) => {
        const where = opts.where ?? {};
        return sessions.filter((s) => {
          if (s.revokedAt !== null) return false;
          if (where.walletAddress && s.walletAddress !== where.walletAddress) return false;
          if (where.network && s.network !== where.network) return false;
          if (where.expiresAt?.gt && s.expiresAt <= where.expiresAt.gt) return false;
          if (where.lastUsedAt?.lt && s.lastUsedAt >= where.lastUsedAt.lt) return false;
          return true;
        }).length;
      },
      updateMany: vi.fn(async (opts: any) => {
        const where = opts.where ?? {};
        let count = 0;
        for (const s of sessions) {
          if (s.revokedAt !== null) continue;
          if (where.walletAddress && s.walletAddress !== where.walletAddress) continue;
          if (where.network && s.network !== where.network) continue;
          if (where.expiresAt?.gt && s.expiresAt <= where.expiresAt.gt) continue;
          if (where.lastUsedAt?.lt && s.lastUsedAt >= where.lastUsedAt.lt) continue;
          s.revokedAt = opts.data.revokedAt;
          count++;
        }
        return { count };
      }),
    },
    $transaction: async (fn: Function) => fn(makePrisma(sessions)),
  } as any;
}

// ---------------------------------------------------------------------------
// SecurityRevocationService unit tests
// ---------------------------------------------------------------------------

describe("SecurityRevocationService — Issue #996", () => {
  it("revokes all active sessions for a wallet", async () => {
    const sessions = [makeSession(), makeSession()];
    const prisma = makePrisma(sessions);
    const svc = new SecurityRevocationService(prisma);

    const result = await svc.revokeForSecurityEvent({
      walletAddress: "GTEST",
      reason: "key_rotation",
    });

    expect(result.revokedCount).toBe(2);
    expect(result.noOp).toBe(false);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });

  it("is a no-op when no active sessions exist", async () => {
    const sessions = [makeSession({ revokedAt: new Date() })];
    const prisma = makePrisma(sessions);
    const svc = new SecurityRevocationService(prisma);

    const result = await svc.revokeForSecurityEvent({
      walletAddress: "GTEST",
      reason: "admin_forced_logout",
    });

    expect(result.revokedCount).toBe(0);
    expect(result.noOp).toBe(true);
  });

  it("scopes revocation to a specific network", async () => {
    const testnet = makeSession({ walletAddress: "GTEST", network: "TESTNET" });
    const mainnet = makeSession({ walletAddress: "GTEST", network: "MAINNET" });
    const prisma = makePrisma([testnet, mainnet]);
    const svc = new SecurityRevocationService(prisma);

    const result = await svc.revokeForSecurityEvent({
      walletAddress: "GTEST",
      reason: "suspicious_activity",
      network: "TESTNET",
    });

    expect(result.revokedCount).toBe(1);
    expect(testnet.revokedAt).not.toBeNull();
    expect(mainnet.revokedAt).toBeNull();
  });

  it("only revokes sessions idle longer than maxIdleMs", async () => {
    const now = new Date();
    const recentSession = makeSession({ lastUsedAt: new Date(now.getTime() - 1_000) }); // 1s idle
    const staleSession = makeSession({ lastUsedAt: new Date(now.getTime() - 60 * 60 * 1000) }); // 1h idle
    const prisma = makePrisma([recentSession, staleSession]);
    const svc = new SecurityRevocationService(prisma);

    const result = await svc.revokeForSecurityEvent({
      walletAddress: "GTEST",
      reason: "account_compromise",
      maxIdleMs: 30 * 60 * 1000, // 30 minutes
    });

    expect(result.revokedCount).toBe(1);
    expect(staleSession.revokedAt).not.toBeNull();
    expect(recentSession.revokedAt).toBeNull();
  });

  it("writes an audit record when an audit recorder is provided", async () => {
    const sessions = [makeSession()];
    const prisma = makePrisma(sessions);
    const auditRecords: any[] = [];
    const audit = { record: async (r: any) => { auditRecords.push(r); } };
    const svc = new SecurityRevocationService(prisma, audit);

    await svc.revokeForSecurityEvent({
      walletAddress: "GTEST",
      reason: "key_rotation",
      detail: "Public key changed by user",
    });

    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].action).toBe("session.revoke_all");
    expect(auditRecords[0].target.id).toBe("GTEST");
    expect(auditRecords[0].before.reason).toBe("key_rotation");
    expect(auditRecords[0].before.detail).toBe("Public key changed by user");
    expect(auditRecords[0].after.activeSessions).toBe(0);
  });

  it("does not write an audit record when no sessions are affected", async () => {
    const sessions: Session[] = [];
    const prisma = makePrisma(sessions);
    const auditRecords: any[] = [];
    const audit = { record: async (r: any) => { auditRecords.push(r); } };
    const svc = new SecurityRevocationService(prisma, audit);

    await svc.revokeForSecurityEvent({
      walletAddress: "GTEST",
      reason: "key_rotation",
    });

    expect(auditRecords).toHaveLength(0);
  });
});

describe("SecurityRevocationService.pruneStaleSessionsGlobally — Issue #996", () => {
  it("revokes sessions idle longer than the threshold globally", async () => {
    const now = new Date();
    const sessions = [
      makeSession({ walletAddress: "GA", lastUsedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) }), // 2h
      makeSession({ walletAddress: "GB", lastUsedAt: new Date(now.getTime() - 30 * 60 * 1000) }),      // 30m
    ];
    const prisma = makePrisma(sessions);
    const svc = new SecurityRevocationService(prisma);

    const count = await svc.pruneStaleSessionsGlobally(60 * 60 * 1000); // 1h threshold
    expect(count).toBe(1);
  });

  it("throws when maxIdleMs is zero or negative", async () => {
    const prisma = makePrisma([]);
    const svc = new SecurityRevocationService(prisma);
    await expect(svc.pruneStaleSessionsGlobally(0)).rejects.toThrow("maxIdleMs must be a positive number");
    await expect(svc.pruneStaleSessionsGlobally(-1000)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Route integration tests
// ---------------------------------------------------------------------------

describe("POST /admin/security/revoke-sessions — Issue #996", () => {
  async function build(sessions: Session[] = []) {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const resolver = walletSessionResolver(
      {
        validateSession: async (t) =>
          t === "admin" ? { walletAddress: "GADMIN" } : t === "user" ? { walletAddress: "GUSER" } : null,
      },
      ["GADMIN"]
    );
    const prisma = makePrisma(sessions);
    const svc = new SecurityRevocationService(prisma);
    app.register(
      securityRevocationRoutes(requirePermission("admin.recovery.write", [resolver]), svc)
    );
    await app.ready();
    return app;
  }

  it("returns 401 without credentials", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/security/revoke-sessions",
        payload: { wallet_address: "GTEST", reason: "key_rotation" },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns 403 for a non-maintainer user", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/security/revoke-sessions",
        headers: { authorization: "Bearer user" },
        payload: { wallet_address: "GTEST", reason: "key_rotation" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("revokes sessions and returns the result for a maintainer", async () => {
    const sessions = [makeSession({ walletAddress: "GTEST" })];
    const app = await build(sessions);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/security/revoke-sessions",
        headers: { authorization: "Bearer admin" },
        payload: { wallet_address: "GTEST", reason: "admin_forced_logout" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.revokedCount).toBe(1);
      expect(body.data.noOp).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns noOp=true when no active sessions exist", async () => {
    const app = await build([]);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/security/revoke-sessions",
        headers: { authorization: "Bearer admin" },
        payload: { wallet_address: "GNOBODY", reason: "suspicious_activity" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.noOp).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns 400 for an invalid reason value", async () => {
    const app = await build();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/security/revoke-sessions",
        headers: { authorization: "Bearer admin" },
        payload: { wallet_address: "GTEST", reason: "not_a_valid_reason" },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("POST /admin/security/prune-stale-sessions — Issue #996", () => {
  async function build(sessions: Session[] = []) {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const resolver = walletSessionResolver(
      {
        validateSession: async (t) =>
          t === "admin" ? { walletAddress: "GADMIN" } : null,
      },
      ["GADMIN"]
    );
    const prisma = makePrisma(sessions);
    const svc = new SecurityRevocationService(prisma);
    app.register(
      securityRevocationRoutes(requirePermission("admin.recovery.write", [resolver]), svc)
    );
    await app.ready();
    return app;
  }

  it("returns 200 with the count of pruned sessions", async () => {
    const now = new Date();
    const stale = makeSession({ lastUsedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000) });
    const app = await build([stale]);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/admin/security/prune-stale-sessions",
        headers: { authorization: "Bearer admin" },
        payload: { max_idle_ms: 60 * 60 * 1000 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.revokedCount).toBe(1);
      expect(body.data.prunedAt).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
