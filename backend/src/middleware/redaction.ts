import type { Logger } from "pino";
import crypto from "crypto";

export function createRedactionMiddleware(logger: Logger) {
  return function redactLogs(obj: any): any {
    if (obj === null || typeof obj !== "object") {
      return redactValue(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => redactLogs(item));
    }

    const redacted: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (shouldRedact(key)) {
        redacted[key] = redactValue(value);
      } else if (typeof value === "object") {
        redacted[key] = redactLogs(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  };
}

function shouldRedact(key: string): boolean {
  const redactKeys = [
    "walletAddress",
    "wallet",
    "actor",
    "txHash",
    "transactionId",
    "errorText",
    "errorDetail",
    "poolAddress"
  ];
  return redactKeys.includes(key);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("G") && value.length === 56) {
      return `[REDACTED_WALLET:${hashValue(value)}]`;
    }
    if (/^[0-9a-f]{64}$/.test(value)) {
      return `[REDACTED_TX:${hashValue(value)}]`;
    }
  }
  return value;
}

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}
