import Fastify from "fastify";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startTestDb, type TestDb } from "./helpers/db.js";
import { MaintainerNotesService } from "../src/services/maintainerNotes.js";
import { FailureEscalationService } from "../src/services/failureEscalation.js";
import { maintainerOperationsRoutes } from "../src/routes/maintainerOperations.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requirePermission, type PrincipalResolver } from "../src/middleware/rbac.js";
import { PartialFailureService } from "../src/services/partialFailureService.js";
import { AuditTrailService } from "../src/services/auditTrail.js";
import { PrismaAuditTrailStore } from "../src/services/governanceStores.js";

const admin = { role: "maintainer" as const, subject: "maintainer-a" };
const other = { role: "maintainer" as const, subject: "maintainer-b" };
const user = { role: "user" as const, subject: "user-a" };
let db: TestDb;
let notes: MaintainerNotesService;
let escalations: FailureEscalationService;
let failures: PartialFailureService;
let now = new Date("2026-10-20T10:00:00Z");
const noteInput = { scopeType: "failure" as const, scopeId: "case-1", kind: "incident" as const,
  visibility: "maintainers" as const, body: "Investigating a delayed deposit", retentionDays: 1 };

beforeAll(async () => {
  db = await startTestDb();
  notes = new MaintainerNotesService(db.prisma, () => now);
  escalations = new FailureEscalationService(db.prisma, () => now);
  failures = new PartialFailureService(db.prisma, new AuditTrailService(new PrismaAuditTrailStore(db.prisma)));
});
afterAll(async () => { await db?.stop(); });

