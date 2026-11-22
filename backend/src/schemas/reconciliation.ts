import { z } from "zod";

export const approveProposalBody = z.object({
  approver_id: z.string().min(1).max(200),
  diff_hash: z.string().length(64)
});

export const executeProposalBody = z.object({
  executor_id: z.string().min(1).max(200)
});

export const createProposalBody = z.object({
  proposer_id: z.string().min(1).max(200),
  dry_run: z.boolean().optional()
});

export const manualRepairBody = z.object({
  target_type: z.enum([
    "missing_event",
    "missing_action",
    "stale_orphan",
    "orphaned_settlement",
    "stale_pending_event",
    "contradiction",
    "missing_settlement",
    "insolvency_drift"
  ]),
  target_id: z.string().min(1).max(300),
  apply: z.boolean().optional(),
  actor: z.string().min(1).max(200)
});
