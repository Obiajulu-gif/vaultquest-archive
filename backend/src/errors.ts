import { ERROR_CODES, type ErrorCode } from "./constants.js";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly detail?: string;

  constructor(code: ErrorCode, statusCode: number, message: string, detail?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.detail = detail;
  }

  static conflict(code: ErrorCode, message: string, detail?: string): AppError {
    return new AppError(code, 409, message, detail);
  }
  static notFound(message: string): AppError {
    return new AppError(ERROR_CODES.NOT_FOUND, 404, message);
  }
  static unauthorized(): AppError {
    return new AppError(ERROR_CODES.UNAUTHORIZED, 401, "unauthorized");
  }
  static validation(message: string, detail?: string): AppError {
    return new AppError(ERROR_CODES.INVALID_PAYLOAD, 400, message, detail);
  }
  static badRequest(code: ErrorCode, message: string, detail?: string): AppError {
    return new AppError(code, 400, message, detail);
  }
  static forbidden(message: string = "forbidden"): AppError {
    return new AppError(ERROR_CODES.FORBIDDEN, 403, message);
  }
}
