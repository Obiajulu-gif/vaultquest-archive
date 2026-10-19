import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import {
  SupportAccessService,
  buildSupportNotice,
  supportAgentBadge
} from "../src/services/supportAccessService.js";

const WALLET_A = `G${"A".repeat(55)}`;
const WALLET_B = `G${"B".repeat(55)}`;
const internalSecret = "support-secret-1234567890";

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

describe("support access (service)", () => {
  it("builds user-safe notices that never expose the maintainer id", () => {
    const notice = buildSupportNotice({
      requesterId: "maintainer-alice",
      ticketRef: "SUP-42",
      scopeType: "wallet",
      scope: WALLET_A,
      expiresAt: new Date("2026-10-16T10:30:00Z")
    });

    expect(notice).toContain(`#${supportAgentBadge("maintainer-alice")}`);
    expect(notice).toContain("SUP-42");
    expect(notice).not.toContain("maintainer-alice");
    expect(notice).toContain("2026-10-16T10:30:00.000Z");
  });

  it("escapes hostile ticket refs in notices", () => {
    const notice = buildSupportNotice({
      requesterId: "m",
      ticketRef: "<img src=x onerror=alert(1)>",
      scopeType: "wallet",
      scope: WALLET_A,
      expiresAt: new Date()
    });
    expect(notice).not.toContain("<img");
    expect(notice).toContain("&lt;img");
  });
});

