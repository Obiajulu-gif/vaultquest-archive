import { z } from "zod";
import { IMPORT_KINDS, IMPORT_LIMITS } from "../services/importService.js";

export const importPreviewBody = z.object({
  kind: z.enum(IMPORT_KINDS),
  content: z.string().min(1).max(IMPORT_LIMITS.maxContentBytes),
  source_name: z.string().max(200).optional(),
  created_by: z.string().min(1).max(200),
  idempotency_key: z.string().uuid().optional()
});

export const importBatchParams = z.object({
  id: z.string().uuid()
});
