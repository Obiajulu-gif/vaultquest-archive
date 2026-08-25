export interface FrontendEnv {
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: string;
  NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: string;
  NEXT_PUBLIC_HORIZON_URL: string;
  NEXT_PUBLIC_SOROBAN_RPC_URL: string;
  NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: string;
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
    new URL(value);
    return true;
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

  const trustlessBaseUrlError = validateOptionalUrl(
    "TRUSTLESS_WORK_API_BASE_URL",
    env.TRUSTLESS_WORK_API_BASE_URL
  );
  if (trustlessBaseUrlError) errors.push(trustlessBaseUrlError);

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
