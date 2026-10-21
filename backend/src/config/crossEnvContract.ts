import { StrKey } from "@stellar/stellar-sdk";

export type EnvironmentMode = "production" | "staging" | "local";

export interface ContractViolation {
  field: string;
  code: string;
  message: string;
  severity: "critical" | "warning";
}

export interface CrossEnvContractReport {
  environment: EnvironmentMode;
  valid: boolean;
  violations: ContractViolation[];
}

export class ConfigurationContractError extends Error {
  readonly code = "CONFIGURATION_CONTRACT_VIOLATION";
  readonly violations: ContractViolation[];

  constructor(violations: ContractViolation[], environment: EnvironmentMode) {
    const summary = violations.map((v) => `[${v.field}] ${v.message}`).join("; ");
    super(`Cross-environment configuration contract failed for ${environment}: ${summary}`);
    this.name = "ConfigurationContractError";
    this.violations = violations;
  }
}

const PUBLIC_NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const FUTURENET_NETWORK_PASSPHRASE = "Test SDF Future Network ; October 2022";
const STANDALONE_NETWORK_PASSPHRASE = "Standalone Network ; February 2017";

const PLACEHOLDER_PATTERN = /PLACEHOLDER|YOUR_|CHANGE-ME|EXAMPLE|<.+?>|^test$/i;

/**
 * Validates cross-environment configuration contracts for VaultQuest (#922).
 *
 * Ensures that production-critical settings (contract IDs, network settings,
 * database TLS, Redis TLS, secret entropy, and cross-stack parity) cannot
 * be silently misconfigured across local, staging, and production tiers.
 *
 * Complexity: O(N) time where N is the number of configuration keys, O(1) memory.
 */
