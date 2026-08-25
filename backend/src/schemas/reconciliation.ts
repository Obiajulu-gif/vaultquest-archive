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
