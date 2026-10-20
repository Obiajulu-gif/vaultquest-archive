/**
 * VaultQuest contributor diagnostics command.
 *
 * Runs a series of read-only checks against the local development
 * environment and reports a pass/fail matrix with actionable remediation
 * steps. The command never mutates production data: it only reads from
 * the database, pings services, and inspects filesystem fixtures.
 *
 * Usage:
 *   pnpm run diagnostics
 *   pnpm run diagnostics -- --json
 *   pnpm run diagnostics -- --strict
 *
 * Exit codes of the CLI:
 *   0 - all checks passed (or only warnings)
 *   1 - one or more checks failed
 *   2 - invalid CLI usage
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import z from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(__dirname, "..", "..");
const REPL_ROOT = resolve(BACKEND_ROOT, "..");

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  /** Stable identifier for the check (e.g. "node_version"). */
  id: string;
  /** Human-readable group name (e.g. "Toolchain"). */
  group: string;
  /** Short description of what was checked. */
  label: string;
  status: CheckStatus;
  /** Observed value or state description. */
  detail: string;
  /** Actionable remediation steps when not passing. */
  remediation?: string;
}

export interface DiagnosticsReport {
  generatedAt: string;
  checks: CheckResult[];
  summary: {
    passed: number;
    warned: number;
    failed: number;
  };
}

export interface DiagnosticsOptions {
  /** Emit machine-readable JSON instead of the human report. */
  json?: boolean;
  /** Treat warnings as failures for the process exit code. */
  strict?: boolean;
  /** Override the database URL used for connectivity checks. */
  databaseUrl?: string;
  /** Override the Redis URL used for connectivity checks. */
  redisUrl?: string;
  /** Override the timeout (in ms) for network probes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const MIN_NODE_MAJOR = 20;

// -----------------------------------------------------------------------------
// Environment validation
	// -----------------------------------------------------------------------------

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.z.number.int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WORKER_ENABLED: z.coerce.z.boolean().default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.z.number.int().positive().default(2000),
  INTERNAL_SECRET: z.string().min(1).optional(),
  SENDGRID_API_KEY: z.string().min(1).optional(),
  STEPLAR_HORIZON_URL: z.string().url().optional(),
});

export type EnvValidationResult = {
  ok: boolean;
  errors: string[];
  values: Record<string, unknown>;
};

/**
 * Validate an environment object against the expected schema.
 * Exported so the test suite can cover the contract without spawning a
 * subprocess.
 */
export function validateEnv(raw: NodeJS.ProcessEnv): EnvValidationResult {
  const parsed = envSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, errors: [], values: parsed.data as Record<string, unknown> };
  }
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.join(".") || "(env)";
    return `${path}: ${issue.message}`;
  });
  return { ok: false, errors, values: {} };
}

// -----------------------------------------------------------------------------
// Network probe helpers
	// -----------------------------------------------------------------------------

export function probeTcp(host: string, port: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveProbe) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, `timeout after ${timeoutMs}ms`));
    socket.once("error", (err) => finish(false, err.message));
  });
}

export function parseHostPort(url: string, defaultPort: number): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    if (!host || !Number.isInteger(port)) return null;
    return { host, port };
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Individual checks

// -----------------------------------------------------------------------------

export function checkNodeVersion(version = process.versions.node): CheckResult {
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return {
      id: "node_version",
      group: "Toolchain",
      label: "Node.js runtime",
      status: "pass",
      detail: `Node ${version} (detected)`,
    };
  }
  return {
    id: "node_version",
    group: "Toolchain",
    label: "Node.js runtime",
    status: "fail",
    detail: `Node ${version} is outside the supported range`,
    remediation: "Install Node.js 20, 22, or 24 (e.g. via `nv-` or `fnm`) and re-run `pnpm run diagnostics`.",
  };
}

export function checkPackageManager(): CheckResult {
  const hasPnpm = existsSync(resolve(REPL_ROOT, "pnpm-lock.yaml"));
  const hasNpm = existsSync(resolve(REPL_ROOT, "package-lock.json"));
  if (hasPnpm) {
    return {
      id: "package_manager",
      group: "Toolchain",
      label: "Package manager lockfile",
      status: "pass",
      detail: "Found pnpm-lock.yaml at the repository root",
    };
  }
  if (hasNpm) {
    return {
      id: "package_manager",
      group: "Toolchain",
      label: "Package manager lockfile",
      status: "warn",
      detail: "Found package-lock.json but no pnpm-lock.yaml",
      remediation: "This repo standardizes on pnpm. Run `pnpm install` to regenerate the lockfile and remove `package-lock.json`.",
    };
  }
  return {
    id: "package_manager",
    group: "Toolchain",
    label: "Package manager lockfile",
    status: "fail",
    detail: "No pnpm-lock.yaml or package-lock.json found",
    remediation: "Run `pnpm install` from the repository root to create the lockfile.",
  };
}
