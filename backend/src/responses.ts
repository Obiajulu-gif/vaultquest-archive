import { z } from "zod";
import type { ZodIssue, ZodType } from "zod";

/**
 * VaultQuest API Response Contracts
*
 * Versioning rules:
 * - Every core response is validated against a documented zod schema.
 * - Additive changes (new optional fields, new meta keys) are backward compatible
 *   and require no version bump.
 * - Breaking changes (removed/renamed fields, type changes, new required fields)
 *   require a major version bump and must fail the contract tests.
 * - Deprecations are announced via `meta.deprecations` for at least one minor
 *   release before removal.
 */

export const API_CONTRACT_VERSION = "1.0.0" as const;

export type ApiMeta = Record<unknown, unknown>;

export interface ApiSuccess<T> {
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    issues?: ZodIssue[];
  };
}

// ---------------------------------------------------------------------------
// Schemas: core API response contracts

// ---------------------------------------------------------------------------

export const zodIssueSummarySchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  message: z.string().optional()
}).passthrough();

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
    issues: z.array(zodIssueSummarySchema).optional()
  }).strict()
}).strict();

export const paginationMetaSchema = z.object({
  next_cursor: z.string().nullable(),
  limit: z.number().int().positive(),
  has_more: z.boolean()
}).strict();

export const apiMetaSchema = z.object({
  pagination: paginationMetaSchema.optional(),
  deprecations: z.array(z.string()).optional()
}).catchall(z.unknown());

export function apiSuccessSchema<T>(dataSchema: ZodType<T>) {
  return z.object({
    data: dataSchema,
    meta: apiMetaSchema.optional()
  }).strict();
}

// ---------------------------------------------------------------------------
// Validation helpers

// ---------------------------------------------------------------------------

export class ApiContractError extends Error {
  readonly issues: ZodIssue[];
  constructor(message: string, issues: ZodIssue[]) {
    super(message);
    this.name = "ApiContractError";
    this.issues = issues;
  }
}

export function validateApiSuccess<T>(
  payload: unknown,
  dataSchema: ZodType<T>
): ApiSuccess<T> {
  const result = apiSuccessSchema(dataSchema).safeParse(payload);
  if (!result.success) {
    throw new ApiContractError(
      "API success response violates its contract",
      result.error.issues
    );
  }
  return result.data;
}

export function validateApiError(payload: unknown): ApiErrorBody {
  const result = apiErrorBodySchema.safeParse(payload);
  if (!result.success) {
    throw new ApiContractError(
      "API error response violates its contract",
      result.error.issues
    );
  }
  return result.data as ApiErrorBody;
}

// ---------------------------------------------------------------------------
// Response builders

// ---------------------------------------------------------------------------

export function ok<T>(data: T, meta?: ApiMeta): ApiSuccess<T> {
  return meta ? { data, meta } : { data };
}

export function page<T>(
  items: T[],
  pagination: { nextCursor: string | null; limit: number },
  extraMeta?: ApiMeta
): ApiSuccess<T[]> {
  return {
    data: items,
    meta: {
      pagination: {
        next_cursor: pagination.nextCursor,
        limit: pagination.limit,
        has_more: pagination.nextCursor !== null
      },
      ...extraMeta
    }
  };
}

export function apiError(
  code: string,
  message: string,
  details?: unknown,
  issues?: ZodIssue[]
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      ...(issues === undefined ? {} : { issues })
    }
  };
}
