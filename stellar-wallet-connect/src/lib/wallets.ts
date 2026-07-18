// Stellar wallet configuration and types

import { getFrontendEnv } from "../core/env";

export type WalletType = "xbull" | "albedo" | "freighter" | "rabet" | "ledger";

export interface WalletConfig {
  id: WalletType;
  name: string;
  displayName: string;
  description: string;
  icon: string;
  website: string;
  downloadUrl: string;
  supportedNetworks: NetworkType[];
  isMobile: boolean;
  isHardware: boolean;
  recommended: boolean;
}

export type NetworkType = "mainnet" | "testnet" | "futurenet" | "standalone";

export interface NetworkConfig {
  id: NetworkType;
  name: string;
  displayName: string;
  passphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  isTestnet: boolean;
  isSupported: boolean;
}

// Stellar network configurations
export const STELLAR_NETWORKS: Record<NetworkType, NetworkConfig> = {
  mainnet: {
    id: "mainnet",
    name: "Stellar Mainnet",
    displayName: "Stellar Mainnet",
    passphrase: "Public Global Stellar Network ; September 2015",
    rpcUrl: "https://rpc.mainnet.stellar.org",
    horizonUrl: "https://horizon.stellar.org",
    isTestnet: false,
    isSupported: true,
  },
  testnet: {
    id: "testnet",
    name: "Stellar Testnet",
    displayName: "Stellar Testnet",
    passphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://rpc.testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    isTestnet: true,
    isSupported: true,
  },
  futurenet: {
    id: "futurenet",
    name: "Stellar Futurenet",
    displayName: "Stellar Futurenet",
    passphrase: "Test SDF Future Network ; October 2022",
    rpcUrl: "https://rpc.futurenet.stellar.org",
    horizonUrl: "https://horizon-futurenet.stellar.org",
    isTestnet: true,
    isSupported: false,
  },
  standalone: {
    id: "standalone",
    name: "Standalone Network",
    displayName: "Standalone Network",
    passphrase: "Standalone Network ; February 2017",
    rpcUrl: "http://localhost:8000",
    horizonUrl: "http://localhost:8000",
    isTestnet: true,
    isSupported: false,
  },
};

export function normalizeStellarNetwork(networkOrPassphrase?: string): NetworkType | undefined {
  if (!networkOrPassphrase) return undefined;

  const val = networkOrPassphrase.toLowerCase();

  if (val.includes("public") || val === "mainnet") {
    return "mainnet";
  }
  if (val.includes("test") || val === "testnet") {
    return "testnet";
  }
  if (val.includes("future") || val === "futurenet") {
    return "futurenet";
  }
  if (
    val.includes("standalone") ||
    val.includes("localhost") ||
    val === "standalone" ||
    val.includes("127.0.0.1")
  ) {
    return "standalone";
  }
  return undefined;
}

// Dynamically compute EXPECTED_NETWORK based on env
let expected: NetworkType = "testnet";
try {
  const env = getFrontendEnv();
  const normalized = normalizeStellarNetwork(env.NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE);
  if (normalized) {
    expected = normalized;
  }
} catch {
  // Fallback if environment is not parsed/valid yet
}

export const EXPECTED_NETWORK = expected;
