import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import cron from "node-cron";
import { resolveOperationPolicies } from "./services/operationLimits.js";
import { parseSandboxConfig, SANDBOX_SCENARIOS } from "./sandbox/config.js";

const placeholderPattern = /PLACEHOLDER|YOUR_|CHANGE-ME|EXAMPLE|<.+?>/i;

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
const publicNetwork = "Public Global Stellar Network ; September 2015";
const networks = [publicNetwork, "Test SDF Network ; September 2015", "Test SDF Future Network ; October 2022", "Standalone Network ; February 2017"];
function urlSchema(protocols: string[]) {
  return z.string().refine((value) => {
    try {
      const url = new URL(value);
      return protocols.includes(url.protocol) && !!url.hostname && !url.hash;
    } catch { return false; }
  }, { message: `must be a valid ${protocols.join(" or ")} URL with a host and no fragment` });
}
const databaseUrl = urlSchema(["postgres:", "postgresql:"]).refine((value) => {
  try {
    const url = new URL(value);
    return url.pathname.length > 1 && !["host", "hostaddr", "dbname", "service"].some((key) => url.searchParams.has(key));
  } catch { return false; }
}, { message: "must specify a database name and must not override host/database routing in query parameters" });
const secret = (minimum: number) => z.string().min(minimum).refine(
  (value) => !placeholderPattern.test(value) && value.trim() === value && new Set(value).size >= 8,
  { message: "must be a unique secret, not a placeholder, repeated characters, or padded with whitespace" }
);
const contractIds = z.string().refine((value) => value.split(",").every((id) => StrKey.isValidContract(id.trim())), { message: "must contain valid comma-separated Stellar contract IDs" });

