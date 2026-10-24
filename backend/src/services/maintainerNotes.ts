import type { MaintainerNote, Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { AuditActor } from "./auditTrail.js";

export const noteScope = z.enum(["action", "failure", "wallet", "pool"]);
export const createNoteInput = z.object({
  scopeType: noteScope,
  scopeId: z.string().trim().min(1).max(200),
  kind: z.enum(["support", "incident", "decision"]),
  visibility: z.enum(["maintainers", "private"]),
  body: z.string().trim().min(1).max(10000),
  retentionDays: z.number().int().min(1).max(365).default(90),
}).strict();
export const editNoteInput = z.object({
  body: z.string().trim().min(1).max(10000),
  visibility: z.enum(["maintainers", "private"]),
}).strict();

/** Body lifetime is bounded at creation; neither editing nor archiving extends it. */
export class MaintainerNotesService {
  constructor(private readonly prisma: PrismaClient, private readonly now = () => new Date()) {}

  private async requireMaintainer(actor: AuditActor, action: string): Promise<void> {
    if (actor.role === "maintainer") return;
    await this.prisma.maintainerNoteAudit.create({
      data: { actor: actor.subject, action, allowed: false },
    });
    throw AppError.forbidden();
  }

  async create(actor: AuditActor, input: z.input<typeof createNoteInput>): Promise<MaintainerNote> {
    await this.requireMaintainer(actor, "create");
    const data = createNoteInput.parse(input);
    const now = this.now();
    return this.prisma.$transaction(async (tx) => {
      const note = await tx.maintainerNote.create({ data: {
        scopeType: data.scopeType, scopeId: data.scopeId, kind: data.kind,
        visibility: data.visibility, body: data.body, authorId: actor.subject,
        expiresAt: new Date(now.getTime() + data.retentionDays * 86400000),
        createdAt: now,
      } });
      await this.audit(tx, note, actor.subject, "create", true);
      return note;
    });
  }

  /** Denied access is committed to the audit table before returning an error. */
  private async access(
    actor: AuditActor, id: string, action: string,
    change?: (tx: Prisma.TransactionClient, note: MaintainerNote) => Promise<MaintainerNote>,
  ): Promise<MaintainerNote> {
    await this.requireMaintainer(actor, action);
    const outcome = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM maintainer_notes WHERE id = ${id}::uuid FOR UPDATE`;
      const note = await tx.maintainerNote.findUnique({ where: { id } });
      if (!note) return { error: AppError.notFound("note not found") };
      if (note.visibility === "private" && note.authorId !== actor.subject) {
        await this.audit(tx, note, actor.subject, action, false);
        return { error: AppError.notFound("note not found") };
      }
      // Retention is enforced on reads too, even if the sweep was delayed.
      let current = note;
      if (note.body !== null && note.expiresAt <= this.now()) {
        current = await tx.maintainerNote.update({ where: { id }, data: {
          body: null, redactedAt: this.now(), archivedAt: note.archivedAt ?? this.now(), version: { increment: 1 },
        } });
        await this.audit(tx, current, "retention", "expire", true);
      }
      try {
        const result = change ? await change(tx, current) : current;
        await this.audit(tx, result, actor.subject, action, true);
        return { note: result };
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        await this.audit(tx, current, actor.subject, action, false);
        return { error };
      }
    });
    if (outcome.error) throw outcome.error;
    return outcome.note!;
  }

  get(actor: AuditActor, id: string): Promise<MaintainerNote> {
    return this.access(actor, id, "read");
  }

  async list(actor: AuditActor, scopeType: z.infer<typeof noteScope>, scopeId: string, includeArchived = false) {
    await this.requireMaintainer(actor, "list");
    const ids = await this.prisma.maintainerNote.findMany({
      where: { scopeType, scopeId,
        OR: [{ visibility: "maintainers" }, { authorId: actor.subject }],
        ...(includeArchived ? {} : { archivedAt: null, expiresAt: { gt: this.now() } }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true },
    });
    // Access is rechecked under the row lock, including changes to visibility.
    const notes: MaintainerNote[] = [];
    for (const { id } of ids) {
      try { notes.push(await this.get(actor, id)); }
      catch (error) { if (!(error instanceof AppError) || error.statusCode !== 404) throw error; }
    }
    return notes;
  }

  edit(actor: AuditActor, id: string, version: number, input: z.infer<typeof editNoteInput>) {
    const data = editNoteInput.parse(input);
    return this.mutate(actor, id, version, "edit", (note) => {
      if (note.archivedAt || note.redactedAt) throw AppError.conflict("ILLEGAL_TRANSITION", "note is archived or redacted");
      // Only the author can change visibility; readers cannot hide a shared note.
      if (note.authorId !== actor.subject) throw AppError.forbidden("only the author may edit a note");
      return data;
    });
  }

  redact(actor: AuditActor, id: string, version: number) {
    return this.mutate(actor, id, version, "redact", () => ({ body: null, redactedAt: this.now() }));
  }

  archive(actor: AuditActor, id: string, version: number) {
    return this.mutate(actor, id, version, "archive", () => ({ archivedAt: this.now() }));
  }

  private mutate(actor: AuditActor, id: string, version: number, action: string,
    data: (note: MaintainerNote) => Prisma.MaintainerNoteUpdateInput) {
    return this.access(actor, id, action, async (tx, note) => {
      if (note.version !== version) throw AppError.conflict("ILLEGAL_TRANSITION", "note changed; reload its current version");
      return tx.maintainerNote.update({ where: { id }, data: { ...data(note), version: { increment: 1 } } });
    });
  }

  async expire(limit = 100): Promise<number> {
    const ids = await this.prisma.maintainerNote.findMany({
      where: { expiresAt: { lte: this.now() }, body: { not: null } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }], take: limit, select: { id: true },
    });
    let expired = 0;
    for (const { id } of ids) {
      expired += await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM maintainer_notes WHERE id = ${id}::uuid FOR UPDATE`;
        const note = await tx.maintainerNote.findUnique({ where: { id } });
        if (!note || note.body === null || note.expiresAt > this.now()) return 0;
        const updated = await tx.maintainerNote.update({ where: { id }, data: {
          body: null, redactedAt: this.now(), archivedAt: note.archivedAt ?? this.now(), version: { increment: 1 },
        } });
        await this.audit(tx, updated, "retention", "expire", true);
        return 1;
      });
    }
    return expired;
  }

  private audit(tx: Prisma.TransactionClient, note: MaintainerNote, actor: string, action: string, allowed: boolean) {
    return tx.maintainerNoteAudit.create({ data: { noteId: note.id, actor, action, allowed, version: note.version } });
  }
}
