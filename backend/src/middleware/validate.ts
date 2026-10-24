import type { FastifyRequest } from "fastify";
import type { ZodSchema } from "zod";
import { AppError } from "../errors.js";

export function validateBody<T>(schema: ZodSchema<T>) {
  return async (req: FastifyRequest): Promise<void> => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      req.log.debug(
        { event: "body_validation_failed", url: req.url, issues: result.error.issues },
        "request body validation failed"
      );
      throw AppError.validation("Request body validation failed", undefined, result.error.issues);
    }
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return async (req: FastifyRequest): Promise<void> => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      req.log.debug(
        { event: "query_validation_failed", url: req.url, issues: result.error.issues },
        "query parameter validation failed"
      );
      throw AppError.validation("Query parameter validation failed", undefined, result.error.issues);
    }
  };
}
