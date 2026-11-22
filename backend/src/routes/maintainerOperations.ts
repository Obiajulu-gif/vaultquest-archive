import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { Principal } from "../middleware/rbac.js";
import { ok } from "../responses.js";
import { createNoteInput, editNoteInput, noteScope, type MaintainerNotesService } from "../services/maintainerNotes.js";
import { escalationPolicyInput, escalationSeverity, type FailureEscalationService } from "../services/failureEscalation.js";

const params = z.object({ id: z.string().uuid() });
const versionBody = z.object({ version: z.number().int().positive() }).strict();
function actor(req: FastifyRequest): Principal {
  if (!req.principal) throw AppError.unauthorized();
  return req.principal;
}

export const maintainerOperationsRoutes = (
  notes: MaintainerNotesService, escalations: FailureEscalationService,
  guards: { read: preHandlerHookHandler; write: preHandlerHookHandler },
): FastifyPluginAsync => async (app) => {
  app.post("/admin/notes", { preHandler: guards.write }, async (req, reply) => {
    const note = await notes.create(actor(req), createNoteInput.parse(req.body));
    return reply.code(201).send(ok(note));
  });
  app.get("/admin/notes", { preHandler: guards.read }, async (req) => {
    const q = z.object({ scopeType: noteScope, scopeId: z.string().min(1).max(200),
      includeArchived: z.enum(["true", "false"]).default("false") }).parse(req.query);
    return ok(await notes.list(actor(req), q.scopeType, q.scopeId, q.includeArchived === "true"));
  });
  app.get("/admin/notes/:id", { preHandler: guards.read }, async (req) =>
    ok(await notes.get(actor(req), params.parse(req.params).id)));
  app.patch("/admin/notes/:id", { preHandler: guards.write }, async (req) => {
    const { version, ...data } = editNoteInput.extend({ version: z.number().int().positive() }).parse(req.body);
    return ok(await notes.edit(actor(req), params.parse(req.params).id, version, data));
  });
  for (const action of ["redact", "archive"] as const) {
    app.post(`/admin/notes/:id/${action}`, { preHandler: guards.write }, async (req) =>
      ok(await notes[action](actor(req), params.parse(req.params).id, versionBody.parse(req.body).version)));
  }
  app.get("/admin/escalations/policies", { preHandler: guards.read }, async () => ok(await escalations.policies()));
  app.put("/admin/escalations/policies/:severity", { preHandler: guards.write }, async (req) => {
    const { severity } = z.object({ severity: escalationSeverity }).parse(req.params);
    return ok(await escalations.configure(severity, actor(req).subject, escalationPolicyInput.parse(req.body)));
  });
  app.get("/admin/escalations", { preHandler: guards.read }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(req.query);
    return ok(await escalations.report(limit));
  });
  app.post("/admin/escalations/evaluate", { preHandler: guards.write }, async (req) => {
    const body = z.object({ cursor: z.string().uuid().optional() }).parse(req.body ?? {});
    return ok(await escalations.evaluate(100, body.cursor));
  });
  app.post("/admin/escalations/:id/acknowledge", { preHandler: guards.write }, async (req) =>
    ok(await escalations.acknowledge(params.parse(req.params).id, actor(req).subject)));
};

/** One bounded tick per minute. The database row locks make multiple replicas safe. */
export function startMaintainerOperations(
  notes: MaintainerNotesService, escalations: FailureEscalationService,
  onError: (error: unknown) => void,
) {
  let cursor: string | undefined;
  let pending: Promise<void> | undefined;
  const tick = () => {
    if (pending) return;
    pending = (async () => {
      await notes.expire();
      cursor = (await escalations.evaluate(100, cursor)).nextCursor ?? undefined;
    })().catch(onError).finally(() => { pending = undefined; });
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  tick();
  return async () => { clearInterval(timer); await pending; };
}
