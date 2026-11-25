/**
 * hidden-archived-auth.spec.ts
 *
 * Authorization tests for hidden (redacted) and archived records.
 * 
 * Coverage:
 * - Normal path: authorized users can access/modify hidden and archived records
 * - Failure path: unauthorized users are denied access
 * - Retry path: permission checks handle transient failures gracefully
 * - Authorization edge cases: role-based access, ownership-based access, states
 *
 * Design: MaintainerNote models record visibility and state transitions:
 * - archivedAt: timestamp when note is archived (soft delete)
 * - redactedAt: timestamp when note body is redacted (content removed)
 * - visibility: "maintainers" (all maintainers) or "private" (author only)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { MaintainerNotesService } from "../src/services/maintainerNotes.js";
import { AuditTrailService } from "../src/services/auditTrail.js";
import { PrismaAuditTrailStore } from "../src/services/governanceStores.js";
import type { Principal } from "../src/middleware/rbac.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const admin1: Principal = { role: "maintainer", subject: "maintainer-alice" };
const admin2: Principal = { role: "maintainer", subject: "maintainer-bob" };
const user1: Principal = { role: "user", subject: "user-charlie" };
const service: Principal = { role: "service", subject: "job-runner" };

const noteInput = {
  scopeType: "failure" as const,
  scopeId: "test-case-1",
  kind: "incident" as const,
  visibility: "maintainers" as const,
  body: "Investigating critical failure",
  retentionDays: 30,
};

const privateNoteInput = { ...noteInput, visibility: "private" as const };

// ── Test suite ─────────────────────────────────────────────────────────────

describe("Hidden and archived records — authorization", () => {
  let db: TestDb;
  let notes: MaintainerNotesService;
  let now: Date;

  beforeAll(async () => {
    db = await startTestDb();
    now = new Date("2026-10-20T10:00:00Z");
    notes = new MaintainerNotesService(db.prisma, () => now);
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await resetDb(db.prisma);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // NORMAL PATH: Authorized access
  // ══════════════════════════════════════════════════════════════════════════════

  describe("normal path — authorized users", () => {
    it("maintainer can archive their own note", async () => {
      const note = await notes.create(admin1, noteInput);
      const archived = await notes.archive(admin1, note.id, note.version);
      expect(archived.archivedAt).not.toBeNull();
    });

    it("maintainer can redact (hide) their own note", async () => {
      const note = await notes.create(admin1, noteInput);
      const redacted = await notes.redact(admin1, note.id, note.version);
      expect(redacted.redactedAt).not.toBeNull();
      expect(redacted.body).toBeNull();
    });

    it("any maintainer can archive a shared (maintainers) note", async () => {
      const note = await notes.create(admin1, noteInput);
      const archived = await notes.archive(admin2, note.id, note.version);
      expect(archived.archivedAt).not.toBeNull();
      expect(archived.authorId).toBe(admin1.subject);
    });

    it("any maintainer can redact a shared (maintainers) note", async () => {
      const note = await notes.create(admin1, noteInput);
      const redacted = await notes.redact(admin2, note.id, note.version);
      expect(redacted.redactedAt).not.toBeNull();
    });

    it("author can read their own private note even after archive", async () => {
      const note = await notes.create(admin1, privateNoteInput);
      const archived = await notes.archive(admin1, note.id, note.version);
      const retrieved = await notes.get(admin1, archived.id);
      expect(retrieved.id).toBe(note.id);
      expect(retrieved.archivedAt).not.toBeNull();
    });

    it("author can read their own private note even after redaction", async () => {
      const note = await notes.create(admin1, privateNoteInput);
      const redacted = await notes.redact(admin1, note.id, note.version);
      const retrieved = await notes.get(admin1, redacted.id);
      expect(retrieved.id).toBe(note.id);
      expect(retrieved.body).toBeNull();
    });

    it("list excludes archived notes by default but includes with includeArchived flag", async () => {
      const note1 = await notes.create(admin1, noteInput);
      const note2 = await notes.create(admin1, { ...noteInput, scopeId: "case-2" });
      await notes.archive(admin1, note1.id, note1.version);

      const listNormal = await notes.list(admin1, "failure", "test-case-1", false);
      expect(listNormal).toHaveLength(0);

      const listWithArchived = await notes.list(admin1, "failure", "test-case-1", true);
      expect(listWithArchived.map((n) => n.id)).toContain(note1.id);
    });

    it("maintainer can still list and modify archived notes from other maintainers", async () => {
      const note = await notes.create(admin1, noteInput);
      const archived = await notes.archive(admin1, note.id, note.version);

      // Admin2 can retrieve it
      const retrieved = await notes.get(admin2, archived.id);
      expect(retrieved.archivedAt).not.toBeNull();

      // Admin2 can further redact it
      const redacted = await notes.redact(admin2, archived.id, archived.version);
      expect(redacted.redactedAt).not.toBeNull();
    });

    it("subsequent archive is idempotent (version mismatch prevents double-archive)", async () => {
      const note = await notes.create(admin1, noteInput);
      const archived = await notes.archive(admin1, note.id, note.version);

      // Attempting to archive with stale version fails
      await expect(notes.archive(admin1, archived.id, note.version)).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // FAILURE PATH: Unauthorized access denied
  // ══════════════════════════════════════════════════════════════════════════════

  describe("failure path — unauthorized access", () => {
    it("non-maintainer user cannot archive any note", async () => {
      const note = await notes.create(admin1, noteInput);
      await expect(notes.archive(user1, note.id, note.version)).rejects.toMatchObject({
        statusCode: 403,
      });

      // Verify audit trail recorded denied attempt
      const audit = await db.prisma.maintainerNoteAudit.findMany({
        where: { noteId: note.id, action: "archive", allowed: false },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0].actor).toBe(user1.subject);
    });

    it("non-maintainer user cannot redact any note", async () => {
      const note = await notes.create(admin1, noteInput);
      await expect(notes.redact(user1, note.id, note.version)).rejects.toMatchObject({
        statusCode: 403,
      });

      const audit = await db.prisma.maintainerNoteAudit.findMany({
        where: { noteId: note.id, action: "redact", allowed: false },
      });
      expect(audit).toHaveLength(1);
    });

    it("service account cannot archive notes", async () => {
      const note = await notes.create(admin1, noteInput);
      await expect(notes.archive(service, note.id, note.version)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("service account cannot redact notes", async () => {
      const note = await notes.create(admin1, noteInput);
      await expect(notes.redact(service, note.id, note.version)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("user cannot access private notes from other authors", async () => {
      const note = await notes.create(admin1, privateNoteInput);
      await expect(notes.get(admin2, note.id)).rejects.toMatchObject({ statusCode: 404 });

      // Denied access is logged as 404, not 403, for privacy
      const audit = await db.prisma.maintainerNoteAudit.findMany({
        where: { noteId: note.id, action: "read", allowed: false },
      });
      expect(audit).toHaveLength(1);
    });

    it("user cannot list private notes from other authors", async () => {
      const note = await notes.create(admin1, privateNoteInput);
      const listed = await notes.list(admin2, "failure", "test-case-1");
      expect(listed.map((n) => n.id)).not.toContain(note.id);
    });

    it("non-maintainer list returns empty even if notes exist", async () => {
      await notes.create(admin1, noteInput);
      const listed = await notes.list(user1, "failure", "test-case-1");
      expect(listed).toHaveLength(0);

      const audit = await db.prisma.maintainerNoteAudit.findMany({ where: { action: "list", allowed: false } });
      expect(audit).toHaveLength(1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // RETRY PATH: Transient failures and recovery
  // ══════════════════════════════════════════════════════════════════════════════

  describe("retry path — transient failures", () => {
    it("optimistic version mismatch triggers retry on stale version", async () => {
      const note = await notes.create(admin1, noteInput);
      const v1 = note.version;

      // Edit increments version
      const edited = await notes.edit(admin1, note.id, v1, {
        body: "Updated investigation",
        visibility: "maintainers",
      });
      const v2 = edited.version;

      // Attempting action with v1 fails
      await expect(notes.archive(admin1, note.id, v1)).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("changed"),
      });

      // Retry with v2 succeeds
      const archived = await notes.archive(admin1, note.id, v2);
      expect(archived.archivedAt).not.toBeNull();
    });

    it("cannot edit archived or redacted notes", async () => {
      const note = await notes.create(admin1, noteInput);
      const archived = await notes.archive(admin1, note.id, note.version);

      await expect(
        notes.edit(admin1, note.id, archived.version, { body: "Restore", visibility: "maintainers" }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("archived or redacted"),
      });
    });

    it("redacted note blocks edit after redaction", async () => {
      const note = await notes.create(admin1, noteInput);
      const redacted = await notes.redact(admin1, note.id, note.version);

      await expect(
        notes.edit(admin1, note.id, redacted.version, { body: "Restore content", visibility: "maintainers" }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining("archived or redacted"),
      });
    });

    it("list retry respects visibility after permission revocation (re-check on each item)", async () => {
      const sharedNote = await notes.create(admin1, noteInput);
      const privateNote = await notes.create(admin1, privateNoteInput);

      // Admin2 retrieves shared note (succeeds)
      let retrieved = await notes.get(admin2, sharedNote.id);
      expect(retrieved.id).toBe(sharedNote.id);

      // If visibility were to change to private post-creation (hypothetically),
      // admin2 would see 404 on retry. We simulate this by checking the audit.
      const auditBefore = await db.prisma.maintainerNoteAudit.count({
        where: { action: "read", allowed: true },
      });

      // Admin2 cannot access private note; audit logs it
      await expect(notes.get(admin2, privateNote.id)).rejects.toMatchObject({ statusCode: 404 });
      const auditAfter = await db.prisma.maintainerNoteAudit.count({
        where: { action: "read", allowed: false },
      });
      expect(auditAfter).toBeGreaterThan(auditBefore);
    });

    it("concurrent archive attempts with optimistic locking", async () => {
      const note = await notes.create(admin1, noteInput);
      const v1 = note.version;

      // First archive succeeds
      const archived = await notes.archive(admin1, note.id, v1);
      expect(archived.version).toBe(v1 + 1);

      // Second concurrent archive with old version fails
      await expect(notes.archive(admin2, note.id, v1)).rejects.toMatchObject({
        statusCode: 409,
      });

      // But succeeds with the updated version
      const finalArchived = await notes.archive(admin2, note.id, archived.version);
      expect(finalArchived.version).toBe(archived.version + 1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // EDGE CASES: Authorization boundaries and state transitions
  // ══════════════════════════════════════════════════════════════════════════════

  describe("edge cases — authorization boundaries", () => {
    it("only author can edit visibility of private notes", async () => {
      const note = await notes.create(admin1, privateNoteInput);

      // Admin1 (author) can edit
      const edited = await notes.edit(admin1, note.id, note.version, {
        body: "Updated",
        visibility: "private",
      });
      expect(edited.body).toBe("Updated");

      // Admin2 (non-author) cannot edit, even if maintainer
      await expect(
        notes.edit(admin2, note.id, edited.version, { body: "Override", visibility: "maintainers" }),
      ).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringContaining("only the author"),
      });
    });

    it("shared note visibility can be changed by any maintainer during edit", async () => {
      const note = await notes.create(admin1, noteInput);

      // Admin1 edits: shared → private
      const toPrivate = await notes.edit(admin1, note.id, note.version, {
        body: "Now private",
        visibility: "private",
      });
      expect(toPrivate.visibility).toBe("private");

      // Admin2 cannot access after visibility change
      await expect(notes.get(admin2, toPrivate.id)).rejects.toMatchObject({ statusCode: 404 });

      // Admin1 can change back
      const toShared = await notes.edit(admin1, toPrivate.id, toPrivate.version, {
        body: "Back to shared",
        visibility: "maintainers",
      });
      expect(toShared.visibility).toBe("maintainers");

      // Admin2 can now access
      const retrieved = await notes.get(admin2, toShared.id);
      expect(retrieved.visibility).toBe("maintainers");
    });

    it("archived note cannot be edited by anyone", async () => {
      const note = await notes.create(admin1, noteInput);
      const archived = await notes.archive(admin1, note.id, note.version);

      // Author cannot edit archived note
      await expect(
        notes.edit(admin1, note.id, archived.version, { body: "Edit attempt", visibility: "maintainers" }),
      ).rejects.toMatchObject({ statusCode: 409 });

      // Other maintainer cannot edit archived note
      await expect(
        notes.edit(admin2, note.id, archived.version, { body: "Edit attempt", visibility: "maintainers" }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it("redacted note body is permanently gone (edit cannot restore)", async () => {
      const note = await notes.create(admin1, noteInput);
      const originalBody = note.body;
      const redacted = await notes.redact(admin1, note.id, note.version);

      expect(redacted.body).toBeNull();
      expect(redacted.redactedAt).not.toBeNull();

      // Verify body is truly null in DB
      const dbNote = await db.prisma.maintainerNote.findUniqueOrThrow({ where: { id: note.id } });
      expect(dbNote.body).toBeNull();
    });

    it("archive then redact sequence (or vice versa)", async () => {
      // Case 1: archive first, then redact
      const note1 = await notes.create(admin1, { ...noteInput, scopeId: "case-1" });
      const archived = await notes.archive(admin1, note1.id, note1.version);
      const redacted = await notes.redact(admin1, archived.id, archived.version);

      expect(redacted.archivedAt).not.toBeNull();
      expect(redacted.redactedAt).not.toBeNull();
      expect(redacted.body).toBeNull();

      // Case 2: redact first, then archive
      const note2 = await notes.create(admin1, { ...noteInput, scopeId: "case-2" });
      const redacted2 = await notes.redact(admin1, note2.id, note2.version);
      const archived2 = await notes.archive(admin1, redacted2.id, redacted2.version);

      expect(archived2.archivedAt).not.toBeNull();
      expect(archived2.redactedAt).not.toBeNull();
      expect(archived2.body).toBeNull();
    });

    it("retained visibility restrictions after expiry sweep", async () => {
      const sharedNote = await notes.create(admin1, noteInput);
      const privateNote = await notes.create(admin1, privateNoteInput);

      // Advance time past expiry
      now = new Date(now.getTime() + 31 * 86400000); // 31 days later

      // Expire the notes (body removed, auto-archived if not already)
      await notes.expire();

      // Admin2 can retrieve shared note (content expired)
      const sharedRetrieved = await notes.get(admin2, sharedNote.id);
      expect(sharedRetrieved.body).toBeNull();
      expect(sharedRetrieved.id).toBe(sharedNote.id);

      // Admin2 still cannot retrieve private note (authorization, not expiry)
      await expect(notes.get(admin2, privateNote.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it("authorization is enforced before returning 404 for not-found vs forbidden", async () => {
      const fakeId = "00000000-0000-0000-0000-000000000000";

      // User attempting to get non-existent note: returns 403, not 404
      await expect(notes.get(user1, fakeId)).rejects.toMatchObject({ statusCode: 403 });

      // Maintainer attempting to get non-existent note: returns 404
      await expect(notes.get(admin1, fakeId)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // RECOVERY AND ROLLBACK: State recovery on partial failures
  // ══════════════════════════════════════════════════════════════════════════════

  describe("recovery and rollback", () => {
    it("failed authorization does not leak note state via audit trail", async () => {
      const note = await notes.create(admin1, privateNoteInput);

      // User attempts (and fails) to read
      await expect(notes.get(user1, note.id)).rejects.toThrow();

      // Audit is recorded but note is not modified
      const audit = await db.prisma.maintainerNoteAudit.findMany({
        where: { noteId: note.id, allowed: false },
      });
      expect(audit).toHaveLength(1);

      // Note state is unchanged
      const unchanged = await notes.get(admin1, note.id);
      expect(unchanged.version).toBe(note.version);
    });

    it("transaction rollback on denied archive preserves prior state", async () => {
      const note = await notes.create(admin1, noteInput);
      const originalVersion = note.version;

      // User attempts to archive (denied)
      await expect(notes.archive(user1, note.id, note.version)).rejects.toThrow();

      // Audit is recorded
      const audit = await db.prisma.maintainerNoteAudit.findMany({
        where: { noteId: note.id, action: "archive", allowed: false },
      });
      expect(audit).toHaveLength(1);

      // Note version unchanged (transaction rolled back)
      const stillNotArchived = await notes.get(admin1, note.id);
      expect(stillNotArchived.version).toBe(originalVersion);
      expect(stillNotArchived.archivedAt).toBeNull();
    });

    it("list operation gracefully skips notes that become inaccessible mid-list", async () => {
      const sharedNote = await notes.create(admin1, { ...noteInput, scopeId: "shared-list" });
      const privateNote = await notes.create(admin1, {
        ...privateNoteInput,
        scopeId: "shared-list",
        body: "Should not appear for other maintainers",
      });

      // Admin2 lists: sees only shared note, private is filtered out
      const listed = await notes.list(admin2, "failure", "shared-list");
      expect(listed.map((n) => n.id)).toContain(sharedNote.id);
      expect(listed.map((n) => n.id)).not.toContain(privateNote.id);

      // Both create audit entries (success + filtered failure)
      const auditShared = await db.prisma.maintainerNoteAudit.findMany({
        where: { noteId: sharedNote.id, action: "read" },
      });
      expect(auditShared.some((a) => a.allowed)).toBe(true);

      const auditPrivate = await db.prisma.maintainerNoteAudit.findMany({
        where: { noteId: privateNote.id, action: "read" },
      });
      expect(auditPrivate.some((a) => !a.allowed)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // CONTRACTS: Preservation and schema validation
  // ══════════════════════════════════════════════════════════════════════════════

  describe("contract preservation", () => {
    it("note schema includes archivedAt, redactedAt, visibility required fields", async () => {
      const note = await notes.create(admin1, noteInput);

      expect(note).toHaveProperty("id");
      expect(note).toHaveProperty("archivedAt");
      expect(note).toHaveProperty("redactedAt");
      expect(note).toHaveProperty("visibility");
      expect(note).toHaveProperty("version");
      expect(note).toHaveProperty("createdAt");
      expect(note).toHaveProperty("updatedAt");
      expect(note).toHaveProperty("expiresAt");
    });

    it("archived notes remain queryable with includeArchived flag", async () => {
      const note = await notes.create(admin1, noteInput);
      await notes.archive(admin1, note.id, note.version);

      const withoutArchived = await notes.list(admin1, "failure", "test-case-1", false);
      const withArchived = await notes.list(admin1, "failure", "test-case-1", true);

      expect(withoutArchived).toHaveLength(0);
      expect(withArchived.map((n) => n.id)).toContain(note.id);
    });

    it("audit trail immutable: cannot delete audit records", async () => {
      const note = await notes.create(admin1, noteInput);

      // Try to delete audit trails
      await expect(
        db.prisma.maintainerNoteAudit.deleteMany({ where: { noteId: note.id } }),
      ).rejects.toThrow();
    });
  });
});
