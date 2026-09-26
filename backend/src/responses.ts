import type { ZodIssue } from "zod";

export type ApiMeta = Record<string, unknown>;

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
