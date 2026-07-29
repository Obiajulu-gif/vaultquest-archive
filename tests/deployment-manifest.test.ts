import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DeploymentManifestSchema,
  validateManifestAgainstEnv,
  assertContractSpecNotDeprecated,
  DEPRECATED_CONTRACT_SPEC_HASHES,
  clearManifestCache,
  type DeploymentManifest,
} from "@/lib/deployment-manifest";

const VALID_MANIFEST: DeploymentManifest = {
  version: "1.0.0",
  environment: "staging",
  network: {
    passphrase: "Test SDF Network ; September 2015",
    name: "testnet",
    sorobanRpcUrl: "https://rpc.testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
  },
  contracts: {
    dripPool: {
      contractId: "CDRYPPOOL1234567890ABCDEF",
      specHash: "sha256:abc123",
    },
    escrow: {
      contractId: "CESCROW1234567890ABCDEF",
      specHash: "sha256:def456",
    },
    evm: {
      address: "0x1234567890123456789012345678901234567890",
      chainId: 43113,
    },
  },
  assets: [],
  build: {
    commitSha: "abc1234",
    buildTimestamp: "2026-07-24T00:00:00Z",
    contractWasmHash: "sha256:hash",
  },
};

describe("DeploymentManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const result = DeploymentManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
  });

  it("rejects non-semver version", () => {
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      version: "not-a-version",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid environment", () => {
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      environment: "dev",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid network name", () => {
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      network: { ...VALID_MANIFEST.network, name: "invalid" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid EVM address", () => {
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      contracts: {
        ...VALID_MANIFEST.contracts,
        evm: { address: "not-an-address", chainId: 43113 },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-URL sorobanRpcUrl", () => {
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      network: { ...VALID_MANIFEST.network, sorobanRpcUrl: "not-a-url" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts manifest without optional escrow", () => {
    const { escrow, ...contracts } = VALID_MANIFEST.contracts;
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      contracts,
    });
    expect(result.success).toBe(true);
  });

  it("accepts manifest without optional evm", () => {
    const { evm, ...contracts } = VALID_MANIFEST.contracts;
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      contracts,
    });
    expect(result.success).toBe(true);
  });

  it("accepts manifest with empty assets array", () => {
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      assets: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("validateManifestAgainstEnv", () => {
  beforeEach(() => {
    clearManifestCache();
  });

  it("returns empty mismatches when manifest matches env", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.testnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
      NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID: "CESCROW1234567890ABCDEF",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches).toEqual([]);
  });

  it("detects passphrase mismatch", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.testnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].field).toBe("network.passphrase");
    expect(mismatches[0].manifestValue).toBe("Test SDF Network ; September 2015");
    expect(mismatches[0].envValue).toBe("Public Global Stellar Network ; September 2015");
  });

  it("detects RPC URL mismatch", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.mainnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches.some((m) => m.field === "network.sorobanRpcUrl")).toBe(true);
  });

  it("detects contract ID mismatch", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.testnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDIFFERENTCONTRACT123",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches.some((m) => m.field === "contracts.dripPool.contractId")).toBe(true);
  });

  it("detects mainnet in non-production env", () => {
    const mainnetManifest: DeploymentManifest = {
      ...VALID_MANIFEST,
      network: {
        ...VALID_MANIFEST.network,
        passphrase: "Public Global Stellar Network ; September 2015",
        name: "mainnet",
        sorobanRpcUrl: "https://rpc.mainnet.stellar.org",
        horizonUrl: "https://horizon.stellar.org",
      },
    };
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.mainnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
      NODE_ENV: "development",
    };
    const mismatches = validateManifestAgainstEnv(mainnetManifest, env);
    expect(mismatches.some((m) => m.field === "network.environment_guard")).toBe(true);
  });

  it("ignores empty env values", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "",
      NEXT_PUBLIC_HORIZON_URL: "",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches).toEqual([]);
  });

  it("ignores missing env values", () => {
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, {});
    expect(mismatches).toEqual([]);
  });

  it("detects multiple mismatches at once", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "wrong-passphrase",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://wrong-rpc.com",
      NEXT_PUBLIC_HORIZON_URL: "https://wrong-horizon.com",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "WRONG_CONTRACT",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches.length).toBeGreaterThanOrEqual(4);
  });
});

