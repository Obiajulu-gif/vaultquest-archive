"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPRECATED_CONTRACT_SPEC_HASHES = exports.DeploymentManifestSchema = void 0;
exports.assertContractSpecNotDeprecated = assertContractSpecNotDeprecated;
exports.loadManifest = loadManifest;
exports.loadManifestAsync = loadManifestAsync;
exports.clearManifestCache = clearManifestCache;
exports.validateManifestAgainstEnv = validateManifestAgainstEnv;
exports.validateManifestGovernance = validateManifestGovernance;
exports.assertGovernanceValid = assertGovernanceValid;
const zod_1 = require("zod");
const NetworkSchema = zod_1.z.object({
    passphrase: zod_1.z.string().min(1),
    name: zod_1.z.enum(["testnet", "mainnet", "futurenet", "standalone", "custom"]),
    sorobanRpcUrl: zod_1.z.string().url(),
    horizonUrl: zod_1.z.string().url(),
});
const ContractEntrySchema = zod_1.z.object({
    contractId: zod_1.z.string().min(1),
    specHash: zod_1.z.string().optional(),
});
const EvmContractSchema = zod_1.z.object({
    address: zod_1.z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid EVM address"),
    chainId: zod_1.z.number().int().positive(),
});
const ContractsSchema = zod_1.z.object({
    dripPool: ContractEntrySchema,
    escrow: ContractEntrySchema.optional(),
    evm: EvmContractSchema.optional(),
});
const BuildSchema = zod_1.z.object({
    commitSha: zod_1.z.string().min(1),
    buildTimestamp: zod_1.z.string().datetime(),
    contractWasmHash: zod_1.z.string().optional(),
});
/**
 * Governance section added in #632: records who can upgrade, pause, or
 * administer each deployed contract so validation scripts can fail loudly on
 * unexpected authority changes.
 */
const GovernanceSchema = zod_1.z.object({
    /**
     * Minimum number of signers required to authorise an upgrade or admin
     * operation. Must be >= 1; if > 1 this implies a multisig scheme.
     */
    signerThreshold: zod_1.z.number().int().min(1),
    /**
     * Stellar account (or C… contract) that holds admin authority — can call
     * admin-only entry points (e.g. `set_admin`, `set_fee`).
     */
    adminAuthority: zod_1.z.string().min(1),
    /**
     * Stellar account (or C… contract) authorised to upgrade the WASM bytecode.
     * Separation from adminAuthority mirrors the Soroban authority model where
     * upgrade capability is distinct from run-time administration.
     */
    upgradeAuthority: zod_1.z.string().min(1),
    /**
     * Optional: account authorised to invoke emergency pause. Defaults to
     * adminAuthority if absent; recorded here for operational transparency.
     */
    pauseAuthority: zod_1.z.string().min(1).optional(),
});
exports.DeploymentManifestSchema = zod_1.z.object({
    version: zod_1.z.string().regex(/^\d+\.\d+\.\d+$/, "Must be semver"),
    environment: zod_1.z.enum(["staging", "production"]),
    network: NetworkSchema,
    contracts: ContractsSchema,
    assets: zod_1.z.array(zod_1.z.record(zod_1.z.string())).default([]),
    build: BuildSchema,
    /** Governance/authority metadata — required for mainnet, optional for staging. */
    governance: GovernanceSchema.optional(),
    signature: zod_1.z.string().optional(),
});
/**
 * Spec hashes for contracts that have been superseded and must never be
 * accepted, even if still deployed on-chain (#495 — contracts/vault and any
 * other retired drip-pool build). Populate as legacy spec hashes are confirmed.
 */
