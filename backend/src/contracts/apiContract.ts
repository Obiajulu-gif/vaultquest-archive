import { z } from "zod";
import { ACTION_STATUSES, ACTION_TYPES, ERROR_CODES } from "../constants.js";
import { ERROR_CATEGORIES } from "../errorTaxonomy.js";
import { JOB_STATUSES } from "../worker/types.js";

/**
 * #775 — machine-checkable public API contract.
 *
 * These schemas describe what the HTTP layer returns today. `docs/API.md`
 * documents the same shapes; `tests/apiContract.spec.ts` validates live
 * responses and the doc examples against them, so behaviour, docs and this
 * file cannot drift apart without a test failing.
 *
 * Object schemas are `.strict()` on purpose: an added, removed or renamed
 * field is a contract change and must be reflected here and in the docs.
 */

const iso = z.string().datetime({ offset: true });

/** `{ data }` success envelope. */
export const success = <T extends z.ZodTypeAny>(data: T) => z.object({ data }).strict();

/**
 * Ingestion watermark (#731): the indexer point a read reflects. Both fields
 * are null until the indexer has completed a sync.
 */
export const watermark = z
  .object({
    latest_ledger: z.number().int().nonnegative().nullable(),
    as_of: iso.nullable()
  })
  .strict();

/** `{ data: [...], meta.pagination }` list envelope. */
export const paginated = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      data: z.array(item),
      meta: z
        .object({
          pagination: z
            .object({
              next_cursor: z.string().nullable(),
              limit: z.number().int().positive(),
              has_more: z.boolean()
            })
            .strict(),
          watermark
        })
        .strict()
    })
    .strict();

/** Error envelope produced by `middleware/errorHandler.ts` (#768). */
export const errorEnvelope = z
  .object({
    error: z
      .object({
        code: z.string(),
        category: z.enum(ERROR_CATEGORIES),
        message: z.string(),
        retryable: z.boolean(),
        recovery: z.string().optional(),
        error_id: z.string(),
        status_code: z.number().int().min(400).max(599),
        details: z.unknown().optional(),
        issues: z.array(z.unknown()).optional()
      })
      .strict()
  })
  .strict();

/** Error codes the API may return; the documented table must list exactly these. */
export const DOCUMENTED_ERROR_CODES = Object.values(ERROR_CODES);

export const action = z
  .object({
    id: z.string(),
    idempotency_key: z.string(),
    wallet_address: z.string(),
    action_type: z.enum(ACTION_TYPES),
    action_payload: z.record(z.string(), z.unknown()),
    status: z.enum(ACTION_STATUSES),
    tx_hash: z.string().nullable(),
    soroban_event_id: z.string().nullable(),
    correlation_id: z.string(),
    error_code: z.string().nullable(),
    error_detail: z.string().nullable(),
    retry_count: z.number().int().nonnegative(),
    created_at: iso,
    updated_at: iso,
    submitted_at: iso.nullable(),
    confirmed_at: iso.nullable(),
    redacted_at: iso.nullable()
  })
  .strict();

export const health = z
  .object({
    status: z.literal("ok"),
    uptime: z.number().int().nonnegative(),
    timestamp: iso,
    service: z.literal("vaultquest-backend")
  })
  .strict();

const jobFailure = z
  .object({
    attempt: z.number().int().positive(),
    at: iso,
    code: z.string(),
    message: z.string(),
    retryable: z.boolean()
  })
  .strict();

export const job = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
    status: z.enum(JOB_STATUSES),
    idempotency_key: z.string(),
    payload: z.unknown(),
    attempts: z.number().int().nonnegative(),
    max_attempts: z.number().int().positive(),
    run_at: iso,
    correlation_id: z.string().nullable(),
    last_error: jobFailure.nullable(),
    failures: z.array(jobFailure),
    created_at: iso,
    updated_at: iso,
    completed_at: iso.nullable()
  })
  .strict();

/**
 * Schemas addressable from documentation code fences:
 * ```json contract=action
 */
export const CONTRACTS = {
  action: success(action),
  "action-list": paginated(action),
  error: errorEnvelope,
  health: success(health),
  job: success(job),
  "job-list": success(z.array(job))
} as const;

export type ContractName = keyof typeof CONTRACTS;
