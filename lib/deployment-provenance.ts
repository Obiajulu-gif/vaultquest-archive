/**
 * Contract artifact provenance (#511).
 *
 * Scaled-down slice of the full signed-provenance proposal on #511: this
 * module records and verifies a per-contract deployment fingerprint (source
 * commit, wasm digest, spec hash, lockfile hash, network, timestamp) and
 * exposes a pure `verifyProvenance()` check that rejects a tampered/wrong
 * wasm digest. It deliberately does NOT do Sigstore/cosign keyless signing,
 * SBOM generation, or any network/Rekor call — see the "Deferred" section in
 * `docs/DEPLOYMENT_PROVENANCE.md` for why, and what a follow-up PR would add.
 *
 * This is additive and independent of `lib/deployment-manifest.ts`'s
 * `DeploymentManifestSchema` (which governs network/contract-id config the
 * frontend reads at runtime) — nothing here changes that schema or its
 * existing consumers.
 */

import { z } from "zod";

// ─── Schema ─────────────────────────────────────────────────────────────────

/**
 * A lowercase, unprefixed hex-encoded SHA-256 digest (64 hex chars). Matches
 * the output of `sha256sum file.wasm | cut -d' ' -f1`, which is the exact
 * command documented in DEPLOYMENT_PROVENANCE.md for local verification.
 */
const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Must be a 64-character lowercase hex SHA-256 digest");

/** A git commit SHA — full (40 hex) or short (>=7 hex), matching `git rev-parse` output. */
const CommitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, "Must be a hex git commit SHA (7-40 chars)");

export const ProvenanceNetworkSchema = z.enum([
  "testnet",
  "mainnet",
  "futurenet",
  "standalone",
]);

/**
 * One contract's recorded provenance: everything needed to independently
 * reproduce and verify that a deployed wasm binary corresponds to a specific
 * source commit, with no maintainer-held secret required to check it.
 */
export const DeploymentManifestEntrySchema = z.object({
  /** Logical contract name, e.g. "drip-pool". Matches the crate/package name. */
  contractName: z.string().min(1),
  /** Deployed contract id (Stellar C... address), if known at record time. */
  contractId: z.string().min(1).optional(),
  /** Git commit the wasm was built from. */
  sourceCommit: CommitShaSchema,
  /** sha256 of the built .wasm artifact, lowercase hex, no "sha256:" prefix. */
  wasmDigest: Sha256HexSchema,
  /** sha256 of the contract's exported spec (XDR) — detects ABI drift even
   *  when the wasm digest check is skipped or unavailable. */
  specHash: Sha256HexSchema,
  /** sha256 of Cargo.lock at build time — detects a dependency-only rebuild
   *  producing a different wasm than what was reviewed. */
  cargoLockHash: Sha256HexSchema,
  network: ProvenanceNetworkSchema,
  /** ISO-8601 build/record timestamp. */
  timestamp: z.string().datetime(),
});

export type DeploymentManifestEntry = z.infer<typeof DeploymentManifestEntrySchema>;

/** The full provenance manifest: one entry per deployed contract. */
export const ProvenanceManifestSchema = z.object({
  version: z.literal(1),
  entries: z.array(DeploymentManifestEntrySchema),
});

export type ProvenanceManifest = z.infer<typeof ProvenanceManifestSchema>;

// ─── Parsing / validation ────────────────────────────────────────────────────

export class ProvenanceManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceManifestError";
  }
}

/** Parses and validates a raw provenance manifest. Throws on malformed input. */
export function parseProvenanceManifest(raw: string): ProvenanceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProvenanceManifestError("Provenance manifest is not valid JSON");
  }

  const result = ProvenanceManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ProvenanceManifestError(`Invalid provenance manifest: ${issues}`);
  }
  return result.data;
}

/** Serializes a provenance manifest deterministically (stable key order, trailing newline). */
export function serializeProvenanceManifest(manifest: ProvenanceManifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** Finds a single contract's entry by name, or `undefined` if absent. */
export function findEntry(
  manifest: ProvenanceManifest,
  contractName: string
): DeploymentManifestEntry | undefined {
  return manifest.entries.find((e) => e.contractName === contractName);
}

// ─── Verification ─────────────────────────────────────────────────────────────

export interface ProvenanceVerificationResult {
  verified: boolean;
  /** Populated when `verified` is false; explains exactly which check failed. */
  reason?: string;
}

/**
 * Pure comparison: does a freshly-computed wasm digest match what the
 * manifest recorded for this contract? No network, no Sigstore/Rekor call —
 * this is the self-contained slice of #511's provenance proposal. Digest
 * comparison is case-insensitive on input but the manifest itself must
 * already be lowercase hex (enforced by the schema).
 */
export function verifyProvenance(
  entry: DeploymentManifestEntry,
  freshWasmDigest: string
): ProvenanceVerificationResult {
  if (!freshWasmDigest || freshWasmDigest.trim().length === 0) {
    return { verified: false, reason: "freshWasmDigest is empty" };
  }

  const normalized = freshWasmDigest.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    return {
      verified: false,
      reason: `freshWasmDigest is not a well-formed sha256 hex digest: "${freshWasmDigest}"`,
    };
  }

  if (normalized !== entry.wasmDigest) {
    return {
      verified: false,
      reason: `wasm digest mismatch: manifest has ${entry.wasmDigest}, computed ${normalized}`,
    };
  }

  return { verified: true };
}

/**
 * Convenience wrapper: looks up the entry by contract name first, then
 * verifies. Returns a failure result (never throws) when the contract has no
 * recorded provenance entry at all, so callers can fail closed uniformly.
 */
export function verifyProvenanceForContract(
  manifest: ProvenanceManifest,
  contractName: string,
  freshWasmDigest: string
): ProvenanceVerificationResult {
  const entry = findEntry(manifest, contractName);
  if (!entry) {
    return {
      verified: false,
      reason: `no provenance entry found for contract "${contractName}"`,
    };
  }
  return verifyProvenance(entry, freshWasmDigest);
}
