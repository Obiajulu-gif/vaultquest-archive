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

export class AttestationService {
  constructor(private readonly prisma: PrismaClient) {}

  generateHash(content: string | Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  async createAttestation(input: {
    wasmBuffer: Buffer;
    sbomContent: string;
    sourceRevision: string;
    networkId: string;
    adminId: string;
    contractIds: string[];
    toolchainVersion: string;
    signingKey: Buffer;
  }): Promise<ReleaseAttestation> {
    const wasmHash = this.generateHash(input.wasmBuffer);
    const sbomHash = this.generateHash(input.sbomContent);

    const checksumData = JSON.stringify({
      wasmHash,
      sbomHash,
      sourceRevision: input.sourceRevision,
      networkId: input.networkId,
      contractIds: input.contractIds.sort(),
      timestamp: new Date().toISOString()
    });

    const checksumSignature = crypto
      .createSign("sha256")
      .update(checksumData)
      .sign(input.signingKey, "hex");

    const attestation: ReleaseAttestation = {
      wasmHash,
      sbomHash,
      checksumSignature,
      sourceRevision: input.sourceRevision,
      networkId: input.networkId,
      adminId: input.adminId,
      contractIds: input.contractIds,
      timestamp: new Date(),
      toolchainVersion: input.toolchainVersion
    };

    await this.prisma.releaseAttestation.create({
      data: {
        wasmHash,
        sbomHash,
        checksumSignature,
        sourceRevision: input.sourceRevision,
        networkId: input.networkId,
        adminId: input.adminId,
        contractIds: input.contractIds,
        timestamp: attestation.timestamp,
        toolchainVersion: input.toolchainVersion
      }
    });

    return attestation;
  }

  async verifyAttestation(attestation: ReleaseAttestation, publicKey: Buffer): Promise<boolean> {
    const checksumData = JSON.stringify({
      wasmHash: attestation.wasmHash,
      sbomHash: attestation.sbomHash,
      sourceRevision: attestation.sourceRevision,
      networkId: attestation.networkId,
      contractIds: attestation.contractIds.sort(),
      timestamp: attestation.timestamp.toISOString()
    });

    return crypto
      .createVerify("sha256")
      .update(checksumData)
      .verify(publicKey, attestation.checksumSignature, "hex");
  }

  async getAttestation(wasmHash: string): Promise<ReleaseAttestation | null> {
    const row = await this.prisma.releaseAttestation.findUnique({
      where: { wasmHash }
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