export function validateCrossEnvironmentContract(
  env: Record<string, string | undefined>,
  options: {
    targetEnvironment?: EnvironmentMode;
    frontendEnv?: Record<string, string | undefined>;
    manifest?: Record<string, any>;
  } = {}
): CrossEnvContractReport {
  const violations: ContractViolation[] = [];
  const add = (field: string, code: string, message: string, severity: "critical" | "warning" = "critical") => {
    violations.push({ field, code, message, severity });
  };

  // Determine environment
  const declaredMode = (options.targetEnvironment ??
    env.APP_ENV ??
    (env.NODE_ENV === "production" ? "production" : "local")) as EnvironmentMode;

  const isShared = declaredMode === "production" || declaredMode === "staging";
  const isProduction = declaredMode === "production";

  // 1. Mandatory Environment Variables
  const requiredInShared = [
    "DATABASE_URL",
    "INTERNAL_SERVICE_SECRET",
    "RECEIPT_SIGNING_SECRET",
    "API_KEY",
    "NETWORK_PASSPHRASE",
  ];

  for (const key of requiredInShared) {
    if (isShared && !env[key]) {
      add(key, "MISSING_REQUIRED_ENV_VAR", `Required in ${declaredMode} environments`);
    }
  }

  if (isShared && env.NODE_ENV !== "production") {
    add("NODE_ENV", "INVALID_NODE_ENV", `Must be set to 'production' in ${declaredMode}`);
  }

  // 2. Secret Hygiene & Entropy
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;

    // Check for secrets accidentally exposed with client-visible prefix
    if (/^NEXT_PUBLIC_.*(?:SECRET|PRIVATE_KEY|API_KEY|SIGNING_SEED)/i.test(key)) {
      add(key, "SECRET_EXPOSED_TO_CLIENT", "Secrets must never have NEXT_PUBLIC_ prefix");
    }

    // Check for placeholders in secrets
    if (/(?:SECRET|API_KEY|SIGNING_SEED)$/i.test(key)) {
      if (PLACEHOLDER_PATTERN.test(value)) {
        add(key, "SECRET_CONTAINS_PLACEHOLDER", "Secret contains obvious placeholder value");
      }
      if (isShared && value.length < 32) {
        add(key, "SECRET_TOO_SHORT", `Secret must be at least 32 characters long in ${declaredMode}`);
      }
      const distinctChars = new Set(value).size;
      if (distinctChars < 8) {
        add(key, "SECRET_LOW_ENTROPY", "Secret has insufficient entropy (fewer than 8 distinct characters)");
      }
    }
  }

  // RECEIPT_SIGNING_SECRET must be a valid Stellar secret seed (starts with S)
  if (env.RECEIPT_SIGNING_SECRET) {
    if (!StrKey.isValidEd25519SecretSeed(env.RECEIPT_SIGNING_SECRET)) {
      add("RECEIPT_SIGNING_SECRET", "INVALID_STELLAR_SEED", "Must be a valid Stellar secret seed (starts with S)");
    }
  }

  // 3. Stellar Network & Contract IDs
  if (env.NETWORK_PASSPHRASE) {
    if (isProduction && env.NETWORK_PASSPHRASE !== PUBLIC_NETWORK_PASSPHRASE) {
      add("NETWORK_PASSPHRASE", "MAINNET_PASSPHRASE_MISMATCH", "Production must use the public Stellar network passphrase");
    }
    if (declaredMode === "staging" && env.NETWORK_PASSPHRASE !== TESTNET_NETWORK_PASSPHRASE) {
      add("NETWORK_PASSPHRASE", "TESTNET_PASSPHRASE_MISMATCH", "Staging must use the testnet Stellar network passphrase");
    }
    if (declaredMode === "local" && env.NETWORK_PASSPHRASE === PUBLIC_NETWORK_PASSPHRASE) {
      add("NETWORK_PASSPHRASE", "MAINNET_IN_LOCAL", "Local development must never use the public Stellar mainnet passphrase");
    }
  }

  // Contract IDs validation
  if (env.INDEXER_CONTRACT_IDS) {
    const ids = env.INDEXER_CONTRACT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
    for (const id of ids) {
      if (!StrKey.isValidContract(id)) {
        add("INDEXER_CONTRACT_IDS", "INVALID_CONTRACT_ID", `Invalid Stellar contract ID format: ${id}`);
      }
    }
  }

  if (env.VAULT_FACTORY_ADDRESS) {
    if (!StrKey.isValidContract(env.VAULT_FACTORY_ADDRESS)) {
      add("VAULT_FACTORY_ADDRESS", "INVALID_FACTORY_CONTRACT", "Must be a valid Stellar contract ID format");
    }
  }

  // 4. URL & Transport Security Checks
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!["postgres:", "postgresql:"].includes(url.protocol)) {
        add("DATABASE_URL", "INVALID_DB_PROTOCOL", "Database URL must use postgres: or postgresql: protocol");
      }
      if (isShared) {
        const sslmode = url.searchParams.get("sslmode");
        if (!sslmode || !["require", "verify-ca", "verify-full"].includes(sslmode)) {
          add("DATABASE_URL", "INSECURE_DB_TLS", "Shared environments require sslmode=require, verify-ca, or verify-full");
        }
      }
    } catch {
      add("DATABASE_URL", "MALFORMED_URL", "Database URL is not a parseable URL");
    }
  }

  if (env.REDIS_URL && isShared) {
    try {
      const url = new URL(env.REDIS_URL);
      if (url.protocol !== "rediss:") {
        add("REDIS_URL", "INSECURE_REDIS_PROTOCOL", `Shared environments require encrypted rediss: protocol, got ${url.protocol}`);
      }
    } catch {
      add("REDIS_URL", "MALFORMED_URL", "Redis URL is not a parseable URL");
    }
  }

  if (env.SOROBAN_RPC_URL) {
    try {
      const url = new URL(env.SOROBAN_RPC_URL);
      if (isShared && url.protocol !== "https:") {
        add("SOROBAN_RPC_URL", "INSECURE_RPC_PROTOCOL", "Shared environments require HTTPS for Soroban RPC");
      }
      if (isShared && (url.username || url.password)) {
        add("SOROBAN_RPC_URL", "RPC_CONTAINS_CREDENTIALS", "Soroban RPC URL must not embed user credentials");
      }
    } catch {
      add("SOROBAN_RPC_URL", "MALFORMED_URL", "Soroban RPC URL is not a parseable URL");
    }
  }

  // 5. Cross-Stack Frontend & Backend Parity Checks
  if (options.frontendEnv) {
    const f = options.frontendEnv;
    if (f.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE && env.NETWORK_PASSPHRASE) {
      if (f.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE !== env.NETWORK_PASSPHRASE) {
        add(
          "CROSS_STACK_NETWORK_PASSPHRASE",
          "CROSS_STACK_DRIFT",
          `Frontend network passphrase (${f.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE}) does not match backend (${env.NETWORK_PASSPHRASE})`
        );
      }
    }
    if (f.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID && env.INDEXER_CONTRACT_IDS) {
      const backendContracts = env.INDEXER_CONTRACT_IDS.split(",").map((s) => s.trim());
      if (!backendContracts.includes(f.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID)) {
        add(
          "CROSS_STACK_DRIP_POOL_CONTRACT",
          "CROSS_STACK_DRIFT",
          `Frontend drip pool contract (${f.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID}) is not indexed by backend`
        );
      }
    }
  }

  // 6. Manifest & Governance Constraints
  if (options.manifest) {
    const m = options.manifest;
    if (isProduction) {
      if (m.governance && m.governance.signerThreshold < 2) {
        add("manifest.governance.signerThreshold", "INSUFFICIENT_SIGNER_THRESHOLD", "Production requires multisig threshold >= 2");
      }
      if (m.network && m.network.name !== "mainnet") {
        add("manifest.network.name", "MANIFEST_NETWORK_MISMATCH", "Production manifest network must be 'mainnet'");
      }
    }
  }

  const valid = violations.filter((v) => v.severity === "critical").length === 0;
  return { environment: declaredMode, valid, violations };
}

export function assertCrossEnvironmentContract(
  env: Record<string, string | undefined>,
  options: {
    targetEnvironment?: EnvironmentMode;
    frontendEnv?: Record<string, string | undefined>;
    manifest?: Record<string, any>;
  } = {}
): void {
  const report = validateCrossEnvironmentContract(env, options);
  if (!report.valid) {
    throw new ConfigurationContractError(
      report.violations.filter((v) => v.severity === "critical"),
      report.environment
    );
  }
}
