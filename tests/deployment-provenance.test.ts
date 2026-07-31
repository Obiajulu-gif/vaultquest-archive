import { describe, it, expect } from "vitest";
import {
  DeploymentManifestEntrySchema,
  ProvenanceManifestSchema,
  parseProvenanceManifest,
  serializeProvenanceManifest,
  findEntry,
  verifyProvenance,
  verifyProvenanceForContract,
  ProvenanceManifestError,
  type DeploymentManifestEntry,
  type ProvenanceManifest,
} from "@/lib/deployment-provenance";

const VALID_ENTRY: DeploymentManifestEntry = {
  contractName: "drip-pool",
  contractId: "CDRYPPOOL1234567890ABCDEF",
  sourceCommit: "5227074540e24d3dbca0282008867be06487798a".slice(0, 40),
  wasmDigest: "918d0fbcc59843ba7a0fc2be66f249c68e0b118a841e742e52976cbd6f6d7579".slice(0, 64),
  specHash: "a4a19fb2620382d88056ee7f0de888187f4189c234e728e333b35f0101e078b9".slice(0, 64),
  cargoLockHash: "fe93fca0ad3ed7a92c89ae3ac98f93163a4e5f24e2e4a8e459c122cdc8039189".slice(0, 64),
  network: "testnet",
  timestamp: "2026-07-30T12:00:00Z",
};

const VALID_MANIFEST: ProvenanceManifest = {
  version: 1,
  entries: [VALID_ENTRY],
};

