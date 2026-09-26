#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadManifest, validateManifestAgainstEnv } from "../lib/deployment-manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ENV_MAP: Record<string, string> = {
  "network.passphrase": "NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE",
  "network.sorobanRpcUrl": "NEXT_PUBLIC_SOROBAN_RPC_URL",
  "network.horizonUrl": "NEXT_PUBLIC_HORIZON_URL",
  "contracts.dripPool.contractId": "NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID",
  "contracts.escrow.contractId": "NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID",
  "version": "MANIFEST_VERSION",
};

function getNestedValue(obj: any, path: string): string | undefined {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

function runDriftCheck() {
  console.log("=== Running Deployed Configuration Drift Check ===");

  let manifest;
  try {
    manifest = loadManifest();
  } catch (err: any) {
    console.error(`[-] Failed to load deployment manifest: ${err.message}`);
    process.exit(1);
  }

  const env = process.env;
  const mismatches = [];

  // 1. Check standard fields mapped to env vars
  for (const [field, envKey] of Object.entries(ENV_MAP)) {
    const expected = field === "version" ? manifest.version : getNestedValue(manifest, field);
    const active = env[envKey];

    if (expected && active && expected !== active) {
      mismatches.push({
        field,
        envKey,
        expected,
        active,
        critical: true
      });
    }
  }

  // 2. Network Passphrase Environment Guard Check
  if (manifest.network.name === "mainnet") {
    const nodeEnv = env.NODE_ENV || "production";
    if (nodeEnv !== "production") {
      mismatches.push({
        field: "network.environment_guard",
        envKey: "NODE_ENV",
        expected: "production",
        active: nodeEnv,
        critical: true
      });
    }
  }

  // 3. Human-Readable Output Summary
  if (mismatches.length === 0) {
    console.log("[+] Config Check: PASSED. No drift detected between manifest and active environment.");
  } else {
    console.error(`[-] Config Check: FAILED. Detected ${mismatches.length} configuration mismatch(es).`);
    console.error("\nDetailed Configuration Drift Report:");
    console.error("--------------------------------------------------------------------------------");
    console.error(
      sprintf("%-30s %-30s %-25s %-25s", "Field", "Env Key Reference", "Expected (Manifest)", "Active (Env)")
    );
    console.error("--------------------------------------------------------------------------------");

    for (const m of mismatches) {
      console.error(
        sprintf(
          "%-30s %-30s %-25s %-25s",
          m.field,
          m.envKey,
          maskSecrets(m.expected, m.envKey),
          maskSecrets(m.active, m.envKey)
        )
      );
    }
    console.error("--------------------------------------------------------------------------------");
  }

  // 4. Produce Machine-Readable JSON Report
  const report = {
    timestamp: new Date().toISOString(),
    success: mismatches.length === 0,
    mismatchCount: mismatches.length,
    mismatches: mismatches.map((m) => ({
      field: m.field,
      envKey: m.envKey,
      expected: maskSecrets(m.expected, m.envKey),
      active: maskSecrets(m.active, m.envKey),
      critical: m.critical
    }))
  };

  const reportPath = resolve(ROOT, "config-drift-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`[+] Machine-readable report saved to ${reportPath}`);

  // Exit with failure if critical drift is found
  if (mismatches.some((m) => m.critical)) {
    process.exit(1);
  }
}

function sprintf(format: string, ...args: string[]): string {
  let i = 0;
  return format.replace(/%-(?:\d+s)/g, (match) => {
    const width = parseInt(match.slice(2, -1), 10);
    const val = args[i++] || "";
    return val.padEnd(width).slice(0, width);
  });
}

function maskSecrets(val: string, key: string): string {
  // Never print raw secrets/keys if the key contains secret, key, or passphrase
  const lowerKey = key.toLowerCase();
  if (lowerKey.includes("key") || lowerKey.includes("secret") || lowerKey.includes("passphrase")) {
    if (val.length <= 8) return "********";
    return `${val.substring(0, 4)}...${val.substring(val.length - 4)}`;
  }
  return val;
}

runDriftCheck();
