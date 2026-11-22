export const SANDBOX_SCENARIOS = [
  "success",
  "retry_once",
  "timeout_once",
  "submit_failure",
  "verification_pending",
  "verification_mismatch"
] as const;

export type SandboxScenario = (typeof SANDBOX_SCENARIOS)[number];

export interface SandboxConfig {
  databaseUrl: string;
  scenario: SandboxScenario;
}

export function parseSandboxConfig(
  source: Record<string, string | undefined> = process.env
): SandboxConfig {
  if (source.SANDBOX_MODE !== "true") {
    throw new Error("SANDBOX_MODE=true is required; sandbox operations never target the configured production database");
  }
  if (source.NODE_ENV === "production") {
    throw new Error("Sandbox mode cannot run with NODE_ENV=production");
  }

  const databaseUrl = source.SANDBOX_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("SANDBOX_DATABASE_URL must point to a local sandbox database");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("SANDBOX_DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("SANDBOX_DATABASE_URL must use PostgreSQL");
  }
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(parsed.hostname.toLowerCase())) {
    throw new Error("Sandbox database host must be loopback; remote databases are refused");
  }
  if (!parsed.pathname.toLowerCase().includes("sandbox")) {
    throw new Error("Sandbox database name must include 'sandbox'");
  }

  const scenario = source.SANDBOX_SCENARIO ?? "success";
  if (!(SANDBOX_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new Error(`Unknown SANDBOX_SCENARIO '${scenario}'. Choose: ${SANDBOX_SCENARIOS.join(", ")}`);
  }

  return { databaseUrl, scenario: scenario as SandboxScenario };
}