exports.DEPRECATED_CONTRACT_SPEC_HASHES = new Set([]);
/** Throws when the manifest's contract spec has been superseded (#495). */
function assertContractSpecNotDeprecated(manifest) {
    const specHash = manifest.contracts.dripPool.specHash;
    if (specHash && exports.DEPRECATED_CONTRACT_SPEC_HASHES.has(specHash)) {
        throw new Error(`Deployment manifest references a deprecated contract spec (${specHash}). ` +
            `contracts/drip-pool is the sole authoritative contract; see contracts/CONTRACT_BOUNDARY.md`);
    }
}
let _cached = null;
function validateAndCache(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error("Deployment manifest is not valid JSON");
    }
    if (parsed && parsed.contracts) {
        if (parsed.contracts.escrow && !parsed.contracts.escrow.contractId) {
            delete parsed.contracts.escrow;
        }
    }
    const result = exports.DeploymentManifestSchema.safeParse(parsed);
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
function isServer() {
    return typeof window === "undefined";
}
function resolveManifestDefault() {
    if (isServer()) {
        const { resolve } = require("path");
        const isBackend = process.cwd().includes("backend") || process.env.BACKEND === "1";
        if (isBackend) {
            return resolve(process.cwd(), "..", "deployment-manifest.json");
        }
        return resolve(process.cwd(), "deployment-manifest.json");
    }
    return "/deployment-manifest.json";
}
function loadManifest(manifestPath) {
    if (_cached)
        return _cached;
    if (isServer()) {
        const { readFileSync } = require("fs");
        const { resolve } = require("path");
        const envPath = process.env.DEPLOYMENT_MANIFEST_PATH;
        const filePath = manifestPath || envPath || resolveManifestDefault();
        let raw;
        try {
            raw = readFileSync(filePath, "utf-8");
        }
        catch (err) {
            throw new Error(`Deployment manifest not found at ${filePath}. ` +
                `Set DEPLOYMENT_MANIFEST_PATH or ensure the file exists. ` +
                `Original error: ${err instanceof Error ? err.message : err}`);
        }
        return validateAndCache(raw);
    }
    throw new Error("loadManifest() cannot be called synchronously on the client. " +
        "Use loadManifestAsync() instead.");
}
async function loadManifestAsync(manifestPath) {
    if (_cached)
        return _cached;
    const url = manifestPath || resolveManifestDefault();
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to fetch deployment manifest from ${url}: ${resp.status}`);
    }
    const raw = await resp.text();
    return validateAndCache(raw);
}
function clearManifestCache() {
    _cached = null;
}
const ENV_FIELD_MAP = {
    "network.passphrase": "NEXT_PUBLIC_SOROBAN_NETWORK_PASSPHRASE",
    "network.sorobanRpcUrl": "NEXT_PUBLIC_SOROBAN_RPC_URL",
    "network.horizonUrl": "NEXT_PUBLIC_HORIZON_URL",
    "contracts.dripPool.contractId": "NEXT_PUBLIC_DRIP_POOL_CONTRACT_ID",
    "contracts.escrow.contractId": "NEXT_PUBLIC_TRUSTLESS_WORK_ESCROW_CONTRACT_ID",
};
function getNestedValue(obj, path) {
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
function validateManifestAgainstEnv(manifest, env = typeof process !== "undefined" ? process.env : {}) {
    const mismatches = [];
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
const GOVERNANCE_ENV_MAP = {
    adminAuthority: "EXPECTED_ADMIN_AUTHORITY",
    upgradeAuthority: "EXPECTED_UPGRADE_AUTHORITY",
    pauseAuthority: "EXPECTED_PAUSE_AUTHORITY",
};
/**
 * Validates the manifest's governance block against expected authorities from
 * environment variables (#632).  Returns violations found; an empty array means
 * all checked fields match.  Throws when the manifest is mainnet but has no
 * governance block, since authority tracking is mandatory for production.
 */
function validateManifestGovernance(manifest, env = typeof process !== "undefined" ? process.env : {}) {
    if (!manifest.governance) {
        if (manifest.network.name === "mainnet") {
            throw new Error("Governance block is required for mainnet deployments but is absent from the manifest.");
        }
        return [];
    }
    const gov = manifest.governance;
    const violations = [];
    // Check each authority field against its expected env var.
    for (const [field, envKey] of Object.entries(GOVERNANCE_ENV_MAP)) {
        const manifestValue = gov[field];
        const expectedValue = env[envKey];
        if (!expectedValue || !manifestValue)
            continue;
        if (manifestValue !== expectedValue) {
            violations.push({
                field: `governance.${field}`,
                manifestValue,
                expectedValue,
                reason: `${field} does not match ${envKey}`,
            });
        }
    }
    // Signer threshold from env
    const expectedThresholdRaw = env["EXPECTED_SIGNER_THRESHOLD"];
    if (expectedThresholdRaw) {
        const expected = Number(expectedThresholdRaw);
        if (Number.isInteger(expected) && gov.signerThreshold !== expected) {
            violations.push({
                field: "governance.signerThreshold",
                manifestValue: String(gov.signerThreshold),
                expectedValue: expectedThresholdRaw,
                reason: `signerThreshold does not match EXPECTED_SIGNER_THRESHOLD`,
            });
        }
    }
    return violations;
}
/**
 * Throws if governance validation finds any violations.  Convenience wrapper
 * for use in CI/deploy scripts where failure should be fatal.
 */
function assertGovernanceValid(manifest, env) {
    const violations = validateManifestGovernance(manifest, env);
    if (violations.length > 0) {
        const details = violations
            .map((v) => `  ${v.field}: manifest="${v.manifestValue}" expected="${v.expectedValue}" (${v.reason})`)
            .join("\n");
        throw new Error(`Governance authority validation failed:\n${details}`);
    }
}
//# sourceMappingURL=deployment-manifest.js.map