const schema = z.object({
  DATABASE_URL: databaseUrl,
  SANDBOX_MODE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  SANDBOX_DATABASE_URL: databaseUrl.optional(),
  SANDBOX_SCENARIO: z.enum(SANDBOX_SCENARIOS).default("success"),
  INTERNAL_SERVICE_SECRET: secret(20),
  APP_ENV: z.enum(["local", "staging", "production"]).optional(),
  ORPHAN_TTL_MINUTES: z.coerce.number().int().positive().default(10),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Stellar indexer daemon (#indexer). Optional: when both are set the daemon
  // polls the Soroban RPC for the listed contracts' events.
  SOROBAN_RPC_URL: urlSchema(["http:", "https:"]).optional(),
  INDEXER_CONTRACT_IDS: contractIds.optional(),
  /**
   * #507 — the one trusted vault-factory contract address. Required for
   * the indexer to trust any `fpooldep` (pool-deployed) registry event —
   * without it, such events are logged and skipped rather than blindly
   * upserted into PoolRegistry (see stellarIndexer.ts's factoryAddress
   * check, closing the "spoofed pools" acceptance-criteria gap).
   */
  VAULT_FACTORY_ADDRESS: contractIds.refine((value) => !value.includes(","), { message: "must contain one contract ID" }).optional(),
  // Deployment manifest attestation
  NETWORK_PASSPHRASE: z.string().refine((value) => networks.includes(value), { message: "must be a supported Stellar network passphrase" }).optional(),
  DEPLOYMENT_MANIFEST_PATH: z.string().optional(),
  /**
   * API key for external/third-party service endpoints (issue #273).
   * When set, all `/api/*` routes require `X-Api-Key: <value>`.
   * Leave unset in local development to skip enforcement.
   */
  API_KEY: secret(32).optional(),
  /**
   * Comma-separated wallet addresses that may access admin-only backend routes.
   * These are validated against server-side wallet sessions; the public
   * frontend allowlist is only a display hint.
   */
  ADMIN_WALLET_ADDRESSES: z.string().refine((value) => value.split(",").every((key) => StrKey.isValidEd25519PublicKey(key.trim())), { message: "must contain valid comma-separated Stellar public keys" }).optional(),
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
   * Replay-equivalence job (#751). REPLAY_DATABASE_URL: a dedicated scratch
   * database with migrations applied; it is truncated on every run. When
   * unset, the job is not started. REPLAY_SCHEDULE: cron expression.
   */
  REPLAY_DATABASE_URL: databaseUrl.optional(),
  REPLAY_SCHEDULE: z.string().default("30 3 * * *"),
  /**
   * Redis connection string for the caching layer (issue #485), e.g.
   * `redis://localhost:6379` or a managed provider URL with credentials.
   * When unset, caching gracefully degrades to direct database reads.
   */
  REDIS_URL: urlSchema(["redis:", "rediss:"]).optional(),
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
  /** Background job worker (#771). Set WORKER_ENABLED=false to run enqueue-only replicas. */
  WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  SENDGRID_API_KEY: secret(20).optional(),
  EMAIL_FROM: z.string().email().optional(),
  /**
   * Critical-read quorum/freshness policy (issue #596). Applied to
   * balance-critical Stellar RPC reads (withdrawals, admin repairs,
   * reconciliation) via `services/criticalReadPolicy.ts`. Defaults are
   * conservative but overridable per-environment.
   */
  CRITICAL_READ_MIN_QUORUM: z.coerce.number().int().positive().default(2),
  CRITICAL_READ_MAX_FRESHNESS_MS: z.coerce.number().int().positive().default(15_000),
  CRITICAL_READ_MAX_LEDGER_DIVERGENCE: z.coerce.number().int().nonnegative().default(2),
  CRITICAL_READ_MAX_LATENCY_MS: z.coerce.number().int().positive().default(8_000),
  /**
   * #812 — Stellar secret seed (S...) that signs activity receipts. Its
   * public key is served at GET /receipts/public-key. When unset, an
   * ephemeral key is generated at boot (receipts stop verifying after a
   * restart), so set it in every shared environment.
   */
  RECEIPT_SIGNING_SECRET: z
    .string()
    .refine(StrKey.isValidEd25519SecretSeed, { message: "must be a valid Stellar secret seed" })
    .optional(),
  /** #812 — comma-separated retired public keys still accepted after a key rotation. */
  RECEIPT_PREVIOUS_PUBLIC_KEYS: z.string().refine((value) => value.split(",").every((key) => StrKey.isValidEd25519PublicKey(key.trim())), { message: "must contain valid comma-separated Stellar public keys" }).optional(),
  /** #813 — an in-flight action untouched for this long is "stuck". */
  PENDING_STALE_THRESHOLD_MINUTES: z.coerce.number().int().positive().default(30),
  /** #813 — automatic retries before a recovery case becomes `failed`. */
  RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  /** #815 — JSON overrides for operation limits */
  OPERATION_LIMITS: z.string().optional(),
  /** #799 — Webhook signing secrets and replay tolerance */
  WEBHOOK_SECRET: secret(20).optional(),
  STRIPE_WEBHOOK_SECRET: secret(20).refine((value) => value.startsWith("whsec_"), { message: "must start with whsec_" }).optional(),
  STELLAR_WEBHOOK_PUBLIC_KEY: z.string().refine(StrKey.isValidEd25519PublicKey, { message: "must be a valid Stellar public key" }).optional(),
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300)
}).superRefine((env, ctx) => {
  const fail = (key: string, message: string) => ctx.addIssue({ code: "custom", path: [key], message });
  if (env.OPERATION_LIMITS) {
    try { resolveOperationPolicies(env.OPERATION_LIMITS); }
    catch { fail("OPERATION_LIMITS", "must be JSON with known operations and positive integer limit/windowSeconds values"); }
  }
  const databaseIdentity = (value: string) => {
    try {
      const url = new URL(value);
      const host = loopback.has(url.hostname) ? "loopback" : url.hostname;
      return `${host}:${url.port || "5432"}${decodeURIComponent(url.pathname)}`;
    } catch { return undefined; }
  };
  if (env.REPLAY_DATABASE_URL && databaseIdentity(env.REPLAY_DATABASE_URL) === databaseIdentity(env.DATABASE_URL)) fail("REPLAY_DATABASE_URL", "must be a separate scratch database, never the live database");
  if (env.SANDBOX_MODE && (!env.SANDBOX_DATABASE_URL || databaseIdentity(env.SANDBOX_DATABASE_URL) !== databaseIdentity(env.DATABASE_URL))) fail("DATABASE_URL", "sandbox mode requires DATABASE_URL to target SANDBOX_DATABASE_URL");
  const mode = env.APP_ENV ?? (env.NODE_ENV === "production" ? "production" : "local");
  if (mode !== "local" && env.NODE_ENV !== "production") fail("NODE_ENV", "must be production for staging and production deployments");
  if (mode === "local" && env.NODE_ENV === "production") fail("APP_ENV", "local mode cannot use NODE_ENV=production");
  if (env.SANDBOX_MODE) {
    try { parseSandboxConfig({ NODE_ENV: env.NODE_ENV, SANDBOX_MODE: "true", SANDBOX_DATABASE_URL: env.SANDBOX_DATABASE_URL, SANDBOX_SCENARIO: env.SANDBOX_SCENARIO }); }
    catch { fail("SANDBOX_DATABASE_URL", "sandbox requires non-production mode and a loopback PostgreSQL database whose name includes sandbox"); }
    if (mode !== "local") fail("SANDBOX_MODE", "sandbox is only allowed in local mode");
  }
  for (const key of ["DATABASE_URL", "SANDBOX_DATABASE_URL", "REPLAY_DATABASE_URL", "REDIS_URL", "SOROBAN_RPC_URL"] as const) {
    const value = env[key];
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    if (mode === "local" && key !== "SOROBAN_RPC_URL" && !loopback.has(url.hostname)) fail(key, "local mode requires a loopback host to avoid production resources");
    let resourceName = url.pathname;
    try { resourceName = decodeURIComponent(resourceName); } catch { fail(key, "must use valid URL encoding"); }
    if (mode === "local" && /(?:prod|production|live)/i.test(resourceName)) fail(key, "local mode refuses production-like resource names");
    if (mode !== "local" && key === "SOROBAN_RPC_URL" && (url.protocol !== "https:" || url.username || url.password)) fail(key, "shared environments require HTTPS without embedded credentials");
    if (mode !== "local" && key === "REDIS_URL" && url.protocol !== "rediss:") fail(key, "shared environments require rediss TLS");
    if (mode !== "local" && key.includes("DATABASE") && (url.searchParams.getAll("sslmode").length !== 1 || !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? ""))) fail(key, "shared environments require sslmode=require, verify-ca, or verify-full");
  }
  if (mode !== "production" && env.SOROBAN_RPC_URL) {
    try { if (["soroban.stellar.org", "mainnet.sorobanrpc.com"].includes(new URL(env.SOROBAN_RPC_URL).hostname)) fail("SOROBAN_RPC_URL", "known mainnet endpoints require production mode"); } catch { /* URL schema reports malformed input. */ }
  }
  if (mode !== "production" && env.NETWORK_PASSPHRASE === publicNetwork) fail("NETWORK_PASSPHRASE", "mainnet is only allowed in production mode");
  if (mode === "local") {
    for (const key of ["INTERNAL_SERVICE_SECRET", "API_KEY", "WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET", "SENDGRID_API_KEY"] as const) {
      if (/^(?:prod(?:uction)?[_-]|sk_live_|whsec_live_)/i.test(env[key] ?? "")) fail(key, "local mode refuses production-marked secrets; use a separate local secret");
    }
  }
  if (mode !== "local") {
    for (const key of ["API_KEY", "RECEIPT_SIGNING_SECRET", "NETWORK_PASSPHRASE"] as const) if (!env[key]) fail(key, "required in staging and production");
    if (env.INTERNAL_SERVICE_SECRET.length < 32) fail("INTERNAL_SERVICE_SECRET", "shared environments require at least 32 characters");
  }
  if (!!env.SENDGRID_API_KEY !== !!env.EMAIL_FROM) fail("EMAIL_FROM", "set SENDGRID_API_KEY and EMAIL_FROM together");
  if (!!env.SOROBAN_RPC_URL !== !!env.INDEXER_CONTRACT_IDS) fail("INDEXER_CONTRACT_IDS", "set SOROBAN_RPC_URL and INDEXER_CONTRACT_IDS together");
  if (env.SOROBAN_RPC_URL && !env.NETWORK_PASSPHRASE) fail("NETWORK_PASSPHRASE", "required when the indexer is enabled");
  for (const key of ["BACKUP_SCHEDULE", "REPLAY_SCHEDULE"] as const) if (!cron.validate(env[key])) fail(key, "must be a valid cron expression");
});

export type Env = z.infer<typeof schema>;

export function parseEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): Env {
  if (source.SKIP_ENV_VALIDATION === "1") throw new Error("Invalid backend env: SKIP_ENV_VALIDATION: bypass is disabled; supply valid configuration");
  for (const key of Object.keys(source)) {
    if (/^NEXT_PUBLIC_.*(?:SECRET|PRIVATE_KEY|API_KEY|SIGNING_SEED)/i.test(key) && source[key]) throw new Error(`Invalid backend env: ${key}: secrets must remain server-only`);
  }
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.code === "invalid_value" ? "must be one of the documented supported values" : i.message}`)
      .join("; ");
    throw new Error(`Invalid backend env: ${issues}`);
  }
  return parsed.data;
}

export function getEnv(): Env {
  return parseEnv();
}
