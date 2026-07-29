import { z } from "zod";

const NetworkSchema = z.object({
  passphrase: z.string().min(1),
  name: z.enum(["testnet", "mainnet", "futurenet", "standalone", "custom"]),
  sorobanRpcUrl: z.string().url(),
  horizonUrl: z.string().url(),
});

const ContractEntrySchema = z.object({
  contractId: z.string().min(1),
  specHash: z.string().optional(),
});

const EvmContractSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address"),
  chainId: z.number().int().positive(),
});

const ContractsSchema = z.object({
  dripPool: ContractEntrySchema,
  escrow: ContractEntrySchema.optional(),
  evm: EvmContractSchema.optional(),
});

const BuildSchema = z.object({
  commitSha: z.string().min(1),
  buildTimestamp: z.string().datetime(),
  contractWasmHash: z.string().optional(),
});

export const DeploymentManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver"),
  environment: z.enum(["staging", "production"]),
  network: NetworkSchema,
  contracts: ContractsSchema,
  assets: z.array(z.record(z.string())).default([]),
  build: BuildSchema,
  signature: z.string().optional(),
});

export type DeploymentManifest = z.infer<typeof DeploymentManifestSchema>;
export type NetworkConfig = z.infer<typeof NetworkSchema>;

export interface ManifestMismatch {
  field: string;
  manifestValue: string;
  envValue: string;
}

/**
 * Spec hashes for contracts that have been superseded and must never be
 * accepted, even if still deployed on-chain (#495 — contracts/vault and any
 * other retired drip-pool build). Populate as legacy spec hashes are confirmed.
 */
export const DEPRECATED_CONTRACT_SPEC_HASHES: ReadonlySet<string> = new Set([]);

/** Throws when the manifest's contract spec has been superseded (#495). */
export function assertContractSpecNotDeprecated(manifest: DeploymentManifest): void {
  const specHash = manifest.contracts.dripPool.specHash;
  if (specHash && DEPRECATED_CONTRACT_SPEC_HASHES.has(specHash)) {
    throw new Error(
      `Deployment manifest references a deprecated contract spec (${specHash}). ` +
        `contracts/drip-pool is the sole authoritative contract; see contracts/CONTRACT_BOUNDARY.md`
    );
  }
}

let _cached: DeploymentManifest | null = null;

function validateAndCache(raw: string): DeploymentManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Deployment manifest is not valid JSON");
  }

  const result = DeploymentManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid deployment manifest: ${issues}`);
  }

  assertContractSpecNotDeprecated(result.data);

  _cached = result.data;
  return _cached;
}

function isServer(): boolean {
  return typeof window === "undefined";
}

function resolveManifestDefault(): string {
  if (isServer()) {
    const { resolve } = require("path");
    const isBackend =
      process.cwd().includes("backend") || process.env.BACKEND === "1";
    if (isBackend) {
      return resolve(process.cwd(), "..", "deployment-manifest.json");
    }
    return resolve(process.cwd(), "deployment-manifest.json");
  }
  return "/deployment-manifest.json";
}

export function loadManifest(manifestPath?: string): DeploymentManifest {
  if (_cached) return _cached;

  if (isServer()) {
    const { readFileSync } = require("fs");
    const { resolve } = require("path");
    const envPath = process.env.DEPLOYMENT_MANIFEST_PATH;
    const filePath = manifestPath || envPath || resolveManifestDefault();

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(
        `Deployment manifest not found at ${filePath}. ` +
          `Set DEPLOYMENT_MANIFEST_PATH or ensure the file exists. ` +
          `Original error: ${err instanceof Error ? err.message : err}`
      );
    }
    return validateAndCache(raw);
  }

  throw new Error(
    "loadManifest() cannot be called synchronously on the client. " +
      "Use loadManifestAsync() instead."
  );
}

export async function loadManifestAsync(
  manifestPath?: string
): Promise<DeploymentManifest> {
  if (_cached) return _cached;

  const url = manifestPath || resolveManifestDefault();
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Failed to fetch deployment manifest from ${url}: ${resp.status}`
    );
  }
  const raw = await resp.text();
  return validateAndCache(raw);
}

export function clearManifestCache(): void {
  _cached = null;
}

const ENV_FIELD_MAP: Record<string, string> = {
  "network.passphrase": "NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE",
  "network.sorobanRpcUrl": "NEXT_PUBLIC_SOROBAN_RPC_URL",
  "network.horizonUrl": "NEXT_PUBLIC_HORIZON_URL",
  "contracts.dripPool.contractId": "NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID",
  "contracts.escrow.contractId": "NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID",
};

function getNestedValue(obj: unknown, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function validateManifestAgainstEnv(
  manifest: DeploymentManifest,
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}
): ManifestMismatch[] {
  const mismatches: ManifestMismatch[] = [];

  for (const [field, envKey] of Object.entries(ENV_FIELD_MAP)) {
    const manifestValue = getNestedValue(manifest, field);
    const envValue = env[envKey];

    if (manifestValue && envValue && manifestValue !== envValue) {
      mismatches.push({ field, manifestValue, envValue });
    }
  }

  if (manifest.network.name === "mainnet") {
    const nodeEnv = env.NODE_ENV || "production";
    if (nodeEnv !== "production") {
      mismatches.push({
        field: "network.environment_guard",
        manifestValue: "mainnet",
        envValue: nodeEnv,
      });
    }
  }

  return mismatches;
}