describe("support access (routes)", () => {
  let db: TestDb;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await startTestDb();
    app = buildApp({ prisma: db.prisma, internalSecret });
  });
  afterAll(async () => {
    await app.close();
    await db.stop();
  });
  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  async function createGrant(body: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/internal/support-access/grants",
      headers: { "x-internal-secret": internalSecret, "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: {
        requester_id: "maintainer-alice",
        reason: "investigating deposit mismatch",
        ticket_ref: "SUP-42",
        scope_type: "wallet",
        scope: WALLET_A,
        ...body
      }
    });
    return res;
  }

  async function useGrant(grantId: string, body: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/internal/support-access/access",
      headers: { "x-internal-secret": internalSecret, "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: {
        grant_id: grantId,
        scope_type: "wallet",
        scope: WALLET_A,
        ...body
      }
    });
  }

  it("requires the service secret for every internal support-access route", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/support-access/grants",
      remoteAddress: nextIp(),
      payload: {}
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a scoped, time-bounded grant with a user-safe notice", async () => {
    const res = await createGrant();
    expect(res.statusCode).toBe(201);

    const body = res.json().data;
    expect(body.grant.id).toBeDefined();
    expect(body.grant.scope).toBe(WALLET_A);
    expect(body.grant.agent_badge).toBe(supportAgentBadge("maintainer-alice"));
    expect(body.grant).not.toHaveProperty("reason");
    expect(body.grant).not.toHaveProperty("requester_id");

    const ttlMs = new Date(body.grant.expires_at).getTime() - new Date(body.grant.created_at).getTime();
    expect(ttlMs).toBe(30 * 60 * 1000);

    expect(body.notice).toContain("audit-logged");
    expect(body.notice).not.toContain("maintainer-alice");
  });

  it("caps TTLs and rejects invalid scopes", async () => {
    const tooLong = await createGrant({ ttl_minutes: 500 });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe("INVALID_PAYLOAD");

    const badWalletScope = await createGrant({ scope: "not-a-wallet" });
    expect(badWalletScope.statusCode).toBe(400);

    const badScopeType = await createGrant({ scope_type: "everything" });
    expect(badScopeType.statusCode).toBe(400);
  });

  it("allows a scoped access and writes the audit trail", async () => {
    const created = await createGrant();
    const grantId = created.json().data.grant.id;

    const use = await useGrant(grantId);
    expect(use.statusCode).toBe(200);
    expect(use.json().data.allowed).toBe(true);
    expect(use.json().data.notice).toBeDefined();

    const trail = await app.inject({
      method: "GET",
      url: `/internal/support-access/grants/${grantId}/audit`,
      headers: { "x-internal-secret": internalSecret },
      remoteAddress: nextIp()
    });
    expect(trail.statusCode).toBe(200);
    const entries = trail.json().data.entries;
    expect(entries.map((e: { action: string }) => e.action)).toEqual([
      "grant_created",
      "grant_used"
    ]);
    expect(trail.json().data.chain_valid).toBe(true);
  });

  it("denies out-of-scope use and records the denial", async () => {
    const created = await createGrant();
    const grantId = created.json().data.grant.id;

    const use = await useGrant(grantId, { scope: WALLET_B });
    expect(use.statusCode).toBe(403);
    expect(use.json().error.code).toBe("SUPPORT_ACCESS_DENIED");
    expect(use.json().error.message).toContain("scope_mismatch");

    const stored = await db.prisma.supportAccessAuditEntry.findMany({
      where: { grantId },
      orderBy: { createdAt: "asc" }
    });
    expect(stored.map((e: { action: string }) => e.action)).toEqual([
      "grant_created",
      "access_denied"
    ]);
    expect(JSON.stringify(stored[1]?.detail)).toContain("scope_mismatch");
  });

  it("denies use after revocation and after expiry", async () => {
    const revocable = await createGrant();
    const revokeId = revocable.json().data.grant.id;
    const revoke = await app.inject({
      method: "POST",
      url: `/internal/support-access/grants/${revokeId}/revoke`,
      headers: { "x-internal-secret": internalSecret, "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: { revoked_by: "security-lead" }
    });
    expect(revoke.statusCode).toBe(200);
    // Idempotent revoke.
    const revokeAgain = await app.inject({
      method: "POST",
      url: `/internal/support-access/grants/${revokeId}/revoke`,
      headers: { "x-internal-secret": internalSecret, "content-type": "application/json" },
      remoteAddress: nextIp(),
      payload: { revoked_by: "security-lead" }
    });
    expect(revokeAgain.json().data.already_revoked).toBe(true);

    const revokedUse = await useGrant(revokeId);
    expect(revokedUse.statusCode).toBe(403);
    expect(revokedUse.json().error.message).toContain("grant_revoked");

    // Expiry: move the grant's expiry into the past — the check runs on every
    // use, so the grant dies automatically without any cleanup job.
    const expiring = await createGrant();
    const expiringId = expiring.json().data.grant.id;
    await db.prisma.supportAccessGrant.update({
      where: { id: expiringId },
      data: { expiresAt: new Date(Date.now() - 1000) }
    });
    const expiredUse = await useGrant(expiringId);
    expect(expiredUse.statusCode).toBe(403);
    expect(expiredUse.json().error.message).toContain("grant_expired");
  });

  it("denies use of unknown grants and audits the attempt", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    const use = await useGrant(ghostId);
    expect(use.statusCode).toBe(403);

    const denials = await db.prisma.supportAccessAuditEntry.findMany({
      where: { action: "access_denied" }
    });
    expect(denials).toHaveLength(1);
    expect(denials[0]?.grantId).toBe(ghostId);
  });

  it("keeps the audit trail append-only at the database layer", async () => {
    const created = await createGrant();
    expect(created.statusCode).toBe(201);

    await expect(
      db.prisma.$executeRawUnsafe(`UPDATE "support_access_audit" SET "actor" = 'attacker'`)
    ).rejects.toThrow(/append-only/);
    await expect(
      db.prisma.$executeRawUnsafe(`DELETE FROM "support_access_audit"`)
    ).rejects.toThrow(/append-only/);
  });

  it("detects a spliced audit entry via hash-chain verification", async () => {
    await createGrant();

    await db.prisma.supportAccessAuditEntry.create({
      data: {
        grantId: null,
        actor: "attacker",
        action: "grant_used",
        scope: "wallet:unknown",
        detail: {},
        prevHash: "deadbeef",
        entryHash: "deadbeef"
      }
    });

    const verify = await app.inject({
      method: "GET",
      url: "/internal/support-access/audit/verify",
      headers: { "x-internal-secret": internalSecret },
      remoteAddress: nextIp()
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.valid).toBe(false);
    expect(verify.json().data.broken_at).toBeDefined();
  });

  it("fails closed when the audit store is unavailable", async () => {
    const svc = new SupportAccessService(db.prisma);
    const { grant } = await svc.createGrant({
      requesterId: "maintainer-bob",
      reason: "audit failure drill",
      ticketRef: "SUP-99",
      scopeType: "wallet",
      scope: WALLET_A,
      ttlMinutes: 30
    });

    const brokenAuditClient = new Proxy(db.prisma as object, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            (target as typeof db.prisma).$transaction(async (tx) =>
              fn(
                new Proxy(tx as object, {
                  get(txTarget, txProp, txReceiver) {
                    if (txProp === "supportAccessAuditEntry") {
                      return new Proxy(
                        (txTarget as Record<string, unknown>)["supportAccessAuditEntry"] as object,
                        {
                          get(entryTarget, entryProp, entryReceiver) {
                            if (entryProp === "create") {
                              return async () => {
                                throw new Error("audit storage down");
                              };
                            }
                            return Reflect.get(entryTarget, entryProp, entryReceiver);
                          }
                        }
                      );
                    }
                    return Reflect.get(txTarget, txProp, txReceiver);
                  }
                })
              )
            );
        }
        return Reflect.get(target, prop, receiver);
      }
    }) as unknown as typeof db.prisma;

    // The existing grant cannot be exercised without an audit append…
    const failing = new SupportAccessService(brokenAuditClient);
    await expect(
      failing.authorize({ grantId: grant.id, scopeType: "wallet", scope: WALLET_A })
    ).rejects.toThrow(/audit storage down/);

    // …and a new grant cannot even be created.
    await expect(
      failing.createGrant({
        requesterId: "maintainer-bob",
        reason: "audit failure drill",
        ticketRef: "SUP-100",
        scopeType: "wallet",
        scope: WALLET_A
      })
    ).rejects.toThrow(/audit storage down/);
  });

  it("exposes user-safe notices for the wallet, and nothing else", async () => {
    await createGrant();
    await createGrant({ scope: WALLET_B, ticket_ref: "<script>alert(1)</script>" });

    const res = await app.inject({
      method: "GET",
      url: `/support-access/notices?wallet=${WALLET_A}`,
      remoteAddress: nextIp()
    });
    expect(res.statusCode).toBe(200);

    const notices = res.json().data.notices;
    expect(notices).toHaveLength(1);
    expect(notices[0].scope_type).toBe("wallet");
    expect(notices[0].notice).toContain("audit-logged");
    expect(JSON.stringify(notices)).not.toContain("investigating deposit mismatch");
    expect(JSON.stringify(notices)).not.toContain("maintainer-alice");
    expect(JSON.stringify(notices)).not.toContain("script");

    const walletB = await app.inject({
      method: "GET",
      url: `/support-access/notices?wallet=${WALLET_B}`,
      remoteAddress: nextIp()
    });
    expect(walletB.json().data.notices[0].ticket_ref).toContain("&lt;script&gt;");
  });
});
