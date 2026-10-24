#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "fs";
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

// #854 — Cross-environment configuration drift detection
// Compares configurations across multiple environment files to detect
// unintended divergence before deployment.
const ENV_FILES = [".env", ".env.local", ".env.production", ".env.staging"];
const CRITICAL_KEYS = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SOROBAN_RPC_URL",
  "NEXT_PUBLIC_HORIZON_URL",
  "NETWORK_PASSPHRASE",
  "INTERNAL_SERVICE_SECRET",
];

interface EnvSnapshot {
  source: string;
  values: Record<string, string>;
}

interface DriftEntry {
  key: string;
  sources: Record<string, string | undefined>;
  severity: "critical" | "warning" | "info";
  message: string;
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
      values[key] = value;
    }
  }
  return values;
}

function detectCrossEnvDrift(snapshots: EnvSnapshot[]): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const allKeys = new Set<string>();

  for (const snap of snapshots) {
    for (const key of Object.keys(snap.values)) {
      allKeys.add(key);
    }
  }

  for (const key of allKeys) {
    const sources: Record<string, string | undefined> = {};
    const uniqueValues = new Set<string>();

    for (const snap of snapshots) {
      const value = snap.values[key];
      sources[snap.source] = value;
      if (value !== undefined) uniqueValues.add(value);
    }

    if (uniqueValues.size > 1) {
      const severity = CRITICAL_KEYS.includes(key) ? "critical" : "warning";
      drift.push({
        key,
        sources,
        severity,
        message: `Key '${key}' has ${uniqueValues.size} different values across environments`,
      });
    }
  }

  return drift;
}

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

  // 3. Cross-Environment Configuration Drift Detection (#854)
  console.log("\n=== Cross-Environment Configuration Drift Check ===");
  const envSnapshots: EnvSnapshot[] = [];
  for (const file of ENV_FILES) {
    const values = loadEnvFile(resolve(ROOT, file));
    if (Object.keys(values).length > 0) {
      envSnapshots.push({ source: file, values });
      console.log(`  Loaded ${Object.keys(values).length} keys from ${file}`);
    }
  }

  const crossEnvDrift = detectCrossEnvDrift(envSnapshots);
  if (crossEnvDrift.length > 0) {
    console.error(`\n[-] Cross-environment drift detected: ${crossEnvDrift.length} issue(s)`);
    for (const entry of crossEnvDrift) {
      console.error(`  [${entry.severity.toUpperCase()}] ${entry.message}`);
      for (const [source, value] of Object.entries(entry.sources)) {
        if (value !== undefined) {
          console.error(`    ${source}: ${maskSecrets(value, entry.key)}`);
        }
      }
    }
  } else {
    console.log("[+] No cross-environment drift detected.");
  }

  // 4. Human-Readable Output Summary
  if (mismatches.length === 0 && crossEnvDrift.length === 0) {
    console.log("[+] Config Check: PASSED. No drift detected.");
  } else {
    if (mismatches.length > 0) {
      console.error(`[-] Config Check: FAILED. Detected ${mismatches.length} manifest mismatch(es).`);
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
  }

  // 5. Produce Machine-Readable JSON Report
  const report = {
    timestamp: new Date().toISOString(),
    success: mismatches.length === 0 && crossEnvDrift.length === 0,
    mismatchCount: mismatches.length,
    crossEnvDriftCount: crossEnvDrift.length,
    mismatches: mismatches.map((m) => ({
      field: m.field,
      envKey: m.envKey,
      expected: maskSecrets(m.expected, m.envKey),
      active: maskSecrets(m.active, m.envKey),
      critical: m.critical
    })),
    crossEnvDrift: crossEnvDrift.map((d) => ({
      key: d.key,
      severity: d.severity,
      message: d.message,
      sources: Object.fromEntries(
        Object.entries(d.sources).map(([k, v]) => [k, v !== undefined ? maskSecrets(v, d.key) : undefined])
      ),
    })),
  };

  const reportPath = resolve(ROOT, "config-drift-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n[+] Machine-readable report saved to ${reportPath}`);

  // Exit with failure if critical drift is found
  const hasCriticalDrift = mismatches.some((m) => m.critical) || crossEnvDrift.some((d) => d.severity === "critical");
  if (hasCriticalDrift) {
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
