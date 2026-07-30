import { z } from "zod";
import { ACTION_TYPES, ACTION_STATUSES } from "../constants.js";

export const walletSchema = z.string().min(1).max(120);
export const idempotencyKeySchema = z.string().uuid();

export const createActionBody = z.object({
  wallet_address: walletSchema,
  action_type: z.enum(ACTION_TYPES),
  action_payload: z.record(z.unknown())
});

export const attachTxBody = z.object({
  tx_hash: z.string().min(4).max(200)
});

export const cancelBody = z.object({
  error_code: z.string().min(1).max(64),
  error_detail: z.string().max(1000).optional()
});

export const listQuery = z.object({
  wallet: walletSchema,
  status: z.enum(ACTION_STATUSES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const reconcileBody = z.object({
  tx_hash: z.string().min(4).max(200),
  soroban_event_id: z.string().min(1).max(200),
  event_payload: z.record(z.unknown()),
  status_hint: z.enum(["confirmed", "reverted"])
});

export const dashboardQuery = z.object({
  wallet: walletSchema,
  stale_after_ms: z.coerce.number().int().min(0).max(24 * 60 * 60 * 1000).optional()
});

export const stellarWalletAddressSchema = z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar wallet address");

export const portfolioQuery = z.object({
  wallet: stellarWalletAddressSchema
});

export const checkpointBody = z.object({
  latest_ledger: z.number().int().nonnegative(),
  last_processed_event_id: z.string().min(1).max(200).nullable().optional(),
  last_error: z.string().nullable().optional(),
  success: z.boolean().default(true)
});


export const exportQuery = z.object({
  wallet: walletSchema,
  format: z.enum(["json", "csv"]).default("json"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
});

export const actionHistoryQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(ACTION_TYPES).optional(),
  status: z.enum(ACTION_STATUSES).optional(),
});
