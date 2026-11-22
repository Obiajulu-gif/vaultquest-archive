import pino, { type DestinationStream, type Logger } from "pino";

const PRIVATE_LOG_KEYS = [
  "walletAddress", "wallet_address", "wallet", "actor", "txHash", "tx_hash",
  "transactionId", "transaction_id", "poolAddress", "pool_address", "recipient",
  "email", "ip", "url", "endpoint", "contractId", "contract_id", "recordId",
  "record_id", "userId", "user_id", "actionId", "action_id", "vaultId",
  "vault_id", "idempotencyKey", "idempotency_key", "actionPayload",
  "action_payload", "eventPayload", "event_payload", "payload", "subject",
  "authorization", "accessToken", "access_token", "refreshToken", "refresh_token",
  "token", "secret", "apiKey", "api_key", "password", "passwordHash",
  "password_hash", "databaseUrl", "database_url", "rpcUrl", "rpc_url", "headers",
];
const REDACT_PATHS = PRIVATE_LOG_KEYS.flatMap((key) => [key, "*." + key, "err." + key]);

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const isDevelopment = process.env.NODE_ENV === "development";

  const options = {
    level,
    base: { service: "vaultquest-backend" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    transport: isDevelopment && !destination
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname,service",
            translateTime: "HH:MM:ss Z"
          }
        }
      : undefined
  };
  return destination ? pino(options, destination) : pino(options);
}
