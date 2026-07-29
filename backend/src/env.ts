import { z } from "zod";

const placeholderPattern = /PLACEHOLDER|YOUR_|CHANGE-ME|EXAMPLE|<.+?>/i;

const schema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres")),
  INTERNAL_SERVICE_SECRET: z
    .string()
    .min(20)
    .refine((value) => !placeholderPattern.test(value), {
      message: "INTERNAL_SERVICE_SECRET must not be a placeholder value"
    }),
  ORPHAN_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Stellar indexer daemon (#indexer). Optional: when both are set the daemon
  // polls the Soroban RPC for the listed contracts' events.
  SOROBAN_RPC_URL: z.string().url().optional(),
  INDEXER_CONTRACT_IDS: z.string().optional(),
  // Deployment manifest attestation
  NETWORK_PASSPHRASE: z.string().min(1).optional(),
  DEPLOYMENT_MANIFEST_PATH: z.string().optional(),
  /**
   * API key for external/third-party service endpoints (issue #273).
   * When set, all `/api/*` routes require `X-Api-Key: <value>`.
   * Leave unset in local development to skip enforcement.
   */
  API_KEY: z
    .string()
    .min(32, "API_KEY must be at least 32 characters")
    .refine((v) => !placeholderPattern.test(v), {
      message: "API_KEY must not be a placeholder value"
    })
    .optional(),
  /**
   * Automated database backup configuration (issue #275).
   * BACKUP_DIR: absolute path where pg_dump files are written.
   *   When unset, the backup cron is not started.
   * BACKUP_RETAIN_DAYS: delete backup files older than this many days (default 7).
   * BACKUP_SCHEDULE: cron expression for the backup job (default: daily at 02:00).
   */
  BACKUP_DIR: z.string().min(1).optional(),
  BACKUP_RETAIN_DAYS: z.coerce.number().int().positive().default(7),
  BACKUP_SCHEDULE: z.string().default("0 2 * * *"),
  /**
   * Redis connection string for the caching layer (issue #485), e.g.
   * `redis://localhost:6379` or a managed provider URL with credentials.
   * When unset, caching gracefully degrades to direct database reads.
   */
  REDIS_URL: z.string().url().optional(),
  /**
   * Cache TTL (seconds) for the GET /api/categories response (issue #485).
   */
  CATEGORIES_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /**
   * Reminder lead time (hours) for maturity/claim-window notifications
   * (issue #446). A reminder is generated once a saved pool's `locksAt` or
   * `drawsAt` timestamp falls within this many hours of "now".
   */
  REMINDER_LEAD_HOURS: z.coerce.number().int().positive().default(24),
  SENDGRID_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional()
});

export type Env = z.infer<typeof schema>;

export function parseEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid backend env: ${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  if (process.env.SKIP_ENV_VALIDATION === "1") {
    return {
      DATABASE_URL: process.env.DATABASE_URL ?? "",
      INTERNAL_SERVICE_SECRET: process.env.INTERNAL_SERVICE_SECRET ?? "",
      ORPHAN_TTL_MINUTES: Number(process.env.ORPHAN_TTL_MINUTES ?? 10),
      LOG_LEVEL: (process.env.LOG_LEVEL ?? "info") as Env["LOG_LEVEL"],
      PORT: Number(process.env.PORT ?? 3001),
      NODE_ENV: (process.env.NODE_ENV ?? "development") as Env["NODE_ENV"],
      SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL || undefined,
      INDEXER_CONTRACT_IDS: process.env.INDEXER_CONTRACT_IDS || undefined,
      NETWORK_PASSPHRASE: process.env.NETWORK_PASSPHRASE || undefined,
      DEPLOYMENT_MANIFEST_PATH: process.env.DEPLOYMENT_MANIFEST_PATH || undefined,
      API_KEY: process.env.API_KEY || undefined,
      BACKUP_DIR: process.env.BACKUP_DIR || undefined,
      BACKUP_RETAIN_DAYS: Number(process.env.BACKUP_RETAIN_DAYS ?? 7),
      BACKUP_SCHEDULE: process.env.BACKUP_SCHEDULE ?? "0 2 * * *",
      REDIS_URL: process.env.REDIS_URL || undefined,
      CATEGORIES_CACHE_TTL_SECONDS: Number(process.env.CATEGORIES_CACHE_TTL_SECONDS ?? 3600),
      REMINDER_LEAD_HOURS: Number(process.env.REMINDER_LEAD_HOURS ?? 24),
      SENDGRID_API_KEY: process.env.SENDGRID_API_KEY || undefined,
      EMAIL_FROM: process.env.EMAIL_FROM || undefined
    } satisfies Env;
  }
  return parseEnv();
}