describe("stale manifest detection", () => {
  it("detects version field in manifest schema", () => {
    const result = DeploymentManifestSchema.safeParse({
      ...VALID_MANIFEST,
      version: "0.0.1",
    });
    expect(result.success).toBe(true);
    expect(result.data?.version).toBe("0.0.1");
  });

  it("rejects non-semver versions", () => {
    for (const bad of ["1", "1.0", "v1.0.0", "1.0.0-beta", "latest"]) {
      const result = DeploymentManifestSchema.safeParse({
        ...VALID_MANIFEST,
        version: bad,
      });
      expect(result.success).toBe(false);
    }
  });
});

describe("preview/mainnet mixup prevention", () => {
  it("accepts testnet passphrase on testnet", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NODE_ENV: "development",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches).toEqual([]);
  });

  it("blocks mainnet in development", () => {
    const mainnetManifest: DeploymentManifest = {
      ...VALID_MANIFEST,
      network: {
        ...VALID_MANIFEST.network,
        passphrase: "Public Global Stellar Network ; September 2015",
        name: "mainnet",
        sorobanRpcUrl: "https://rpc.mainnet.stellar.org",
        horizonUrl: "https://horizon.stellar.org",
      },
    };
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.mainnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
      NODE_ENV: "development",
    };
    const mismatches = validateManifestAgainstEnv(mainnetManifest, env);
    expect(mismatches.length).toBeGreaterThan(0);
  });

  it("allows mainnet in production", () => {
    const mainnetManifest: DeploymentManifest = {
      ...VALID_MANIFEST,
      network: {
        ...VALID_MANIFEST.network,
        passphrase: "Public Global Stellar Network ; September 2015",
        name: "mainnet",
        sorobanRpcUrl: "https://rpc.mainnet.stellar.org",
        horizonUrl: "https://horizon.stellar.org",
      },
    };
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.mainnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
      NODE_ENV: "production",
    };
    const mismatches = validateManifestAgainstEnv(mainnetManifest, env);
    expect(mismatches).toEqual([]);
  });
});

describe("malicious RPC response handling", () => {
  it("manifest locks expected RPC URL", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://evil-rpc.steal-tokens.com",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches.some((m) => m.field === "network.sorobanRpcUrl")).toBe(true);
  });

  it("manifest locks expected Horizon URL", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.testnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://evil-horizon.steal-tokens.com",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches.some((m) => m.field === "network.horizonUrl")).toBe(true);
  });
});

describe("deprecated contract spec rejection (#495)", () => {
  it("accepts a manifest whose spec hash is not deprecated", () => {
    expect(() => assertContractSpecNotDeprecated(VALID_MANIFEST)).not.toThrow();
  });

  it("accepts a manifest with no specHash pinned", () => {
    const manifest: DeploymentManifest = {
      ...VALID_MANIFEST,
      contracts: {
        ...VALID_MANIFEST.contracts,
        dripPool: { contractId: VALID_MANIFEST.contracts.dripPool.contractId },
      },
    };
    expect(() => assertContractSpecNotDeprecated(manifest)).not.toThrow();
  });

  it("rejects a manifest whose dripPool specHash is on the deprecated list", () => {
    const deprecatedHash = "sha256:deprecated-legacy-vault-spec";
    (DEPRECATED_CONTRACT_SPEC_HASHES as Set<string>).add(deprecatedHash);
    try {
      const manifest: DeploymentManifest = {
        ...VALID_MANIFEST,
        contracts: {
          ...VALID_MANIFEST.contracts,
          dripPool: { ...VALID_MANIFEST.contracts.dripPool, specHash: deprecatedHash },
        },
      };
      expect(() => assertContractSpecNotDeprecated(manifest)).toThrow(/deprecated contract spec/);
    } finally {
      (DEPRECATED_CONTRACT_SPEC_HASHES as Set<string>).delete(deprecatedHash);
    }
  });
});

describe("rotation scenarios", () => {
  it("contract ID rotation detected by mismatch", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.testnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "NEW_CONTRACT_ID_AFTER_ROTATION",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches.some((m) => m.field === "contracts.dripPool.contractId")).toBe(true);
  });

  it("passphrase rotation detected by mismatch", () => {
    const env = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "New rotated passphrase",
      NEXT_PUBLIC_SOROBAN_RPC_URL: "https://rpc.testnet.stellar.org",
      NEXT_PUBLIC_HORIZON_URL: "https://horizon-testnet.stellar.org",
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDRYPPOOL1234567890ABCDEF",
    };
    const mismatches = validateManifestAgainstEnv(VALID_MANIFEST, env);
    expect(mismatches.some((m) => m.field === "network.passphrase")).toBe(true);
  });
});
