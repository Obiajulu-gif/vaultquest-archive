import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  validateCrossEnvironmentContract,
  assertCrossEnvironmentContract,
  ConfigurationContractError,
} from "../src/config/crossEnvContract.js";

describe("Cross-Environment Configuration Contract Tests (#922)", () => {
  const validProductionSecret = "prod_sec_0123456789abcdef0123456789abcdef";
  const validApiKey = "prod_api_key_0123456789abcdef0123456789abcdef";
  const validSeed = Keypair.random().secret();
  const validContractId = StrKey.encodeContract(Buffer.alloc(32));

  const validProductionEnv = {
    APP_ENV: "production",
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:pass@db.example.com:5432/vaultquest_prod?sslmode=verify-full",
    INTERNAL_SERVICE_SECRET: validProductionSecret,
    RECEIPT_SIGNING_SECRET: validSeed,
    API_KEY: validApiKey,
    NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    SOROBAN_RPC_URL: "https://soroban-rpc.stellar.org",
    INDEXER_CONTRACT_IDS: validContractId,
    REDIS_URL: "rediss://redis.example.com:6380",
  };

  const validStagingEnv = {
    APP_ENV: "staging",
    NODE_ENV: "production",
    DATABASE_URL: "postgres://user:pass@staging-db.example.com:5432/vaultquest_stage?sslmode=require",
    INTERNAL_SERVICE_SECRET: "stage_sec_0123456789abcdef0123456789abcdef",
    RECEIPT_SIGNING_SECRET: validSeed,
    API_KEY: "stage_api_key_0123456789abcdef0123456789abcdef",
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    SOROBAN_RPC_URL: "https://rpc.testnet.stellar.org",
    INDEXER_CONTRACT_IDS: validContractId,
    REDIS_URL: "rediss://staging-redis.example.com:6380",
  };

  const validLocalEnv = {
    APP_ENV: "local",
    NODE_ENV: "development",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/vaultquest_dev",
    INTERNAL_SERVICE_SECRET: "local_sec_0123456789abcdef0123456789abcdef",
    NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  };

  describe("Happy Path Validation", () => {
    it("passes for fully-compliant production configuration", () => {
      const report = validateCrossEnvironmentContract(validProductionEnv);
      expect(report.valid).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(() => assertCrossEnvironmentContract(validProductionEnv)).not.toThrow();
    });

    it("passes for compliant staging configuration", () => {
      const report = validateCrossEnvironmentContract(validStagingEnv);
      expect(report.valid).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(() => assertCrossEnvironmentContract(validStagingEnv)).not.toThrow();
    });

    it("passes for compliant local configuration", () => {
      const report = validateCrossEnvironmentContract(validLocalEnv);
      expect(report.valid).toBe(true);
      expect(report.violations).toHaveLength(0);
      expect(() => assertCrossEnvironmentContract(validLocalEnv)).not.toThrow();
    });
  });

  describe("Missing Required Settings Failures", () => {
    it("fails when critical environment variables are missing in production", () => {
      const { DATABASE_URL, ...missingDb } = validProductionEnv;
      const reportDb = validateCrossEnvironmentContract(missingDb);
      expect(reportDb.valid).toBe(false);
      expect(reportDb.violations.some((v) => v.field === "DATABASE_URL")).toBe(true);

      const { RECEIPT_SIGNING_SECRET, ...missingSecret } = validProductionEnv;
      const reportSecret = validateCrossEnvironmentContract(missingSecret);
      expect(reportSecret.valid).toBe(false);
      expect(reportSecret.violations.some((v) => v.field === "RECEIPT_SIGNING_SECRET")).toBe(true);

      expect(() => assertCrossEnvironmentContract(missingSecret)).toThrow(ConfigurationContractError);
    });

    it("fails when NODE_ENV is not production for shared tiers", () => {
      const invalidNodeEnv = { ...validProductionEnv, NODE_ENV: "development" };
      const report = validateCrossEnvironmentContract(invalidNodeEnv);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.field === "NODE_ENV")).toBe(true);
    });
  });

  describe("Contract ID and Network Settings Contract Failures", () => {
    it("fails when contract IDs are invalid StrKey formats", () => {
      const badContractEnv = {
        ...validProductionEnv,
        INDEXER_CONTRACT_IDS: "INVALID_CONTRACT_HASH_FORMAT",
      };
      const report = validateCrossEnvironmentContract(badContractEnv);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "INVALID_CONTRACT_ID")).toBe(true);
    });

    it("fails when production uses non-mainnet passphrase", () => {
      const badNetworkEnv = {
        ...validProductionEnv,
        NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      };
      const report = validateCrossEnvironmentContract(badNetworkEnv);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "MAINNET_PASSPHRASE_MISMATCH")).toBe(true);
    });

    it("fails when staging uses mainnet passphrase", () => {
      const badStagingEnv = {
        ...validStagingEnv,
        NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      };
      const report = validateCrossEnvironmentContract(badStagingEnv);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "TESTNET_PASSPHRASE_MISMATCH")).toBe(true);
    });

    it("fails when local uses mainnet passphrase", () => {
      const badLocalEnv = {
        ...validLocalEnv,
        NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      };
      const report = validateCrossEnvironmentContract(badLocalEnv);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "MAINNET_IN_LOCAL")).toBe(true);
    });
  });

  describe("Secret Hygiene & Transport Security", () => {
    it("fails when secret is exposed via NEXT_PUBLIC_ prefix", () => {
      const leakedEnv = {
        ...validProductionEnv,
        NEXT_PUBLIC_SIGNING_SECRET: "private_key_should_never_be_public",
      };
      const report = validateCrossEnvironmentContract(leakedEnv);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "SECRET_EXPOSED_TO_CLIENT")).toBe(true);
    });

    it("fails when placeholder secrets are detected in production", () => {
      const placeholderEnv = {
        ...validProductionEnv,
        INTERNAL_SERVICE_SECRET: "PLACEHOLDER_SERVICE_SECRET_123456",
      };
      const report = validateCrossEnvironmentContract(placeholderEnv);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "SECRET_CONTAINS_PLACEHOLDER")).toBe(true);
    });

    it("fails when database URL lacks sslmode in production", () => {
      const unencryptedDb = {
        ...validProductionEnv,
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/vaultquest_prod", // No sslmode
      };
      const report = validateCrossEnvironmentContract(unencryptedDb);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "INSECURE_DB_TLS")).toBe(true);
    });

    it("fails when Redis URL does not use TLS (rediss:) in production", () => {
      const unencryptedRedis = {
        ...validProductionEnv,
        REDIS_URL: "redis://redis.example.com:6379", // Plain redis: without TLS
      };
      const report = validateCrossEnvironmentContract(unencryptedRedis);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "INSECURE_REDIS_PROTOCOL")).toBe(true);
    });

    it("fails when Soroban RPC URL uses unencrypted HTTP in production", () => {
      const httpRpc = {
        ...validProductionEnv,
        SOROBAN_RPC_URL: "http://soroban-rpc.stellar.org",
      };
      const report = validateCrossEnvironmentContract(httpRpc);
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "INSECURE_RPC_PROTOCOL")).toBe(true);
    });
  });

  describe("Cross-Stack Drift & Governance Contract", () => {
    it("fails when frontend and backend network passphrases drift", () => {
      const frontendEnv = {
        NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      };
      const report = validateCrossEnvironmentContract(validProductionEnv, { frontendEnv });
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "CROSS_STACK_DRIFT")).toBe(true);
    });

    it("fails when frontend drip pool contract is missing from backend indexer contract list", () => {
      const frontendEnv = {
        NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID: "CDIFFERENTPOOL1234567890ABCDEF1234567890ABCDEF1234567890",
      };
      const report = validateCrossEnvironmentContract(validProductionEnv, { frontendEnv });
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.field === "CROSS_STACK_DRIP_POOL_CONTRACT")).toBe(true);
    });

    it("fails when production manifest governance threshold is less than 2", () => {
      const manifest = {
        network: { name: "mainnet" },
        governance: { signerThreshold: 1 }, // Violates production multisig requirement
      };
      const report = validateCrossEnvironmentContract(validProductionEnv, { manifest });
      expect(report.valid).toBe(false);
      expect(report.violations.some((v) => v.code === "INSUFFICIENT_SIGNER_THRESHOLD")).toBe(true);
    });
  });
});
