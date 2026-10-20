/* eslint-disable @typescript-eslint/no-explicit-any -- PrismaClient test doubles */
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_GENESIS_HASH,
  AuditSequenceConflictError,
  AuditTrailService,
  InMemoryAuditTrailStore,
  OMITTED,
  REDACTED,
  computeAuditRecordHash,
  sanitizeAuditState,
  type AuditRecord,
  type AuditRecordInput,
} from "../src/services/auditTrail.js";
import { InMemoryInvitationStore, InvitationService } from "../src/services/invitationService.js";
import { WalletAuthService } from "../src/services/walletAuth.js";
import { AdminSessionService } from "../src/services/adminSessionService.js";

// #814 — immutable audit trail for ownership and access changes.

const ADMIN = { subject: "GADMIN", role: "maintainer" as const };

function makeTrail(start = Date.parse("2026-09-29T10:00:00.000Z")) {
  let t = start;
  const store = new InMemoryAuditTrailStore();
  const trail = new AuditTrailService(store, { now: () => new Date((t += 1000)) });
  return { store, trail };
}

const roleGrant = (overrides: Partial<AuditRecordInput> = {}): AuditRecordInput => ({
  category: "access",
  action: "role.grant",
  actor: ADMIN,
  target: { type: "vault_member", id: "vault-1:GBOB" },
  reason: "promote reviewer",
  before: { role: "viewer" },
  after: { role: "contributor" },
  ...overrides,
});

describe("AuditTrailService — actor attribution and before/after (#814)", () => {
  it("records actor, target, reason and exact before/after state", async () => {
    const { trail } = makeTrail();
    const record = await trail.record(roleGrant());

    expect(record.sequence).toBe(1);
    expect(record.category).toBe("access");
    expect(record.action).toBe("role.grant");
    expect(record.actor).toEqual(ADMIN);
    expect(record.target).toEqual({ type: "vault_member", id: "vault-1:GBOB" });
    expect(record.reason).toBe("promote reviewer");
    expect(record.before).toEqual({ role: "viewer" });
    expect(record.after).toEqual({ role: "contributor" });
    expect(record.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(record.redactedFields).toEqual([]);
    expect(record.occurredAt).toBe("2026-09-29T10:00:01.000Z");
  });

  it("chains every record to its predecessor", async () => {
    const { trail } = makeTrail();
    const a = await trail.record(roleGrant());
    const b = await trail.record(roleGrant({ action: "role.revoke", before: { role: "contributor" }, after: null }));
    expect(b.sequence).toBe(2);
    expect(b.prevHash).toBe(a.recordHash);
    const { recordHash, ...payload } = b;
    expect(computeAuditRecordHash(payload)).toBe(recordHash);
  });

  it("serialises concurrent appends into a gap-free sequence", async () => {
    const { trail } = makeTrail();
    const records = await Promise.all(
      Array.from({ length: 10 }, (_, i) => trail.record(roleGrant({ target: { type: "vault_member", id: `m${i}` } }))),
    );
    expect(records.map((r) => r.sequence).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await trail.verify()).ok).toBe(true);
  });

  it("retries after a cross-process sequence conflict", async () => {
    const store = new InMemoryAuditTrailStore();
    const append = store.append.bind(store);
    let first = true;
    vi.spyOn(store, "append").mockImplementation(async (record: AuditRecord) => {
      if (first) {
        first = false;
        // Another process wins sequence 1 between our head() read and append()
        // (simulated by storing an equally valid record for that slot).
        await append(record);
        throw new AuditSequenceConflictError(record.sequence);
      }
      return append(record);
    });
    const trail = new AuditTrailService(store);
    const mine = await trail.record(roleGrant());
    expect(mine.sequence).toBe(2);
    expect((await trail.verify()).ok).toBe(true);
  });

  it("rejects missing actor/target, unknown access actions and missing reasons", async () => {
    const { trail } = makeTrail();
    await expect(trail.record(roleGrant({ actor: { subject: "", role: "user" } }))).rejects.toThrow(/actor/);
    await expect(trail.record(roleGrant({ target: { type: "", id: "x" } }))).rejects.toThrow(/target/);
    await expect(trail.record(roleGrant({ action: "role.teleport" }))).rejects.toThrow(/unknown access audit action/);
    await expect(trail.record(roleGrant({ reason: "  " }))).rejects.toThrow(/reason is required/);
    // Non-access categories accept their own actions.
    await expect(
      trail.record({ category: "recovery", action: "recovery.detect", actor: ADMIN, target: { type: "recovery_case", id: "r1" } }),
    ).resolves.toMatchObject({ category: "recovery" });
  });
});