describe("structured maintainer notes (#841)", () => {
  it("creates, edits and archives with optimistic version checks and no body in audit", async () => {
    const note = await notes.create(admin, noteInput);
    const edited = await notes.edit(admin, note.id, 1, { body: "Verified on chain", visibility: "maintainers" });
    expect(edited.version).toBe(2);
    await expect(notes.edit(admin, note.id, 1, { body: "Stale overwrite", visibility: "maintainers" })).rejects.toMatchObject({ statusCode: 409 });
    const archived = await notes.archive(admin, note.id, 2);
    expect(archived.archivedAt).not.toBeNull();
    expect(await notes.list(admin, "failure", "case-1")).toEqual([]);
    const audit = await db.prisma.maintainerNoteAudit.findMany({ where: { noteId: note.id } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["create", "edit", "archive"]));
    expect(JSON.stringify(audit)).not.toContain("Verified on chain");
  });
  it("enforces private visibility and rejects users and service actors", async () => {
    const note = await notes.create(admin, { ...noteInput, scopeId: "private-case", visibility: "private" });
    await expect(notes.get(other, note.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await notes.list(other, "failure", "private-case")).toEqual([]);
    await expect(notes.get(user, note.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(notes.create({ role: "service", subject: "machine" }, noteInput)).rejects.toMatchObject({ statusCode: 403 });
    expect((await notes.get(admin, note.id)).body).toBe(noteInput.body);
    expect(await db.prisma.maintainerNoteAudit.count({ where: { noteId: note.id, allowed: false } })).toBe(1);
  });
  it("redacts permanently and preserves immutable audit references", async () => {
    const note = await notes.create(admin, noteInput);
    expect((await notes.redact(admin, note.id, 1)).body).toBeNull();
    await expect(notes.edit(admin, note.id, 2, { body: "restore", visibility: "maintainers" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(db.prisma.maintainerNoteAudit.deleteMany({ where: { noteId: note.id } })).rejects.toThrow();
  });
  it("expires content on read and sweeps archived notes without extending retention", async () => {
    const a = await notes.create(admin, noteInput);
    const b = await notes.create(admin, noteInput);
    await notes.archive(admin, b.id, 1);
    now = new Date(now.getTime() + 86400000);
    expect((await notes.get(admin, a.id)).body).toBeNull();
    expect(await notes.expire()).toBeGreaterThan(0);
    expect((await db.prisma.maintainerNote.findUniqueOrThrow({ where: { id: b.id } })).body).toBeNull();
    await expect(notes.create(admin, { ...noteInput, retentionDays: 366 })).rejects.toThrow();
  });
});

describe("configured failure escalations (#842)", () => {
  async function failure(severity = "high") {
    return db.prisma.partialFailure.create({ data: { operationType: "wallet_flow", operationId: crypto.randomUUID(),
      severity, description: "Receipt delayed", detectedAt: now } });
  }
  it("waits for policy age, creates the first alert once under concurrent ticks, then repeats", async () => {
    const f = await failure();
    expect((await escalations.evaluate()).escalated).toBe(0);
    now = new Date(now.getTime() + 900000);
    await Promise.all([escalations.evaluate(), escalations.evaluate()]);
    expect(await db.prisma.failureEscalationAttempt.count({ where: { failureId: f.id } })).toBe(1);
    expect((await escalations.evaluate()).escalated).toBe(0);
    now = new Date(now.getTime() + 1800000);
    await escalations.evaluate();
    const attempts = await db.prisma.failureEscalationAttempt.findMany({ where: { failureId: f.id }, orderBy: { attempt: "asc" } });
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    await escalations.acknowledge(attempts[0]!.id, admin.subject);
    expect((await escalations.report()).find((a) => a.id === attempts[0]!.id)?.status).toBe("acknowledged");
    await failures.resolve(f.id, admin, "Verified the delayed receipt");
    now = new Date(now.getTime() + 86400000);
    await escalations.evaluate();
    expect(await db.prisma.failureEscalationAttempt.count({ where: { failureId: f.id } })).toBe(2);
    expect((await escalations.report()).filter((a) => a.failureId === f.id)).toEqual([]);
  });
  it("applies policy changes to existing failures, limits attempts, and stops ignored failures", async () => {
    const f = await failure("medium");
    const p = (await escalations.policies()).find((p) => p.severity === "medium")!;
    await escalations.configure("medium", admin.subject, { afterMs: 0, repeatMs: 60000, maxAttempts: 1, enabled: false, expectedVersion: p.version });
    expect((await escalations.evaluate()).escalated).toBe(0);
    await escalations.configure("medium", admin.subject, { afterMs: 0, repeatMs: 60000, maxAttempts: 1, enabled: true, expectedVersion: p.version + 1 });
    await escalations.evaluate();
    now = new Date(now.getTime() + 120000);
    expect((await escalations.evaluate()).escalated).toBe(0);
    await expect(escalations.configure("medium", admin.subject, { afterMs: 0, repeatMs: 60000, maxAttempts: 2, enabled: true, expectedVersion: p.version })).rejects.toMatchObject({ statusCode: 409 });
    await failures.ignore(f.id, admin, "Verified duplicate investigation");
    expect((await escalations.report()).filter((a) => a.failureId === f.id)).toEqual([]);
  });
});

describe("maintainer operations authorization", () => {
  it("guards every note and escalation endpoint with real RBAC", async () => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    const resolver: PrincipalResolver = async (req) => req.headers.authorization === "admin" ? admin : req.headers.authorization === "user" ? user : null;
    app.register(maintainerOperationsRoutes(notes, escalations, {
      read: requirePermission("admin.recovery.read", [resolver]), write: requirePermission("admin.recovery.write", [resolver]),
    }));
    await app.ready();
    try {
      for (const authorization of [undefined, "user"]) {
        for (const url of ["/admin/notes?scopeType=failure&scopeId=case-1", "/admin/escalations", "/admin/escalations/policies"]) {
          expect((await app.inject({ url, headers: authorization ? { authorization } : {} })).statusCode).toBe(authorization ? 403 : 401);
        }
      }
      const result = await app.inject({ method: "POST", url: "/admin/notes", headers: { authorization: "admin" }, payload: noteInput });
      expect(result.statusCode).toBe(201);
      expect((await app.inject({ url: "/admin/escalations", headers: { authorization: "admin" } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
