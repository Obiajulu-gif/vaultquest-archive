#!/usr/bin/env node
/**
 * Generates deployment-manifest.json from current environment and build state.
 *
 * Usage:
 *   npx tsx scripts/generate-manifest.ts
 *
 * Env vars consumed:
 *   DEPLOYMENT_ENVIRONMENT          staging | production (default: staging)
 *   NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE
 *   NEXT_PUBLIC_SOROBAN_RPC_URL
 *   NEXT_PUBLIC_HORIZON_URL
 *   NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID
 *   NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID
 *   EVM_VAULT_ADDRESS               (optional, for EVM contract)
 *   EVM_CHAIN_ID                    (optional, default 43113)
 *   GIT_COMMIT_SHA                  (optional, defaults to git rev-parse HEAD)
 *   CONTRACT_WASM_HASH              (optional, pre-computed hash)
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { DeploymentManifestSchema } from "../lib/deployment-manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() || fallback;
}

function getCommitSha(): string {
  if (process.env.GIT_COMMIT_SHA) return process.env.GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function inferNetworkName(passphrase: string): "testnet" | "mainnet" | "futurenet" | "standalone" | "custom" {
  if (passphrase.includes("Public")) return "mainnet";
  if (passphrase.includes("Future")) return "futurenet";
  if (passphrase.includes("Standalone")) return "standalone";
  if (passphrase.includes("Test")) return "testnet";
  return "custom";
}

const passphrase = env("NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015");

const manifest = {
  version: env("MANIFEST_VERSION", "1.0.0"),
  environment: env("DEPLOYMENT_ENVIRONMENT", "staging") as "staging" | "production",
  network: {
    passphrase,
    name: inferNetworkName(passphrase),
    sorobanRpcUrl: env("NEXT_PUBLIC_SOROBAN_RPC_URL", "https://rpc.testnet.stellar.org"),
    horizonUrl: env("NEXT_PUBLIC_HORIZON_URL", "https://horizon-testnet.stellar.org"),
  },
  contracts: {
    dripPool: {
      contractId: env("NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID"),
      specHash: env("DRIP_POOL_SPEC_HASH"),
    },
    ...(env("NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID") ? {
      escrow: {
        contractId: env("NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID"),
        specHash: env("ESCROW_SPEC_HASH"),
      },
    } : {}),
    ...(env("EVM_VAULT_ADDRESS") ? {
      evm: {
        address: env("EVM_VAULT_ADDRESS"),
        chainId: Number(env("EVM_CHAIN_ID", "43113")),
      },
    } : {}),
  },
  assets: [] as Record<string, string>[],
  build: {
    commitSha: getCommitSha(),
    buildTimestamp: new Date().toISOString(),
    contractWasmHash: env("CONTRACT_WASM_HASH"),
  },
};

const result = DeploymentManifestSchema.safeParse(manifest);
if (!result.success) {
  console.error("Manifest validation failed:");
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const outPath = resolve(ROOT, "deployment-manifest.json");

if (existsSync(outPath)) {
  const existing = JSON.parse(readFileSync(outPath, "utf-8"));
  if (existing.version === manifest.version && existing.build?.commitSha === manifest.build.commitSha) {
    console.log(`Manifest unchanged (v${manifest.version} @ ${manifest.build.commitSha}). Skipping write.`);
    process.exit(0);
  }
}

writeFileSync(outPath, JSON.stringify(result.data, null, 2) + "\n");
console.log(`Wrote deployment-manifest.json v${manifest.version} (${manifest.environment})`);
console.log(`  Network: ${manifest.network.name} (${manifest.network.passphrase.substring(0, 30)}...)`);
console.log(`  Commit:  ${manifest.build.commitSha}`);
console.log(`  Drip pool: ${manifest.contracts.dripPool.contractId || "(not set)"}`);