describe("AuditTrailService — no secrets or hidden payloads (#814)", () => {
  it("redacts secret keys and secret-looking values, omits hidden payloads, and lists the paths", async () => {
    const { trail } = makeTrail();
    const record = await trail.record({
      category: "access",
      action: "session.issue",
      actor: { subject: "GUSER", role: "user" },
      target: { type: "wallet_session", id: "s-1" },
      before: null,
      after: {
        network: "testnet",
        token: "tok-123",
        refreshToken: "ref-456",
        nested: { apiKey: "k", signature: "sig", note: "SBZVMB74Z76QZ3ZOY7UTDFYKMEGKW5XFJEB6PFKBF4UYSSWHG4EDH7PY" },
        payload: { amount: 10 },
        headers: { authorization: "Bearer abc" },
        memo: "Bearer leaked",
        txHash: "abcd",
      },
    });

    expect(record.after).toEqual({
      network: "testnet",
      token: REDACTED,
      refreshToken: REDACTED,
      nested: { apiKey: REDACTED, signature: REDACTED, note: REDACTED },
      payload: OMITTED,
      headers: OMITTED,
      memo: REDACTED,
      txHash: "abcd", // not a secret: kept
    });
    expect(record.redactedFields.sort()).toEqual(
      [
        "after.token",
        "after.refreshToken",
        "after.nested.apiKey",
        "after.nested.signature",
        "after.nested.note",
        "after.payload",
        "after.headers",
        "after.memo",
      ].sort(),
    );
    const serialized = JSON.stringify(record);
    for (const secret of ["tok-123", "ref-456", "SBZVMB74", "Bearer abc", "Bearer leaked"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("bounds depth, array length and string length", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 12; i++) cursor = (cursor.child = {}) as Record<string, unknown>;
    const { value } = sanitizeAuditState(
      { deep, list: Array.from({ length: 105 }, (_, i) => i), text: "x".repeat(2000) },
      "after",
    );
    expect(JSON.stringify(value)).toContain("[TRUNCATED]");
    expect((value!.list as unknown[]).length).toBe(101);
    expect((value!.text as string).length).toBe(1025);
  });
});

describe("AuditTrailService — immutability and tamper detection (#814)", () => {
  it("stored records are frozen copies", async () => {
    const { trail, store } = makeTrail();
    await trail.record(roleGrant());
    const [stored] = await store.scan(0, 10);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored!.after as Record<string, unknown>).role = "admin";
    }).toThrow();
  });

  it("verify() detects an edited record", async () => {
    const { trail, store } = makeTrail();
    await trail.record(roleGrant());
    await trail.record(roleGrant({ target: { type: "vault_member", id: "vault-1:GCAROL" } }));
    store.tamperForTest(1, (r) => {
      r.after = { role: "admin" };
    });
    const result = await trail.verify();
    expect(result.ok).toBe(false);
    expect(result.problems).toContainEqual(expect.objectContaining({ code: "ALTERED", sequence: 1 }));
  });

  it("verify() detects a deleted record", async () => {
    const { trail, store } = makeTrail();
    for (let i = 0; i < 3; i++) await trail.record(roleGrant({ target: { type: "t", id: String(i) } }));
    store.deleteForTest(2);
    const result = await trail.verify();
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["SEQUENCE_GAP", "BROKEN_LINK"]));
  });

  it("verify() detects a record re-hashed after editing (broken link to the next record)", async () => {
    const { trail, store } = makeTrail();
    await trail.record(roleGrant());
    await trail.record(roleGrant({ target: { type: "t", id: "2" } }));
    store.tamperForTest(1, (r) => {
      r.actor = { subject: "GMALLORY", role: "maintainer" };
      const payload: Partial<AuditRecord> = { ...r };
      delete payload.recordHash;
      r.recordHash = computeAuditRecordHash(payload as Omit<AuditRecord, "recordHash">);
    });
    const result = await trail.verify();
    expect(result.problems).toContainEqual(expect.objectContaining({ code: "BROKEN_LINK", sequence: 2 }));
  });
});

