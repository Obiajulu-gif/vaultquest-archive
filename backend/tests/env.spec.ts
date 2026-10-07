import { describe, it, expect } from "vitest";
import { getEnv, parseEnv } from "../src/env.js";

describe("parseEnv", () => {
  it("accepts valid env", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123",
      ORPHAN_TTL_MINUTES: "10",
      LOG_LEVEL: "info"
    });
    expect(env.DATABASE_URL).toBe("postgres://u:p@localhost:5432/db");
    expect(env.ORPHAN_TTL_MINUTES).toBe(10);
  });

  it("rejects missing DATABASE_URL", () => {
    expect(() =>
      parseEnv({ INTERNAL_SERVICE_SECRET: "abcdefghij1234567890" })
    ).toThrow(/DATABASE_URL/);
  });

  it("rejects short INTERNAL_SERVICE_SECRET", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        INTERNAL_SERVICE_SECRET: "short"
      })
    ).toThrow(/INTERNAL_SERVICE_SECRET/);
  });

  it("rejects placeholder INTERNAL_SERVICE_SECRET", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
        INTERNAL_SERVICE_SECRET: "change-me-to-a-long-random-string"
      })
    ).toThrow(/placeholder/i);
  });

  it("defaults ORPHAN_TTL_MINUTES to 10", () => {
    const env = parseEnv({
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      INTERNAL_SERVICE_SECRET: "a-very-long-shared-secret-value-123"
    });
    expect(env.ORPHAN_TTL_MINUTES).toBe(10);
  });
});

const local = { DATABASE_URL: "postgres://u:p@localhost:5432/vaultquest", INTERNAL_SERVICE_SECRET: "local-unique-secret-0123456789abcdef" };
describe("secure configuration policy", () => {
  it.each(["postgres-invalid", "https://localhost/db", "postgres://localhost", "postgres://localhost/db#fragment"])("rejects malformed database URL %s", (DATABASE_URL) => {
    expect(() => parseEnv({ ...local, DATABASE_URL })).toThrow(/DATABASE_URL/);
  });
  it.each([
    { DATABASE_URL: "postgres://u:p@remote.example.org/db" },
    { DATABASE_URL: "postgres://u:p@localhost/production" },
    { INTERNAL_SERVICE_SECRET: "prod_0123456789abcdefghijklmnop" },
    { INTERNAL_SERVICE_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015" },
    { WORKER_ENABLED: "yes" },
    { SANDBOX_MODE: "true" },
    { PORT: "65536" },
    { REPLAY_DATABASE_URL: "postgresql://different:credential@127.0.0.1:5432/vaultquest?sslmode=require" },
    { OPERATION_LIMITS: "invalid-json" },
    { DATABASE_URL: "postgres://u:p@localhost/%70roduction" },
    { DATABASE_URL: "postgres://u:p@localhost/db?host=production.example.org" },
    { ADMIN_WALLET_ADDRESSES: "invalid" },
    { STRIPE_WEBHOOK_SECRET: "incorrect-prefix-0123456789abcdef" },
    { NEXT_PUBLIC_SIGNING_SECRET: "private-secret" },
    { REDIS_URL: "https://localhost" },
    { SENDGRID_API_KEY: "local-sendgrid-0123456789abcdef" },
    { SOROBAN_RPC_URL: "https://rpc.example.org" },
    { INDEXER_CONTRACT_IDS: "invalid" },
    { RECEIPT_SIGNING_SECRET: "S" + "A".repeat(55) },
    { BACKUP_SCHEDULE: "invalid" },
    { NODE_ENV: "production", APP_ENV: "local" },
  ])("rejects unsafe or malformed combinations %#", (override) => {
    expect(() => parseEnv({ ...local, ...override })).toThrow(/Invalid backend env/);
  });
  const shared = { ...local, NODE_ENV: "production", APP_ENV: "staging", DATABASE_URL: "postgres://u:p@staging.example.org/db?sslmode=verify-full", API_KEY: "staging-api-key-0123456789abcdefgh", NETWORK_PASSPHRASE: "Test SDF Network ; September 2015" };
  it("requires stable receipt signing in shared deployments", () => {
    expect(() => parseEnv(shared)).toThrow(/RECEIPT_SIGNING_SECRET/);
  });
  it("accepts staging and production with isolated secrets and TLS", async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const RECEIPT_SIGNING_SECRET = Keypair.random().secret();
    expect(parseEnv({ ...shared, RECEIPT_SIGNING_SECRET }).APP_ENV).toBe("staging");
    expect(parseEnv({ ...shared, RECEIPT_SIGNING_SECRET, APP_ENV: "production", NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015" }).APP_ENV).toBe("production");
    expect(() => parseEnv({ ...shared, RECEIPT_SIGNING_SECRET, DATABASE_URL: "postgres://u:p@remote.example.org/db" })).toThrow(/sslmode/);
  });
  it("never includes rejected secrets or credential URLs in errors", () => {
    const sensitive = "prod_sensitive-0123456789abcdef";
    try { parseEnv({ ...local, INTERNAL_SERVICE_SECRET: sensitive, DATABASE_URL: "https://user:private-password@host/db", NODE_ENV: sensitive }); }
    catch (error) {
      expect(String(error)).not.toContain(sensitive);
      expect(String(error)).not.toContain("private-password");
      expect(String(error)).toContain("DATABASE_URL");
      return;
    }
    throw new Error("Expected configuration rejection");
  });
  it("redacts production-marked secrets in cross-field errors", () => {
    const sensitive = "prod_sensitive-0123456789abcdef";
    try { parseEnv({ ...local, INTERNAL_SERVICE_SECRET: sensitive }); }
    catch (error) {
      expect(String(error)).toContain("INTERNAL_SERVICE_SECRET");
      expect(String(error)).not.toContain(sensitive);
      return;
    }
    throw new Error("Expected configuration rejection");
  });
  it("refuses validation bypass", () => {
    const previous = process.env.SKIP_ENV_VALIDATION;
    process.env.SKIP_ENV_VALIDATION = "1";
    try { expect(() => getEnv()).toThrow(/bypass is disabled/); }
    finally { if (previous === undefined) delete process.env.SKIP_ENV_VALIDATION; else process.env.SKIP_ENV_VALIDATION = previous; }
  });
});

describe("integration configuration", () => {
  it("accepts a validated sandbox database and boolean feature flags", () => {
    const database = "postgres://u:p@localhost/vaultquest_sandbox";
    const env = parseEnv({ ...local, DATABASE_URL: database, SANDBOX_DATABASE_URL: database, SANDBOX_MODE: "true", WORKER_ENABLED: "false" });
    expect(env.SANDBOX_MODE).toBe(true);
    expect(env.WORKER_ENABLED).toBe(false);
  });
  it("rejects a sandbox that still targets the normal database", () => {
    expect(() => parseEnv({ ...local, SANDBOX_MODE: "true", SANDBOX_DATABASE_URL: "postgres://u:p@localhost/vaultquest_sandbox" })).toThrow(/DATABASE_URL/);
  });
  it("accepts an indexer with a checksum-valid contract and explicit network", async () => {
    const { StrKey } = await import("@stellar/stellar-sdk");
    const env = parseEnv({ ...local, SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org", INDEXER_CONTRACT_IDS: StrKey.encodeContract(Buffer.alloc(32, 1)), NETWORK_PASSPHRASE: "Test SDF Network ; September 2015" });
    expect(env.INDEXER_CONTRACT_IDS).toMatch(/^C/);
  });
});
