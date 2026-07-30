#!/usr/bin/env node
/**
 * Soroban Storage TTL Monitoring Script
 *
 * Usage:
 *   npx tsx scripts/check-ttl.ts [options]
 *
 * Options:
 *   --json                     Output report in machine-readable JSON format
 *   --rpc <url>                Override Soroban RPC URL
 *   --drip-pool <id>           Override DripPool contract ID
 *   --vault <id>               Override Vault contract ID
 *   --threshold-instance <n>   Instance TTL warning threshold in ledgers (default: 10000)
 *   --threshold-persistent <n> Persistent TTL warning threshold in ledgers (default: 150000)
 *   --threshold-code <n>       WASM Code TTL warning threshold in ledgers (default: 200000)
 *   --addresses <addr1,addr2>  Comma-separated list of extra participant addresses to check
 *   --db-url <url>             Override database URL for active address discovery
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import { Address, xdr } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- Default Configuration and Thresholds ---
const DEFAULT_INSTANCE_WARN_THRESHOLD = 10000;      // Approx 14 hours at 5s/ledger
const DEFAULT_PERSISTENT_WARN_THRESHOLD = 150000;    // Approx 8.6 days at 5s/ledger
const DEFAULT_CODE_WARN_THRESHOLD = 200000;          // Approx 11.5 days at 5s/ledger
const SECONDS_PER_LEDGER = 5;

// Fallback addresses for on-chain position lookup if database is offline or empty
const FALLBACK_ADDRESSES = [
  "GBX7Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX4Y6A",
  "GDY3PJEJZZ4YSLB2CMMMX7R6KCP2PNE7A5PXH5XN265LSL73GOHX7B8Z",
  "GCT6Q4DMXD66VFR7YJ3HYBFFW7Q5PNE7A5PXH5XN265LSL73GOHX9C3C",
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
];

interface CLIArgs {
  json: boolean;
  rpcUrl?: string;
  dripPoolId?: string;
  vaultId?: string;
  thresholdInstance: number;
  thresholdPersistent: number;
  thresholdCode: number;
  extraAddresses: string[];
  dbUrl?: string;
}

interface ReportEntry {
  contract: string;
  type: "Instance" | "WASM Code" | "Participant Position" | "User Balance";
  keyLabel: string;
  durability: "Instance" | "Persistent";
  liveUntilLedgerSeq: number;
  remainingLedgers: number;
  approxTimeLeft: string;
  status: "OK" | "WARNING" | "CRITICAL" | "NOT_FOUND";
}

// --- Argument Parser ---
function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const parsed: CLIArgs = {
    json: false,
    thresholdInstance: DEFAULT_INSTANCE_WARN_THRESHOLD,
    thresholdPersistent: DEFAULT_PERSISTENT_WARN_THRESHOLD,
    thresholdCode: DEFAULT_CODE_WARN_THRESHOLD,
    extraAddresses: [],
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--json":
        parsed.json = true;
        break;
      case "--rpc":
        parsed.rpcUrl = args[++i];
        break;
      case "--drip-pool":
        parsed.dripPoolId = args[++i];
        break;
      case "--vault":
        parsed.vaultId = args[++i];
        break;
      case "--threshold-instance":
        parsed.thresholdInstance = parseInt(args[++i], 10);
        break;
      case "--threshold-persistent":
        parsed.thresholdPersistent = parseInt(args[++i], 10);
        break;
      case "--threshold-code":
        parsed.thresholdCode = parseInt(args[++i], 10);
        break;
      case "--addresses":
        parsed.extraAddresses = args[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--db-url":
        parsed.dbUrl = args[++i];
        break;
    }
  }

  return parsed;
}

// --- Config Resolver ---
interface ResolvedConfig {
  rpcUrl: string;
  dripPoolId?: string;
  vaultId?: string;
}

function resolveConfig(args: CLIArgs): ResolvedConfig {
  let manifest: any = {};
  const manifestPath = resolve(ROOT, "deployment-manifest.json");

  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      // Ignore parsing errors, fallback to env
    }
  }

  const rpcUrl =
    args.rpcUrl ||
    process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ||
    process.env.SOROBAN_RPC_URL ||
    manifest.network?.sorobanRpcUrl ||
    "https://rpc.testnet.stellar.org";

  const dripPoolId =
    args.dripPoolId ||
    process.env.NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID ||
    manifest.contracts?.dripPool?.contractId ||
    undefined;

  // Search env values for Vault contract ID
  const vaultId =
    args.vaultId ||
    process.env.NEXT_PUBLIC_VAULT_CONTRACT_ID ||
    manifest.contracts?.vault?.contractId ||
    undefined;

  return { rpcUrl, dripPoolId, vaultId };
}

// --- DB Address Discovery ---
async function fetchAddressesFromDb(dbUrl?: string): Promise<string[]> {
  const prisma = new PrismaClient(
    dbUrl ? { datasources: { db: { url: dbUrl } } } : undefined
  );

  try {
    // Attempt connectivity probe
    await prisma.$queryRaw`SELECT 1`;

    const [ledgerUsers, questUsers, poolUsers] = await Promise.all([
      prisma.actionLedger.findMany({ select: { walletAddress: true }, distinct: ["walletAddress"] }),
      prisma.userQuest.findMany({ select: { walletAddress: true }, distinct: ["walletAddress"] }),
      prisma.savedPool.findMany({ select: { walletAddress: true }, distinct: ["walletAddress"] }),
    ]);

    const set = new Set<string>();
    ledgerUsers.forEach((u) => set.add(u.walletAddress));
    questUsers.forEach((u) => set.add(u.walletAddress));
    poolUsers.forEach((u) => set.add(u.walletAddress));

    return Array.from(set);
  } catch (err) {
    // Database is offline or not configured; fallback gracefully
    return [];
  } finally {
    await prisma.$disconnect();
  }
}

// --- Fetch Ledger Entries ---
interface SorobanRpcResponse {
  result?: {
    latestLedger: number;
    entries?: Array<{
      key: string;
      xdr: string;
      lastModifiedLedgerSeq: number;
      liveUntilLedgerSeq: number;
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

async function queryLedgerEntries(rpcUrl: string, keys: string[]): Promise<{ latestLedger: number; entries: Map<string, any> }> {
  const entriesMap = new Map<string, any>();
  let latestLedger = 0;

  // Batch query keys (max 100 per request to prevent timeouts/limits)
  const batchSize = 100;
  for (let i = 0; i < keys.length; i += batchSize) {
    const chunk = keys.slice(i, i + batchSize);
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "getLedgerEntries",
      params: {
        keys: chunk,
      },
    };

    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Soroban RPC returned HTTP ${res.status}`);
    }

    const payload = (await res.json()) as SorobanRpcResponse;
    if (payload.error) {
      throw new Error(`Soroban RPC Error: ${payload.error.message} (code ${payload.error.code})`);
    }

    if (payload.result) {
      latestLedger = Math.max(latestLedger, payload.result.latestLedger);
      if (payload.result.entries) {
        for (const entry of payload.result.entries) {
          entriesMap.set(entry.key, entry);
        }
      }
    }
  }

  return { latestLedger, entries: entriesMap };
}

// --- Time formatting helper ---
function formatDuration(ledgers: number): string {
  const totalSeconds = ledgers * SECONDS_PER_LEDGER;
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${totalSeconds}s`;
}

function getScAddress(id: string, name: string): any {
  try {
    return Address.fromString(id).toScAddress();
  } catch (err) {
    console.error(`Error: Invalid ${name} contract ID '${id}'. Ensure it is a valid 56-character CA... address.`);
    process.exit(1);
  }
}

// --- Main Runner ---
async function run() {
  const args = parseArgs();
  const config = resolveConfig(args);

  if (!config.dripPoolId && !config.vaultId) {
    console.error("Error: No contract IDs found. Provide via --drip-pool/--vault flags or set NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID in environment.");
    process.exit(1);
  }

  const dripPoolScAddress = config.dripPoolId ? getScAddress(config.dripPoolId, "DripPool") : null;
  const vaultScAddress = config.vaultId ? getScAddress(config.vaultId, "Vault") : null;

  // 1. Resolve participant addresses
  let dbAddresses: string[] = [];
  if (!args.json) {
    console.log("Connecting to database to discover active participant wallets...");
  }
  dbAddresses = await fetchAddressesFromDb(args.dbUrl);
  
  // Combine CLI extra addresses, DB addresses, and fallbacks
  const addressSet = new Set<string>([...args.extraAddresses, ...dbAddresses]);
  if (addressSet.size === 0) {
    if (!args.json) {
      console.log("No addresses found in DB. Using fallback test vectors.");
    }
    FALLBACK_ADDRESSES.forEach((a) => addressSet.add(a));
  }
  const addresses = Array.from(addressSet);

  if (!args.json) {
    console.log(`Resolved ${addresses.length} participant addresses to inspect.`);
    console.log(`Connecting to Soroban RPC: ${config.rpcUrl}`);
  }

  // 2. Build list of base64 LedgerKeys
  const keyMap = new Map<string, { contract: string; type: ReportEntry["type"]; label: string; address?: string }>();
  const keysToQuery: string[] = [];

  const addKey = (contractId: string, ledgerKey: any, type: ReportEntry["type"], label: string, address?: string) => {
    const b64 = ledgerKey.toXDR("base64");
    keysToQuery.push(b64);
    keyMap.set(b64, { contract: contractId, type, label, address });
  };

  // Track contract instance keys
  let dripPoolInstanceKeyB64 = "";
  let vaultInstanceKeyB64 = "";

  if (dripPoolScAddress && config.dripPoolId) {
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: dripPoolScAddress,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    dripPoolInstanceKeyB64 = instanceKey.toXDR("base64");
    addKey(config.dripPoolId, instanceKey, "Instance", "DripPool Instance");
  }

  if (vaultScAddress && config.vaultId) {
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: vaultScAddress,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    vaultInstanceKeyB64 = instanceKey.toXDR("base64");
    addKey(config.vaultId, instanceKey, "Instance", "Vault Instance");
  }

  // Track persistent storage keys for active user addresses
  for (const addr of addresses) {
    let userScAddress: any;
    try {
      userScAddress = Address.fromString(addr).toScAddress();
    } catch {
      continue; // Skip malformed addresses
    }

    if (dripPoolScAddress && config.dripPoolId) {
      // DripPool: DataKey::Participant(Address)
      const keyScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Participant"),
        xdr.ScVal.scvAddress(userScAddress),
      ]);
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: dripPoolScAddress,
          key: keyScVal,
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      addKey(config.dripPoolId, key, "Participant Position", `Participant Position (${addr.slice(0, 6)}...${addr.slice(-4)})`, addr);
    }

    if (vaultScAddress && config.vaultId) {
      // Vault: DataKey::Balance(Address)
      const keyScVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("Balance"),
        xdr.ScVal.scvAddress(userScAddress),
      ]);
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: vaultScAddress,
          key: keyScVal,
          durability: xdr.ContractDataDurability.persistent(),
        })
      );
      addKey(config.vaultId, key, "User Balance", `User Balance (${addr.slice(0, 6)}...${addr.slice(-4)})`, addr);
    }
  }

  // 3. Batch query primary entries
  const queryResult = await queryLedgerEntries(config.rpcUrl, keysToQuery);
  const reports: ReportEntry[] = [];

  // Extract Wasm hashes to query contract code TTL
  const codeKeysToQuery: string[] = [];
  const codeKeyMap = new Map<string, { contract: string; label: string }>();

  const processInstanceWasm = (contractId: string, instanceEntryB64: string, label: string) => {
    try {
      const entry = xdr.LedgerEntry.fromXDR(instanceEntryB64, "base64");
      const contractData = entry.data().contractData();
      const val = contractData.val();
      const instance = val.instance();
      const executable = instance.executable();
      
      let wasmHash: Buffer | null = null;
      try {
        wasmHash = executable.wasmHash();
      } catch {
        // Not a WASM executable (native token contract or other), skip
      }

      if (wasmHash) {
        const codeKey = xdr.LedgerKey.contractCode(
          new xdr.LedgerKeyContractCode({
            hash: wasmHash,
          })
        );
        const codeKeyB64 = codeKey.toXDR("base64");
        codeKeysToQuery.push(codeKeyB64);
        codeKeyMap.set(codeKeyB64, { contract: contractId, label });
      }
    } catch {
      // Skipping parsing errors
    }
  };

  // Process drip pool and vault instances to see if we can resolve WASM hashes
  const dripPoolInstance = queryResult.entries.get(dripPoolInstanceKeyB64);
  if (dripPoolInstance && config.dripPoolId) {
    processInstanceWasm(config.dripPoolId, dripPoolInstance.xdr, "DripPool WASM Code");
  }
  const vaultInstance = queryResult.entries.get(vaultInstanceKeyB64);
  if (vaultInstance && config.vaultId) {
    processInstanceWasm(config.vaultId, vaultInstance.xdr, "Vault WASM Code");
  }

  // Query contract code ledger entries if WASM hashes found
  let codeQueryResult = { latestLedger: queryResult.latestLedger, entries: new Map<string, any>() };
  if (codeKeysToQuery.length > 0) {
    codeQueryResult = await queryLedgerEntries(config.rpcUrl, codeKeysToQuery);
  }

  // Combine query maps
  const combinedLatestLedger = Math.max(queryResult.latestLedger, codeQueryResult.latestLedger);

  // 4. Evaluate TTL and flags
  const checkTTL = (
    contractId: string,
    type: ReportEntry["type"],
    label: string,
    keyB64: string,
    isCode = false
  ) => {
    const entry = isCode ? codeQueryResult.entries.get(keyB64) : queryResult.entries.get(keyB64);
    const durability: ReportEntry["durability"] = type === "Instance" || isCode ? "Instance" : "Persistent";

    if (!entry) {
      reports.push({
        contract: contractId,
        type,
        keyLabel: label,
        durability,
        liveUntilLedgerSeq: 0,
        remainingLedgers: 0,
        approxTimeLeft: "N/A",
        status: "NOT_FOUND",
      });
      return;
    }

    const remaining = entry.liveUntilLedgerSeq - combinedLatestLedger;
    let threshold = args.thresholdPersistent;
    if (type === "Instance") threshold = args.thresholdInstance;
    else if (type === "WASM Code") threshold = args.thresholdCode;

    let status: ReportEntry["status"] = "OK";
    if (remaining <= 0) status = "CRITICAL";
    else if (remaining < threshold / 10) status = "CRITICAL";
    else if (remaining < threshold) status = "WARNING";

    reports.push({
      contract: contractId,
      type,
      keyLabel: label,
      durability,
      liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      remainingLedgers: remaining,
      approxTimeLeft: formatDuration(remaining),
      status,
    });
  };

  // Inspect standard entries
  for (const [b64, details] of keyMap.entries()) {
    checkTTL(details.contract, details.type, details.label, b64);
  }

  // Inspect code entries
  for (const [b64, details] of codeKeyMap.entries()) {
    checkTTL(details.contract, "WASM Code", details.label, b64, true);
  }

  // 5. Output Report
  if (args.json) {
    console.log(JSON.stringify({
      latestLedger: combinedLatestLedger,
      timestamp: new Date().toISOString(),
      entries: reports,
    }, null, 2));
  } else {
    // Format human-readable ASCII table
    console.log(`\n${"-".repeat(110)}`);
    console.log(`SOROBAN STORAGE TTL REPORT | Current Ledger: ${combinedLatestLedger}`);
    console.log("-".repeat(110));
    console.log(
      `${"Key Entry / Label".padEnd(45)} | ${"Type".padEnd(20)} | ${"Durability".padEnd(10)} | ${"Remaining".padEnd(12)} | ${"Time Left".padEnd(10)} | ${"Status"}`
    );
    console.log("-".repeat(110));

    let warningsCount = 0;
    let criticalCount = 0;

    for (const r of reports) {
      let statusStr = r.status as string;
      // ANSI escape codes for coloring console output
      if (r.status === "CRITICAL") {
        statusStr = `\x1b[31m\x1b[1mCRITICAL\x1b[0m`;
        criticalCount++;
      } else if (r.status === "WARNING") {
        statusStr = `\x1b[33m\x1b[1mWARNING\x1b[0m`;
        warningsCount++;
      } else if (r.status === "OK") {
        statusStr = `\x1b[32mOK\x1b[0m`;
      } else if (r.status === "NOT_FOUND") {
        statusStr = `\x1b[90mNOT_FOUND\x1b[0m`;
      }

      console.log(
        `${r.keyLabel.padEnd(45)} | ${r.type.padEnd(20)} | ${r.durability.padEnd(10)} | ${String(r.remainingLedgers).padEnd(12)} | ${r.approxTimeLeft.padEnd(10)} | ${statusStr}`
      );
    }

    console.log("-".repeat(110));
    console.log(`Summary: ${reports.length} checked, \x1b[31m${criticalCount} critical\x1b[0m, \x1b[33m${warningsCount} warnings\x1b[0m.\n`);

    if (criticalCount > 0) {
      console.log("\x1b[31m\x1b[1mWARNING: Critical storage entries are nearing expiration. Perform immediate renewal actions!\x1b[0m\n");
      process.exit(1);
    }
  }
}

run().catch((err) => {
  console.error("Fatal Error running TTL check script:", err.message);
  process.exit(1);
});
