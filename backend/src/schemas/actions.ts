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

export const actionCheckpointBody = z.object({
  stage: z.literal("external_action_started")
});

export const listQuery = z.object({
  wallet: walletSchema,
  status: z.enum(ACTION_STATUSES).optional(),
  type: z.enum(ACTION_TYPES).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export const reconcileBody = z.object({
  tx_hash: z.string().min(4).max(200),
  soroban_event_id: z.string().min(1).max(200),
  event_payload: z.record(z.unknown()),
  status_hint: z.enum(["confirmed", "reverted"]),
  /** Emitting ledger's close time (#751); becomes the action's confirmedAt. */
  ledger_closed_at: z.string().datetime().optional()
});

/** Same bounds as reconcileBody.tx_hash (#753). */
export const traceParams = z.object({
  txHash: z.string().min(4).max(200)
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
  action_type: z.enum(ACTION_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
});

export const actionHistoryQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(ACTION_TYPES).optional(),
  status: z.enum(ACTION_STATUSES).optional(),
});

/**
 * Versioned API response contracts (VAULTQUEST_API_VERSION).
 *
 * These schemas describe the stable shape of core API responses exposed to
 * contributor integrations. Every response envelope carries the contract
 * version so consumers can detect breaking changes early. Additive fields
 * are allowed within a major version; removing or retyping a field requires a
 * major version bump.
 */
export const API_CONTRACT_VERSION = "1.0.0" as const;

export const apiVersionSchema = z.literal(API_CONTRACT_VERSION);

/** Standard error codes exposed to integrators. */
export const API_ERROR_CODES = [
  "validation_error",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const apiErrorDetailSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1).max(1000),
  field: z.string().min(1).max(200).optional(),
});

export const apiErrorResponseSchema = z.object({
  version: apiVersionSchema,
  ok: z.literal(false),
  error: apiErrorDetailSchema,
});

export const apiSuccessEnvelope = <T extends z.ZodType<any>>(data: T) =>
  z.object({
    version: apiVersionSchema,
    ok: z.literal(true),
    data,
  });

export const actionStatusSchema = z.enum(ACTION_STATUSES);

export const actionResponseSchema = z.object({
  id: z.string().uuid(),
  wallet_address: walletSchema,
  action_type: z.enum(ACTION_TYPES),
  status: actionStatusSchema,
  tx_hash: z.string().min(4).max(200).nullable(),
  created_at: z.string().datetime(),
  confirmed_at: z.string().datetime().nullable(),
});

export const actionListResponseSchema = apiSuccessEnvelope(
  z.object({
    items: z.array(actionResponseSchema),
    next_cursor: z.string().uuid().nullable(),
  }),
);

export const dashboardResponseSchema = apiSuccessEnvelope(
  z.object({
    wallet_address: walletSchema,
    total_deposited: z.string(),
    total_prizes_won: z.string(),
    active_actions: z.number().int().nonnegative(),
    generated_at: z.string().datetime(),
  }),
);

export const portfolioResponseSchema = apiSuccessEnvelope(
  z.object({
    wallet_address: stellarWalletAddressSchema,
    vaults: z.array(
      z.object({
        vault_id: z.string().min(1).max(200),
        balance: z.string(),
        last_updated_at: z.string().datetime(),
      }),
    ),
  }),
);

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type ActionResponse = z.infer<typeof actionResponseSchema>;
export type ActionListResponse = z.infer<typeof actionListResponseSchema>;
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;
export type PortfolioResponse = z.infer<typeof portfolioResponseSchema>
export const publicActivityQuery = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(ACTION_TYPES).optional(),
  status: z.enum(ACTION_STATUSES).optional(),
});
