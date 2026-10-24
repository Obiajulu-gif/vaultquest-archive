import crypto from "crypto";
import type { PrismaClient } from "@prisma/client";

export interface ReleaseAttestation {
  wasmHash: string;
  sbomHash: string;
  checksumSignature: string;
  sourceRevision: string;
  networkId: string;
  adminId: string;
  contractIds: string[];
  timestamp: Date;
  toolchainVersion: string;
}

/**
 * Canonical payload representation for attestation signing/verification.
 *
 * The signed payload must be deterministic regardless of input ordering,
 * whitespace, casing, or numeric precision. We normalize the fields and
 * serialize with a stable key order so equivalent payloads produce the
 * same bytes. Legacy records that were signed with the old JSON.stringify
 * shape are still verifiable through a compatibility path.
 */

export interface CanonicalAttestationPayload {
  wasmHash: string;
  sbomHash: string;
  sourceRevision: string;
  networkId: string;
  contractIds: string[];
  timestamp: string;
}

export interface CreateAttestationInput {
  wasmBuffer: Buffer;
  sbomContent: string;
  sourceRevision: string;
  networkId: string;
  adminId: string;
  contractIds: string[];
  toolchainVersion: string;
  signingKey: Buffer;
  timestamp?: Date | string;
}

export class AttestationService {
  constructor(private readonly prisma: PrismaClient) {}

  generateHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  /**
   * Normalize a timestamp to a canonical ISO 8591 string with millisecond
   * precision and UTC offset. Accepts Date objects, epoch numbers, and
   * ISO strings (including legacy values without milliseconds or with a
   * non-UTC offset).
   */
  private normalizeTimestamp(value: Date | string | number): string {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid timestamp: ${String(value)}`);
    }
    return date.toISOString();
  }

  /**
   * Normalize a hash string: trim, lowercase, and validate hex encoding.
   */
  private normalizeHash(value: string, field: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized || !/^[0-9a-f]+$/.test(normalized)) {
      throw new Error(`Invalid ${field}: expected a hex string.`);
    }
    return normalized;
  }

  /**
   * Normalize a generic string field: trim and reject empty values.
   */
  private normalizeString(value: string, field: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`${field} must be a non-empty string.`);
    }
    return normalized;
  }

  /**
   * Normalize contract IDs: trim, deduplicate, and sort lexicographically.
   */
  private normalizeContractIds(contractIds: string[]): string[] {
    if (!Array.isArray(contractIds)) {
      throw new Error("contractIds must be an array of strings.");
    }
    const normalized = contractIds.map((id) => {
      if (typeof id !== "string") {
        throw new Error("contractIds must contain only strings.");
      }
      const trimmed = id.trim();
      if (!trimmed) {
        throw new Error("contractIds must not contain empty values.");
      }
      return trimmed;
    });
    return Array.from(new Set(normalized)).sort();
  }

  /**
   * Build the canonical payload object from attestation fields.
   */
  buildCanonicalPayload(input: {
    wasmHash: string;
    sbomHash: string;
    sourceRevision: string;
    networkId: string;
    contractIds: string[];
    timestamp: Date | string | number;
  }): CanonicalAttestationPayload {
    return {
      wasmHash: this.normalizeHash(input.wasmHash, "wasmHash"),
      sbomHash: this.normalizeHash(input.sbomHash, "sbomHash"),
      sourceRevision: this.normalizeString(input.sourceRevision, "sourceRevision"),
      networkId: this.normalizeString(input.networkId, "networkId"),
      contractIds: this.normalizeContractIds(input.contractIds),
      timestamp: this.normalizeTimestamp(input.timestamp)
    };
  }

  /**
   * Serialize a canonical payload with a stable key order. This is the
   * byte representation that is signed and verified.
   */
  serializeCanonicalPayload(payload: CanonicalAttestationPayload): string {
    const ordered = {
      contractIds: payload.contractIds,
      networkId: payload.networkId,
      sbomHash: payload.sbomHash,
      sourceRevision: payload.sourceRevision,
      timestamp: payload.timestamp,
      wasmHash: payload.wasmHash
    };
    return JSON.stringify(ordered);
  }

  /**
   * Legacy serialization format used by previous releases. Kept for
   * compatibility when verifying attestations that were signed before
   * canonical serialization was introduced.
   */
  buildLegacyPayload(input: {
    wasmHash: string;
    sbomHash: string;
    sourceRevision: string;
    networkId: string;
    contractIds: string[];
    timestamp: Date | string;
  }): string {
    const timestamp =
      typeof input.timestamp === "string"
        ? new Date(input.timestamp).toISOString()
        : input.timestamp.toISOString();
    return JSON.stringify({
      wasmHash: input.wasmHash,
      sbomHash: input.sbomHash,
      sourceRevision: input.sourceRevision,
      networkId: input.networkId,
      contractIds: [...input.contractIds].sort(),
      timestamp
    });
  }

  async createAttestation(input: CreateAttestationInput): Promise<ReleaseAttestation> {
    const wasmHash = this.generateHash(input.wasmBuffer);
    const sbomHash = this.generateHash(input.sbomContent);
    const timestamp = input.timestamp ? new Date(input.timestamp) : new Date();

    const payload = this.buildCanonicalPayload({
      wasmHash,
      sbomHash,
      sourceRevision: input.sourceRevision,
      networkId: input.networkId,
      contractIds: input.contractIds,
      timestamp
    });

    const checksumData = this.serializeCanonicalPayload(payload);

    const checksumSignature = crypto
      .createSign("sha256")
      .update(checksumData)
      .sign(input.signingKey, "hex");

    const attestation: ReleaseAttestation = {
      wasmHash,
      sbomHash,
      checksumSignature,
      sourceRevision: payload.sourceRevision,
      networkId: payload.networkId,
      adminId: input.adminId,
      contractIds: payload.contractIds,
      timestamp,
      toolchainVersion: input.toolchainVersion
    };

    await this.prisma.releaseAttestation.create({
      data: {
        wasmHash,
        sbomHash,
        checksumSignature,
        sourceRevision: attestation.sourceRevision,
        networkId: attestation.networkId,
        adminId: attestation.adminId,
        contractIds: attestation.contractIds,
        timestamp: attestation.timestamp,
        toolchainVersion: attestation.toolchainVersion
      }
    });

    return attestation;
  }

  async verifyAttestation(attestation: ReleaseAttestation, publicKey: Buffer): Promise<boolean> {
    const payload = this.buildCanonicalPayload({
      wasmHash: attestation.wasmHash,
      sbomHash: attestation.sbomHash,
      sourceRevision: attestation.sourceRevision,
      networkId: attestation.networkId,
      contractIds: attestation.contractIds,
      timestamp: attestation.timestamp
    });

    const canonicalData = this.serializeCanonicalPayload(payload);
    const canonicalValid = this.verifySignature(canonicalData, attestation.checksumSignature, publicKey);
    if (canonicalValid) {
      return true;
    }

    // Compatibility path for legacy attestations signed with the old format.
    const legacyData = this.buildLegacyPayload({
      wasmHash: attestation.wasmHash,
      sbomHash: attestation.sbomHash,
      sourceRevision: attestation.sourceRevision,
      networkId: attestation.networkId,
      contractIds: attestation.contractIds,
      timestamp: attestation.timestamp
    });
    return this.verifySignature(legacyData, attestation.checksumSignature, publicKey);
  }

  private verifySignature(data: string, signature: string, publicKey: Buffer): boolean {
    try {
      return crypto
        .createVerify("sha256")
        .update(data)
        .verify(publicKey, signature, "hex");
    } catch {
      return false;
    }
  }

  async getAttestation(wasmHash: string): Promise<ReleaseAttestation | null> {
    const normalizedWasmHash = this.normalizeHash(wasmHash, "wasmHash");
    const row = await this.prisma.releaseAttestation.findUnique({
      where: { wasmHash: normalizedWasmHash }
    });

    if (!row) return null;

    return {
      wasmHash: row.wasmHash,
      sbomHash: row.sbomHash,
      checksumSignature: row.checksumSignature,
      sourceRevision: row.sourceRevision,
      networkId: row.networkId,
      adminId: row.adminId,
      contractIds: row.contractIds,
      timestamp: row.timestamp,
      toolchainVersion: row.toolchainVersion
    };
  }
}
