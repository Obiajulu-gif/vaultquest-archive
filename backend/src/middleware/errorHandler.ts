import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { toUserSafeError } from "../errorTaxonomy.js";
import { OperationLimitError } from "../services/operationLimits.js";
import { formatProblemDetails, PROBLEM_DETAILS_CONTENT_TYPE } from "../problemDetails.js";

export function errorHandler(
  err: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply
) {
  const errorId = req.correlationId || randomUUID();

  // Log error with request context (including correlation ID)
  req.log.error({ err, errorId }, "Error occurred during request processing");

  let statusCode = 500;
  let code: string = ERROR_CODES.INTERNAL;
  let message = "An internal server error occurred";
  let details: unknown = undefined;
  let issues: unknown = undefined;

  // AppErrors carry their own 429 code (#815 OPERATION_LIMIT_EXCEEDED), so
  // only framework/plugin 429s are treated as generic rate limiting.
  if (err.statusCode === 429 && !(err instanceof AppError)) {
    statusCode = 429;
    code = ERROR_CODES.RATE_LIMIT_EXCEEDED;
    message = err.message;
    const retryAfter = (err as any).retryAfter || (err as any).after || reply.getHeader("retry-after");
    if (retryAfter) {
      reply.header("Retry-After", String(retryAfter));
    }
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.detail;
    issues = err.issues;
    if (err instanceof OperationLimitError) {
      // #815: user-safe structured details + standard Retry-After header.
      details = err.limitDetails;
      reply.header("Retry-After", String(err.retryAfterSeconds));
    } else if (err.name === "QueueBackpressureError") {
      const qErr = err as any;
      const retrySecs = Math.max(1, Math.ceil((qErr.retryAfterMs ?? 5000) / 1000));
      reply.header("Retry-After", String(retrySecs));
      details = {
        retry_after_ms: qErr.retryAfterMs,
        current_depth: qErr.currentDepth,
        max_capacity: qErr.maxCapacity
      };
    }
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = ERROR_CODES.INVALID_PAYLOAD;
    message = "validation failed";
    issues = err.issues;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      statusCode = 409;
      code = ERROR_CODES.CONFLICT;
      message = "A database conflict occurred (unique constraint violation)";
    } else if (err.code === "P2025") {
      statusCode = 404;
      code = ERROR_CODES.NOT_FOUND;
      message = "The requested database record was not found";
    } else {
      statusCode = 500;
      code = ERROR_CODES.DATABASE_ERROR;
      message = "A database error occurred";
    }
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    statusCode = 400;
    code = ERROR_CODES.INVALID_PAYLOAD;
    message = "Database validation failed";
  } else if (err.constructor.name.includes("Prisma")) {
    statusCode = 500;
    code = ERROR_CODES.DATABASE_ERROR;
    message = "An internal database error occurred";
  } else {
    // Check if it's a Fastify native HTTP error
    const maybeStatus = err.statusCode || (err as any).status;
    if (typeof maybeStatus === "number" && maybeStatus >= 400 && maybeStatus < 600) {
      statusCode = maybeStatus;
      if (req.url?.startsWith("/webhooks") && statusCode === 400) {
        code = ERROR_CODES.WEBHOOK_EVENT_MALFORMED;
      } else {
        code = err.code || ERROR_CODES.HTTP_ERROR;
      }
      message = err.message;
    }
  }

  // Construct standardized JSON error schema according to acceptance criteria:
  // All public error responses return standardized JSON schemas containing an HTTP status code, message, and error ID.
  // Public responses never expose internal system stack traces or raw database statements.
  // #768: the taxonomy decides what a user may see (stable code, category,
  // retryability, recovery guidance); internal messages never reach clients
  // for 5xx or non-exposable codes.
  // #946: Add RFC 7807 problem-details taxonomy with stable error codes and remediation hints.
  const safe = toUserSafeError(code, statusCode, message);
  const problem = formatProblemDetails(code, statusCode, {
    message,
    instance: req.url,
    errorId,
    details,
    issues
  });

  const acceptsProblem = req.headers.accept?.includes(PROBLEM_DETAILS_CONTENT_TYPE);
  if (acceptsProblem) {
    reply.header("content-type", `${PROBLEM_DETAILS_CONTENT_TYPE}; charset=utf-8`);
  }

  const payload = {
    // RFC 7807 / RFC 9457 top-level problem details
    type: problem.type,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    instance: problem.instance,
    code: problem.code,
    category: problem.category,
    retryable: problem.retryable,
    ...(problem.remediation ? { remediation: problem.remediation } : {}),
    timestamp: problem.timestamp,
    error_id: errorId,
    ...(problem.invalid_params ? { invalid_params: problem.invalid_params } : {}),

    // Backward-compatible envelope for existing clients and tests
    error: {
      code: safe.code,
      category: safe.category,
      message: safe.message,
      retryable: safe.retryable,
      ...(safe.recovery ? { recovery: safe.recovery } : {}),
      error_id: errorId,
      status_code: statusCode,
      ...(details !== undefined ? { details } : {}),
      ...(issues !== undefined ? { issues } : {})
    }
  };

  reply.status(statusCode).send(payload);
}
