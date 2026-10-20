import { z } from "zod";

export const WEBHOOK_PROVIDERS = ["stripe", "internal", "stellar", "custom"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

export const webhookProviderSchema = z.enum(WEBHOOK_PROVIDERS);

export const webhookParamsSchema = z.object({
  provider: webhookProviderSchema
});

export const webhookQuerySchema = z.object({
  dry_run: z.coerce.boolean().optional()
});

/**
 * Common inbound webhook payload shape.
 * Providers may format the event ID as `id` or `eventId`, and event type as `type` or `event`.
 */
export const genericWebhookPayloadSchema = z
  .object({
    id: z.string().min(1).max(256).optional(),
    eventId: z.string().min(1).max(256).optional(),
    event_id: z.string().min(1).max(256).optional(),
    type: z.string().min(1).max(128).optional(),
    event: z.string().min(1).max(128).optional(),
    event_type: z.string().min(1).max(128).optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
    data: z.record(z.unknown()).optional(),
    payload: z.record(z.unknown()).optional()
  })
  .passthrough();

export type GenericWebhookPayload = z.infer<typeof genericWebhookPayloadSchema>;

/**
 * Vault deposit confirmation callback schema
 */
export const vaultDepositEventPayloadSchema = z.object({
  vault_id: z.string().min(1).max(128),
  wallet_address: z.string().min(1).max(128),
  amount: z.string().min(1),
  asset: z.string().min(1).optional(),
  tx_hash: z.string().min(4).max(200).optional(),
  ledger: z.number().int().positive().optional()
});

/**
 * Vault settlement callback schema
 */
export const vaultSettlementEventPayloadSchema = z.object({
  vault_id: z.string().min(1).max(128),
  settlement_type: z.enum(["release", "distribute", "refund"]),
  amount: z.string().min(1),
  recipient: z.string().min(1).optional(),
  tx_hash: z.string().min(4).max(200).optional()
});

/**
 * Prize draw completion callback schema
 */
export const prizeDrawEventPayloadSchema = z.object({
  pool_id: z.string().min(1).max(128),
  round_id: z.number().int().nonnegative(),
  winner_wallet: z.string().min(1).max(128),
  prize_amount: z.string().min(1),
  randomness_tx_hash: z.string().min(4).max(200).optional(),
  draw_proof_id: z.string().optional()
});

/**
 * Stripe payment intent event schema
 */
export const stripePaymentEventPayloadSchema = z.object({
  id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  currency: z.string().min(3).max(10),
  status: z.string().optional(),
  customer: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});
