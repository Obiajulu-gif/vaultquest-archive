import pino, { type Logger } from "pino";

export function createLogger(level: string): Logger {
  const isDevelopment = process.env.NODE_ENV === "development";

  return pino({
    level,
    base: { service: "vaultquest-backend" },
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: isDevelopment
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            ignore: "pid,hostname,service",
            translateTime: "HH:MM:ss Z"
          }
        }
      : undefined
  });
}
