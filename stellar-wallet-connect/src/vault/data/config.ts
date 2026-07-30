declare const process: { env: Record<string, string | undefined> } | undefined;

export interface VaultNetworkConfig {
  name: "testnet" | "mainnet" | "futurenet" | "custom";
  passphrase: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
}

export interface VaultFeatureFlags {
  backendReads: boolean;
  contractFallbackReads: boolean;
  transactionPolling: boolean;
}

export interface VaultDataConfig {
  apiBaseUrl: string;
  dripPoolContractId: string;
  escrowContractId?: string;
  network: VaultNetworkConfig;
  featureFlags: VaultFeatureFlags;
  manifestVersion?: string;
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const FUTURENET_PASSPHRASE = "Test SDF Future Network ; October 2022";

function read(source: Record<string, string | undefined>, key: string, fallback = ""): string {
  return source[key]?.trim() || fallback;
}

function readBoolean(source: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const value = source[key]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function inferNetworkName(passphrase: string): VaultNetworkConfig["name"] {
  if (passphrase === MAINNET_PASSPHRASE) return "mainnet";
  if (passphrase === FUTURENET_PASSPHRASE) return "futurenet";
  if (passphrase === TESTNET_PASSPHRASE) return "testnet";
  return "custom";
}

type ManifestGetter = () => {
  version: string;
  network: { passphrase: string; name: string; horizonUrl: string; sorobanRpcUrl: string };
  contracts: { dripPool: { contractId: string }; escrow?: { contractId: string } };
} | null;

let _manifestGetter: ManifestGetter | null = null;

export function registerManifestGetter(getter: ManifestGetter): void {
  _manifestGetter = getter;
}

export function createVaultDataConfig(
  source: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): VaultDataConfig {
  const manifest = _manifestGetter?.();

  const passphrase = manifest?.network?.passphrase
    || read(source, "NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE", read(source, "PUBLIC_SOROBAN_NETWORK_PASSPHRASE"));

  const networkName = manifest?.network?.name as VaultNetworkConfig["name"] | undefined
    || inferNetworkName(passphrase);

  return {
    apiBaseUrl: read(source, "NEXT_PUBLIC_VAULTQUEST_API_BASE_URL", read(source, "PUBLIC_VAULTQUEST_API_BASE_URL", "/api")),
    dripPoolContractId: manifest?.contracts?.dripPool?.contractId
      || read(source, "NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID"),
    escrowContractId: manifest?.contracts?.escrow?.contractId
      || read(source, "NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID") || undefined,
    network: {
      name: networkName,
      passphrase,
      horizonUrl: manifest?.network?.horizonUrl
        || read(source, "NEXT_PUBLIC_HORIZON_URL", read(source, "PUBLIC_HORIZON_URL")),
      sorobanRpcUrl: manifest?.network?.sorobanRpcUrl
        || read(source, "NEXT_PUBLIC_SOROBAN_RPC_URL"),
    },
    featureFlags: {
      backendReads: readBoolean(source, "NEXT_PUBLIC_VAULTQUEST_BACKEND_READS", true),
      contractFallbackReads: readBoolean(source, "NEXT_PUBLIC_VAULTQUEST_CONTRACT_FALLBACK_READS", true),
      transactionPolling: readBoolean(source, "NEXT_PUBLIC_VAULTQUEST_TRANSACTION_POLLING", true),
    },
    manifestVersion: manifest?.version,
  };
}

export const defaultVaultDataConfig = createVaultDataConfig();