describe("AuditTrailService — query and export (#814)", () => {
  async function seeded() {
    const { trail } = makeTrail();
    await trail.record(roleGrant());
    await trail.record(roleGrant({ actor: { subject: "GOTHER", role: "maintainer" } }));
    await trail.record({
      category: "limits",
      action: "limits.reset",
      actor: ADMIN,
      target: { type: "limit_counter", id: "action.create:wallet:g" },
      reason: "support ticket",
      before: { used: 30 },
      after: { used: 0 },
    });
    return trail;
  }

  it("filters by category/actor and paginates newest first", async () => {
    const trail = await seeded();
    const access = await trail.list({ category: "access", limit: 10 });
    expect(access.items.map((r) => r.sequence)).toEqual([2, 1]);
    const byActor = await trail.list({ actorSubject: "GOTHER", limit: 10 });
    expect(byActor.items).toHaveLength(1);

    const page1 = await trail.list({ limit: 2 });
    expect(page1.items.map((r) => r.sequence)).toEqual([3, 2]);
    expect(page1.nextCursor).toBe("2");
    const page2 = await trail.list({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((r) => r.sequence)).toEqual([1]);
    expect(page2.nextCursor).toBeNull();
  });

  it("exports NDJSON that re-verifies offline", async () => {
    const trail = await seeded();
    const lines = (await trail.export({}, "ndjson")).trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
    expect(lines).toHaveLength(3);
    for (const record of lines) {
      const { recordHash, ...payload } = record;
      expect(computeAuditRecordHash(payload)).toBe(recordHash);
    }
  });

  it("exports CSV with a header and formula-injection protection", async () => {
    const { trail } = makeTrail();
    await trail.record(roleGrant({ reason: "=HYPERLINK(\"http://evil\")" }));
    const csv = await trail.export({ category: "access" }, "csv");
    const [header, row] = csv.trim().split("\n");
    expect(header).toContain("record_hash");
    expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe("access-changing services write audit records (#814)", () => {
  it("InvitationService audits create, accept and revoke with correct before/after", async () => {
    const { trail, store } = makeTrail();
    let now = Date.parse("2026-09-29T10:00:00.000Z");
    const svc = new InvitationService({
      store: new InMemoryInvitationStore(),
      audit: trail,
      now: () => now,
      tokenFactory: (() => {
        let i = 0;
        return () => `raw-token-${++i}`;
      })(),
    });

    const { invitation, token } = await svc.create({
      vaultId: "vault-1",
      inviterId: "GALICE",
      inviteeId: "GBOB",
      inviterRole: "admin",
      role: "contributor",
      reason: "join the savings circle",
    });
    await svc.accept({ token, inviteeId: "GBOB" });

    now += 120_000;
    const second = await svc.create({ vaultId: "vault-1", inviterId: "GALICE", inviteeId: "GCAROL", inviterRole: "admin" });
    await svc.revoke({ invitationId: second.invitation.id, actorId: "GALICE" });

    const records = await store.scan(0, 10);
    expect(records.map((r) => [r.action, r.actor.subject])).toEqual([
      ["invitation.create", "GALICE"],
      ["invitation.accept", "GBOB"],
      ["invitation.create", "GALICE"],
      ["invitation.revoke", "GALICE"],
    ]);
    expect(records[0]!.before).toBeNull();
    expect(records[0]!.after).toMatchObject({ role: "contributor", state: "PENDING", inviteeId: "GBOB" });
    expect(records[0]!.reason).toBe("join the savings circle");
    expect(records[1]!.before).toMatchObject({ state: "PENDING" });
    expect(records[1]!.after).toMatchObject({ state: "ACCEPTED" });
    expect(records[3]!.target).toEqual({ type: "invitation", id: second.invitation.id });
    expect(records[3]!.after).toMatchObject({ state: "REVOKED" });
    // Neither the raw token nor its hash is ever written.
    expect(JSON.stringify(records)).not.toContain("raw-token");
    expect(JSON.stringify(records)).not.toContain(invitation.token);
  });

  it("InvitationService audits expiry with the system actor", async () => {
    const { trail, store } = makeTrail();
    let now = Date.parse("2026-09-29T10:00:00.000Z");
    const svc = new InvitationService({ store: new InMemoryInvitationStore(), audit: trail, now: () => now });
    const { token } = await svc.create({ vaultId: "v", inviterId: "GALICE", inviteeId: "GBOB", inviterRole: "admin", ttlMs: 1000 });
    now += 5000;
    await expect(svc.accept({ token, inviteeId: "GBOB" })).rejects.toThrow(/expired/i);
    const last = (await store.query({ limit: 1 }))[0]!;
    expect(last.action).toBe("invitation.expire");
    expect(last.actor).toEqual({ subject: "system", role: "system" });
    expect(last.after).toMatchObject({ state: "EXPIRED" });
  });

  it("WalletAuthService audits refresh, revoke and revoke-all without tokens", async () => {
    const { trail, store } = makeTrail();
    const session = {
      id: "sess-1",
      walletAddress: "GUSER",
      publicKey: "GUSER",
      network: "testnet",
      token: "old-token",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    };
    const prisma = {
      walletSession: {
        findUnique: vi.fn(async () => session),
        update: vi.fn(async ({ data }: any) => ({ ...session, ...data })),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
    } as any;
    const svc = new WalletAuthService(prisma, trail);

    await svc.refreshSession("old-refresh");
    await svc.revokeSession("old-token");
    await svc.revokeAllSessions("GUSER");

    const records = await store.scan(0, 10);
    expect(records.map((r) => r.action)).toEqual(["session.refresh", "session.revoke", "session.revoke_all"]);
    expect(records.every((r) => r.actor.subject === "GUSER")).toBe(true);
    expect(records[1]!.target).toEqual({ type: "wallet_session", id: "sess-1" });
    expect(records[1]!.before).toEqual({ revokedAt: null });
    expect(records[2]!.before).toEqual({ activeSessions: 2 });
    expect(records[2]!.after).toEqual({ activeSessions: 0 });
    const serialized = JSON.stringify(records);
    for (const secret of ["old-token", "old-refresh"]) expect(serialized).not.toContain(secret);
  });

  it("AdminSessionService audits revocation by fingerprint, never the session id", async () => {
    const { trail, store } = makeTrail();
    const prisma = {
      adminSession: {
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 3 })),
      },
    } as any;
    const svc = new AdminSessionService(prisma, trail);
    const sessionId = "a".repeat(64);

    await svc.revokeSession(sessionId, "GADMIN");
    await svc.revokeSessionsByRole(7, "GADMIN", "maintainer removed from allowlist");

    const [revoke, revokeRole] = await store.scan(0, 10);
    expect(revoke!.action).toBe("admin_session.revoke");
    expect(revoke!.actor).toEqual({ subject: "GADMIN", role: "maintainer" });
    expect(revoke!.target.id).toHaveLength(16);
    expect(JSON.stringify(revoke)).not.toContain(sessionId);
    expect(revokeRole!.action).toBe("admin_session.revoke_role");
    expect(revokeRole!.reason).toBe("maintainer removed from allowlist");
    expect(revokeRole!.before).toEqual({ activeSessions: 3 });
  });
});
