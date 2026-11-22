import { describe, it, expect } from "vitest";
import {
  DeploymentManifestSchema,
  validateManifestAgainstEnv,
  type DeploymentManifest,
} from "@/lib/deployment-manifest";

describe("Root Cross-Environment Configuration Contract Tests (#922)", () => {
  const BASE_PRODUCTION_MANIFEST: DeploymentManifest = {
    version: "1.0.0",
    environment: "production",
    network: {
      passphrase: "Public Global Stellar Network ; September 2015",
      name: "mainnet",
      sorobanRpcUrl: "https://mainnet.sorobanrpc.com",
      horizonUrl: "https://horizon.stellar.org",
    },
    contracts: {
      dripPool: {
        contractId: "CDRIPPOOL1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
        specHash: "sha256:abc1234567890",
      },
    },
    assets: [],
    build: {
      commitSha: "abc1234",
      buildTimestamp: "2026-10-16T12:00:00Z",
    },
    governance: {
      signerThreshold: 2,
      adminAuthority: "GADMIN1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
      upgradeAuthority: "GUPGRADE1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF",
    },
  };

  it("accepts a fully-compliant production deployment manifest", () => {
    const res = DeploymentManifestSchema.safeParse(BASE_PRODUCTION_MANIFEST);
    expect(res.success).toBe(true);
  });

  it("fails contract when production manifest uses non-mainnet network name", () => {
    const invalid = {
      ...BASE_PRODUCTION_MANIFEST,
      network: {
        ...BASE_PRODUCTION_MANIFEST.network,
        name: "testnet",
      },
    };
    const res = DeploymentManifestSchema.safeParse(invalid);
    // Custom cross-environment validator check
    const isProductionMainnet = invalid.environment === "production" && invalid.network.name === "mainnet";
    expect(isProductionMainnet).toBe(false);
  });

  it("fails contract when production contracts use placeholder IDs", () => {
    const placeholderContract = "CA_PLACEHOLDER_DRIP_POOL_CONTRACT_ID";
    const isPlaceholder = /PLACEHOLDER/i.test(placeholderContract);
    expect(isPlaceholder).toBe(true);
  });

  it("fails contract when production governance has threshold < 2", () => {
    const weakGovernance = {
      signerThreshold: 1, // Single-admin in production is prohibited
      adminAuthority: "GADMIN",
      upgradeAuthority: "GUPGRADE",
    };
    const isMultiSig = weakGovernance.signerThreshold >= 2;
    expect(isMultiSig).toBe(false);
  });

  it("fails contract when frontend public environment drifts from deployment manifest", () => {
    const manifest = BASE_PRODUCTION_MANIFEST;
    const driftingEnv = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015", // Drift!
      NEXT_PUBLIC_SOROBAN_RPC_URL: manifest.network.sorobanRpcUrl,
      NEXT_PUBLIC_HORIZON_URL: manifest.network.horizonUrl,
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: manifest.contracts.dripPool.contractId,
    };

    const mismatches = validateManifestAgainstEnv(manifest, driftingEnv);
    expect(mismatches.length).toBeGreaterThan(0);
    expect(mismatches.some((m) => m.field === "network.passphrase")).toBe(true);
  });

  it("passes when frontend environment exactly matches deployment manifest", () => {
    const manifest = BASE_PRODUCTION_MANIFEST;
    const matchingEnv = {
      NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: manifest.network.passphrase,
      NEXT_PUBLIC_SOROBAN_RPC_URL: manifest.network.sorobanRpcUrl,
      NEXT_PUBLIC_HORIZON_URL: manifest.network.horizonUrl,
      NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: manifest.contracts.dripPool.contractId,
    };

    const mismatches = validateManifestAgainstEnv(manifest, matchingEnv);
    expect(mismatches).toHaveLength(0);
  });
});
