export interface FrontendEnv {
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: string;
  NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: string;
  NEXT_PUBLIC_HORIZON_URL: string;
  NEXT_PUBLIC_SOROBAN_RPC_URL: string;
  NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: string;
  /** Asset code accepted for vault deposits (e.g. "USDC"). Required. */
  NEXT_PUBLIC_VAULT_ASSET_CODE: string;
  /** Stellar account ID of the allowed asset issuer. Must be a valid G-address. Required. */
  NEXT_PUBLIC_VAULT_ASSET_ISSUER: string;
  NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID?: string;
  TRUSTLESS_WORK_API_BASE_URL?: string;
  TRUSTLESS_WORK_API_KEY?: string;
}

export interface ManifestAttestation {
  verified: boolean;
  version?: string;
  environment?: string;
  mismatches: Array<{ field: string; manifestValue: string; envValue: string }>;
}

const placeholderPattern = /PLACEHOLDER|YOUR_|CHANGE-ME|EXAMPLE|<.+?>/i;

function isPresent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlaceholder(value: string): boolean {
  return placeholderPattern.test(value);
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function readEnvValue(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  fallbackKey?: string
): string {
  return (
    source[key] ||
    (fallbackKey ? source[fallbackKey] : undefined) ||
    ""
  );
}

function validateRequiredString(name: string, value: string): string | undefined {
  if (!isPresent(value)) {
    return `${name} must be set and not empty`;
  }
  if (isPlaceholder(value)) {
    return `${name} appears to be a placeholder value`;
  }
  return undefined;
}

function validateUrl(name: string, value: string): string | undefined {
  const missing = validateRequiredString(name, value);
  if (missing) return missing;
  if (!isValidUrl(value)) {
    return `${name} must be a valid URL`;
  }
  return undefined;
}

function validateOptionalUrl(name: string, value?: string): string | undefined {
  if (!value) return undefined;
  if (!isValidUrl(value)) {
    return `${name} must be a valid URL if set`;
  }
  if (isPlaceholder(value)) {
    return `${name} appears to be a placeholder value`;
  }
  return undefined;
}

// Stellar account IDs are 56-character base32 strings starting with "G".
const stellarAccountIdPattern = /^G[A-Z2-7]{55}$/;

function validateStellarAccountId(name: string, value: string): string | undefined {
  const missing = validateRequiredString(name, value);
  if (missing) return missing;
  if (!stellarAccountIdPattern.test(value)) {
    return `${name} must be a valid Stellar account ID (G… 56 characters)`;
  }
  return undefined;
}

export function parseFrontendEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): FrontendEnv {
  const env = {
    NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: readEnvValue(source, "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID"),
    NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: readEnvValue(
      source,
      "NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE",
      "PUBLIC_SOROBAN_NETWORK_PASSPHRASE"
    ),
    NEXT_PUBLIC_HORIZON_URL: readEnvValue(source, "NEXT_PUBLIC_HORIZON_URL", "PUBLIC_HORIZON_URL"),
    NEXT_PUBLIC_SOROBAN_RPC_URL: readEnvValue(source, "NEXT_PUBLIC_SOROBAN_RPC_URL"),
    NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: readEnvValue(source, "NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID"),
    NEXT_PUBLIC_VAULT_ASSET_CODE: readEnvValue(source, "NEXT_PUBLIC_VAULT_ASSET_CODE"),
    NEXT_PUBLIC_VAULT_ASSET_ISSUER: readEnvValue(source, "NEXT_PUBLIC_VAULT_ASSET_ISSUER"),
    NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID: readEnvValue(
      source,
      "NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID"
    ),
    TRUSTLESS_WORK_API_BASE_URL: readEnvValue(source, "TRUSTLESS_WORK_API_BASE_URL"),
    TRUSTLESS_WORK_API_KEY: readEnvValue(source, "TRUSTLESS_WORK_API_KEY")
  } satisfies FrontendEnv;

  const errors: string[] = [];

  const walletIdError = validateRequiredString(
    "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID",
    env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
  );
  if (walletIdError) errors.push(walletIdError);

  const passphraseError = validateRequiredString(
    "NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE",
    env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE
  );
  if (passphraseError) errors.push(passphraseError);

  const horizonError = validateUrl("NEXT_PUBLIC_HORIZON_URL", env.NEXT_PUBLIC_HORIZON_URL);
  if (horizonError) errors.push(horizonError);

  const rpcError = validateUrl("NEXT_PUBLIC_SOROBAN_RPC_URL", env.NEXT_PUBLIC_SOROBAN_RPC_URL);
  if (rpcError) errors.push(rpcError);

  const contractError = validateRequiredString(
    "NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID",
    env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID
  );
  if (contractError) errors.push(contractError);

  const assetCodeError = validateRequiredString(
    "NEXT_PUBLIC_VAULT_ASSET_CODE",
    env.NEXT_PUBLIC_VAULT_ASSET_CODE
  );
  if (assetCodeError) errors.push(assetCodeError);

  const assetIssuerError = validateStellarAccountId(
    "NEXT_PUBLIC_VAULT_ASSET_ISSUER",
    env.NEXT_PUBLIC_VAULT_ASSET_ISSUER
  );
  if (assetIssuerError) errors.push(assetIssuerError);

  const trustlessBaseUrlError = validateOptionalUrl(
    "TRUSTLESS_WORK_API_BASE_URL",
    env.TRUSTLESS_WORK_API_BASE_URL
  );
  if (trustlessBaseUrlError) errors.push(trustlessBaseUrlError);

  const publicNetwork = "Public Global Stellar Network ; September 2015";
  const supportedNetworks = [publicNetwork, "Test SDF Network ; September 2015", "Test SDF Future Network ; October 2022", "Standalone Network ; February 2017"];
  if (!supportedNetworks.includes(env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE)) {
    errors.push("NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE must be a supported Stellar network passphrase");
  }
  const mode = source.APP_ENV ?? (source.NODE_ENV === "production" ? "production" : "local");
  if (!["local", "staging", "production"].includes(mode)) errors.push("APP_ENV must be local, staging, or production");
  if (mode !== "production" && env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE === publicNetwork) errors.push("NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE mainnet requires production mode");
  for (const key of ["NEXT_PUBLIC_HORIZON_URL", "NEXT_PUBLIC_SOROBAN_RPC_URL", "TRUSTLESS_WORK_API_BASE_URL"] as const) {
    const value = env[key];
    if (value && mode !== "local" && !value.startsWith("https://")) errors.push(`${key} requires HTTPS in shared environments`);
  }
  for (const key of ["NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID", "NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID"] as const) {
    if (env[key] && !/^C[A-Z2-7]{55}$/.test(env[key])) errors.push(`${key} must be a Stellar contract ID (C… 56 characters)`);
  }
  for (const key of Object.keys(source)) {
    if (/^NEXT_PUBLIC_.*(?:SECRET|PRIVATE_KEY|API_KEY|SIGNING_SEED)/i.test(key) && source[key]) errors.push(`${key} must remain server-only; remove the NEXT_PUBLIC_ prefix`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid frontend env: ${errors.join("; ")}`);
  }

  return env;
}

export function getFrontendEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): FrontendEnv {
  return parseFrontendEnv(source);
}

type ManifestLoader = () => { version: string; environment: string; network: { passphrase: string; sorobanRpcUrl: string; horizonUrl: string }; contracts: { dripPool: { contractId: string }; escrow?: { contractId: string } } };
type ManifestValidator = (manifest: ReturnType<ManifestLoader>, env: Record<string, string | undefined>) => Array<{ field: string; manifestValue: string; envValue: string }>;

let _loadManifest: ManifestLoader | null = null;
let _validateManifest: ManifestValidator | null = null;
let _manifestAttestation: ManifestAttestation | null = null;

export function registerManifestLoader(
  loadFn: ManifestLoader,
  validateFn: ManifestValidator
): void {
  _loadManifest = loadFn;
  _validateManifest = validateFn;
}

export function getManifestAttestation(): ManifestAttestation | null {
  return _manifestAttestation;
}

export function attestManifest(
  env: FrontendEnv,
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ManifestAttestation {
  if (!_loadManifest || !_validateManifest) {
    return { verified: false, mismatches: [] };
  }

  try {
    const manifest = _loadManifest();
    const mismatches = _validateManifest(manifest, source);

    const attestation: ManifestAttestation = {
      verified: mismatches.length === 0,
      version: manifest.version,
      environment: manifest.environment,
      mismatches,
    };

    _manifestAttestation = attestation;
    return attestation;
  } catch {
    return { verified: false, mismatches: [] };
  }
}
