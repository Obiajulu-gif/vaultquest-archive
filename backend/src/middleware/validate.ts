import type { FastifyReply, FastifyRequest } from "fastify";
import type { ZodSchema } from "zod";

export function validateBody<T>(schema: ZodSchema<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      req.log.debug(
        { event: "body_validation_failed", url: req.url, issues: result.error.issues },
        "request body validation failed"
      );
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Request body validation failed",
          issues: result.error.issues
        }
      });
    }
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      req.log.debug(
        { event: "query_validation_failed", url: req.url, issues: result.error.issues },
        "query parameter validation failed"
      );
      return reply.status(400).send({
        error: {
          code: "INVALID_PAYLOAD",
          message: "Query parameter validation failed",
          issues: result.error.issues
        }
      });
    }
  };
}
