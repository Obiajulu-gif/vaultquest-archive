import { z } from "zod";

export const savedPoolStatus = z.enum(["open", "locked", "drawing", "settled"]);

export const savedPoolRecord = z.object({
  pool_id: z.string().min(1).max(120),
  pool_name: z.string().min(1).max(200),
  status: savedPoolStatus,
  tvl: z.string().min(1).max(120),
  asset: z.string().min(1).max(32),
  participant_count: z.coerce.number().int().min(0),
  expected_yield: z.string().min(1).max(120),
  prize: z.string().max(120).optional().nullable(),
  opens_at: z.string().datetime({ offset: true }).optional().nullable(),
  locks_at: z.string().datetime({ offset: true }).optional().nullable(),
  draws_at: z.string().datetime({ offset: true }).optional().nullable()
});

export const savedPoolUpsertBody = z.object({
  wallet_address: z.string().min(1).max(120),
  pool: savedPoolRecord
});

export const savedPoolListQuery = z.object({
  wallet: z.string().min(1).max(120),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const savedPoolDeleteParams = z.object({
  poolId: z.string().min(1).max(120)
});
