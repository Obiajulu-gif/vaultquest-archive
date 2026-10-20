import { z } from "zod";
import { PUBLIC_ACTIVITY_TYPES } from "../services/publicActivity.js";

export const publicActivityQuery = z.object({
  wallet: z.string().min(1).max(120),
  type: z.enum(PUBLIC_ACTIVITY_TYPES).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20)
});