describe("DeploymentManifestEntrySchema", () => {
  it("accepts a valid entry", () => {
    expect(DeploymentManifestEntrySchema.safeParse(VALID_ENTRY).success).toBe(true);
  });

  it("accepts an entry without the optional contractId", () => {
    const { contractId, ...rest } = VALID_ENTRY;
    expect(DeploymentManifestEntrySchema.safeParse(rest).success).toBe(true);
  });

  it("rejects a missing wasmDigest", () => {
    const { wasmDigest, ...rest } = VALID_ENTRY;
    expect(DeploymentManifestEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing sourceCommit", () => {
    const { sourceCommit, ...rest } = VALID_ENTRY;
    expect(DeploymentManifestEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing specHash", () => {
    const { specHash, ...rest } = VALID_ENTRY;
    expect(DeploymentManifestEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing cargoLockHash", () => {
    const { cargoLockHash, ...rest } = VALID_ENTRY;
    expect(DeploymentManifestEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing network", () => {
    const { network, ...rest } = VALID_ENTRY;
    expect(DeploymentManifestEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a missing timestamp", () => {
    const { timestamp, ...rest } = VALID_ENTRY;
    expect(DeploymentManifestEntrySchema.safeParse(rest).success).toBe(false);
  });

  it("rejects a non-hex wasmDigest", () => {
    const result = DeploymentManifestEntrySchema.safeParse({
      ...VALID_ENTRY,
      wasmDigest: "not-a-digest",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an uppercase wasmDigest (must be lowercase hex)", () => {
    const result = DeploymentManifestEntrySchema.safeParse({
      ...VALID_ENTRY,
      wasmDigest: VALID_ENTRY.wasmDigest.toUpperCase(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a wasmDigest of the wrong length", () => {
    const result = DeploymentManifestEntrySchema.safeParse({
      ...VALID_ENTRY,
      wasmDigest: "abc123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid network value", () => {
    const result = DeploymentManifestEntrySchema.safeParse({
      ...VALID_ENTRY,
      network: "devnet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    const result = DeploymentManifestEntrySchema.safeParse({
      ...VALID_ENTRY,
      timestamp: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

describe("ProvenanceManifestSchema", () => {
  it("accepts a valid manifest with entries", () => {
    expect(ProvenanceManifestSchema.safeParse(VALID_MANIFEST).success).toBe(true);
  });

  it("accepts a manifest with an empty entries array", () => {
    expect(ProvenanceManifestSchema.safeParse({ version: 1, entries: [] }).success).toBe(true);
  });

  it("rejects a manifest with a bad version", () => {
    expect(
      ProvenanceManifestSchema.safeParse({ ...VALID_MANIFEST, version: 2 }).success
    ).toBe(false);
  });

  it("rejects a manifest where one entry is malformed", () => {
    const result = ProvenanceManifestSchema.safeParse({
      version: 1,
      entries: [VALID_ENTRY, { ...VALID_ENTRY, wasmDigest: "bad" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("parseProvenanceManifest / serializeProvenanceManifest", () => {
  it("round-trips a valid manifest through serialize -> parse", () => {
    const serialized = serializeProvenanceManifest(VALID_MANIFEST);
    const parsed = parseProvenanceManifest(serialized);
    expect(parsed).toEqual(VALID_MANIFEST);
  });

  it("serialized output ends with a trailing newline", () => {
    const serialized = serializeProvenanceManifest(VALID_MANIFEST);
    expect(serialized.endsWith("\n")).toBe(true);
  });

  it("throws ProvenanceManifestError on invalid JSON", () => {
    expect(() => parseProvenanceManifest("{ not json")).toThrow(ProvenanceManifestError);
  });

  it("throws ProvenanceManifestError on JSON that fails schema validation", () => {
    expect(() => parseProvenanceManifest(JSON.stringify({ version: 1, entries: [{}] }))).toThrow(
      ProvenanceManifestError
    );
  });

  it("error message names the failing field", () => {
    try {
      parseProvenanceManifest(JSON.stringify({ version: 1, entries: [{}] }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProvenanceManifestError);
      expect((err as Error).message).toMatch(/wasmDigest/);
    }
  });
});

describe("findEntry", () => {
  it("finds an entry by contract name", () => {
    expect(findEntry(VALID_MANIFEST, "drip-pool")).toEqual(VALID_ENTRY);
  });

  it("returns undefined for an unknown contract name", () => {
    expect(findEntry(VALID_MANIFEST, "does-not-exist")).toBeUndefined();
  });

  it("returns undefined on an empty manifest", () => {
    expect(findEntry({ version: 1, entries: [] }, "drip-pool")).toBeUndefined();
  });
});

describe("verifyProvenance", () => {
  it("passes when the freshly-computed digest matches the manifest (valid match)", () => {
    const result = verifyProvenance(VALID_ENTRY, VALID_ENTRY.wasmDigest);
    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("passes when the fresh digest differs only in case (normalizes to lowercase)", () => {
    const result = verifyProvenance(VALID_ENTRY, VALID_ENTRY.wasmDigest.toUpperCase());
    expect(result.verified).toBe(true);
  });

  it("passes when the fresh digest has surrounding whitespace (e.g. raw sha256sum output)", () => {
    const result = verifyProvenance(VALID_ENTRY, `  ${VALID_ENTRY.wasmDigest}  \n`);
    expect(result.verified).toBe(true);
  });

  it("rejects a tampered/wrong digest (mismatch)", () => {
    const tampered = "0".repeat(64);
    const result = verifyProvenance(VALID_ENTRY, tampered);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/mismatch/);
    expect(result.reason).toContain(VALID_ENTRY.wasmDigest);
    expect(result.reason).toContain(tampered);
  });

  it("rejects an empty freshWasmDigest", () => {
    const result = verifyProvenance(VALID_ENTRY, "");
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it("rejects a freshWasmDigest that is not well-formed hex", () => {
    const result = verifyProvenance(VALID_ENTRY, "not-a-real-digest");
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/not a well-formed/);
  });

  it("rejects a freshWasmDigest of the wrong length", () => {
    const result = verifyProvenance(VALID_ENTRY, "abc123");
    expect(result.verified).toBe(false);
  });

  it("a single flipped character in the digest is rejected (sensitivity to tampering)", () => {
    const almostRight = VALID_ENTRY.wasmDigest.slice(0, -1) + (VALID_ENTRY.wasmDigest.endsWith("a") ? "b" : "a");
    const result = verifyProvenance(VALID_ENTRY, almostRight);
    expect(result.verified).toBe(false);
  });
});

describe("verifyProvenanceForContract", () => {
  it("verifies against the correct entry looked up by contract name", () => {
    const result = verifyProvenanceForContract(VALID_MANIFEST, "drip-pool", VALID_ENTRY.wasmDigest);
    expect(result.verified).toBe(true);
  });

  it("fails closed when the contract has no provenance entry at all (missing fields scenario)", () => {
    const result = verifyProvenanceForContract(VALID_MANIFEST, "unknown-contract", VALID_ENTRY.wasmDigest);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/no provenance entry/);
  });

  it("fails when the manifest has no entries", () => {
    const empty: ProvenanceManifest = { version: 1, entries: [] };
    const result = verifyProvenanceForContract(empty, "drip-pool", VALID_ENTRY.wasmDigest);
    expect(result.verified).toBe(false);
  });

  it("rejects a tampered digest even when the contract is found", () => {
    const result = verifyProvenanceForContract(VALID_MANIFEST, "drip-pool", "f".repeat(64));
    expect(result.verified).toBe(false);
  });
});
