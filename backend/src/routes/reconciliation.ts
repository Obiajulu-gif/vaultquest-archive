import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { detectDrift, buildRepairPlan, createRepairProposal, approveRepairProposal, executeRepairProposal } from "../services/reconciler.js";
import { requirePermission, serviceSecretResolver } from "../middleware/rbac.js";
import { validateBody } from "../middleware/validate.js";
import { createProposalBody, approveProposalBody, executeProposalBody } from "../schemas/reconciliation.js";
import { ok } from "../responses.js";
import type { z } from "zod";

/**
 * Admin-only reconciliation repair workflow (#597): propose -> approve ->
 * execute, gated behind the same internal-service secret as other
 * privileged endpoints (see `internal.ts`). Not exposed to end users.
 */
export const reconciliationRoutes = (prisma: PrismaClient, secret: string): FastifyPluginAsync =>
  async (app) => {
    const service = serviceSecretResolver(secret);
    const guard = (perm: Parameters<typeof requirePermission>[0]) => requirePermission(perm, [service]);

    app.post("/internal/reconciliation/proposals", {
      preHandler: [guard("internal.reconciliation.propose"), validateBody(createProposalBody)]
    }, async (req) => {
      const body = req.body as z.infer<typeof createProposalBody>;
      const drifts = await detectDrift(prisma);
      const plan = buildRepairPlan(drifts, body.dry_run ?? false);
      const proposal = await createRepairProposal(prisma, plan, body.proposer_id);
      return ok({ proposal });
    });

    app.post("/internal/reconciliation/proposals/:id/approve", {
      preHandler: [guard("internal.reconciliation.approve"), validateBody(approveProposalBody)]
    }, async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof approveProposalBody>;
      const proposal = await approveRepairProposal(prisma, id, body.approver_id, body.diff_hash);
      return ok({ proposal });
    });

    app.post("/internal/reconciliation/proposals/:id/execute", {
      preHandler: [guard("internal.reconciliation.execute"), validateBody(executeProposalBody)]
    }, async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof executeProposalBody>;
      const result = await executeRepairProposal(prisma, id, body.executor_id);
      return ok(result);
    });
  };
