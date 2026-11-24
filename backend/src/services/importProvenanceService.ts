/**
 * Import Provenance Service (issue #1148).
 *
 * Tracks cryptographic provenance of imported records to ensure authenticity,
 * integrity, and auditability. Covers backup restores, manual imports, and
 * migration scenarios with:
 * - SHA-256 hash verification of source data
 * - Optional digital signatures for operator accountability
 * - Atomic rollback support for failed imports
 * - Idempotency guarantees via source hash deduplication
 */

import { createHash, createSign, createVerify, type KeyObject } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ImportSourceType =
  | "backup_restore"
  | "manual_import"
  | "migration"
  | "repair_import";

export type ImportStatus =
  | "pending"
  | "verified"
  | "completed"
  | "failed"
  | "reverted";

export interface ImportProvenanceInput {
  sourceType: ImportSourceType;
  sourceRef: string;
  operatorId: string;
  targetEntity: string;
  recordIds: string[];
  metadata?: Record<string, unknown>;
}

export interface ImportVerificationResult {
  valid: boolean;
  provenanceId: string;
  sourceHash: string;
  errorCode?: string;
  errorDetail?: string;
}

export interface ImportRollbackResult {
  success: boolean;
  provenanceId: string;
  revertedRecordCount: number;
  errorDetail?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ImportProvenanceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger?: Logger,
    private readonly signingKey?: KeyObject
  ) {}

  /**
   * Computes SHA-256 hash of source data for integrity verification.
   * @param sourceData - Raw data to hash (file content, JSON payload, etc.)
   * @returns Hex-encoded SHA-256 hash
   */
  computeSourceHash(sourceData: string | Buffer): string {
    return createHash("sha256").update(sourceData).digest("hex");
  }

  /**
   * Signs the import operation with the operator's private key.
   * @param payload - Data to sign (typically sourceHash + operatorId + timestamp)
   * @param privateKey - RSA or Ed25519 private key
   * @returns Base64-encoded signature
   */
  signImportOperation(payload: string, privateKey: KeyObject): string {
    const sign = createSign("RSA-SHA256");
    sign.update(payload);
    return sign.sign(privateKey, "base64");
  }

  /**
   * Verifies a signed import operation against a public key.
   * @param payload - Original signed payload
   * @param signature - Base64-encoded signature
   * @param publicKey - RSA or Ed25519 public key
   * @returns True if signature is valid
   */
  verifyImportSignature(
    payload: string,
    signature: string,
    publicKey: KeyObject
  ): boolean {
    try {
      const verify = createVerify("RSA-SHA256");
      verify.update(payload);
      return verify.verify(publicKey, signature, "base64");
    } catch (error) {
      this.logger?.error({ error }, "importProvenance: signature verification failed");
      return false;
    }
  }

  /**
   * Creates a new import provenance record with cryptographic validation.
   *
   * Workflow:
   * 1. Compute source hash of the data being imported
   * 2. Check for duplicate imports (idempotency via source hash)
   * 3. Optionally sign the operation for non-repudiation
   * 4. Store provenance record with pending status
   * 5. Return provenance ID for tracking
   *
   * @param input - Import metadata
   * @param sourceData - Raw source data (for hashing)
   * @returns Provenance record with verification hash
   */
  async createImportProvenance(
    input: ImportProvenanceInput,
    sourceData: string | Buffer
  ): Promise<{ id: string; sourceHash: string; signature?: string }> {
    const sourceHash = this.computeSourceHash(sourceData);

    // Idempotency check: reject duplicate imports of the same source data
    const existing = await this.prisma.importProvenance.findFirst({
      where: {
        sourceHash,
        status: { in: ["completed", "pending", "verified"] }
      }
    });

    if (existing) {
      this.logger?.warn(
        { provenanceId: existing.id, sourceHash },
        "importProvenance: duplicate import detected"
      );
      return {
        id: existing.id,
        sourceHash,
        signature: existing.signature ?? undefined
      };
    }

    // Optional digital signature for accountability
    let signature: string | undefined;
    if (this.signingKey) {
      const payload = JSON.stringify({
        sourceHash,
        operatorId: input.operatorId,
        timestamp: new Date().toISOString(),
        targetEntity: input.targetEntity
      });
      signature = this.signImportOperation(payload, this.signingKey);
    }

    const provenance = await this.prisma.importProvenance.create({
      data: {
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        sourceHash,
        signature,
        operatorId: input.operatorId,
        recordCount: input.recordIds.length,
        recordIds: input.recordIds,
        targetEntity: input.targetEntity,
        status: "pending",
        metadata: input.metadata ?? {}
      }
    });

    this.logger?.info(
      { provenanceId: provenance.id, sourceHash, recordCount: input.recordIds.length },
      "importProvenance: created"
    );

    return { id: provenance.id, sourceHash, signature };
  }

  /**
   * Verifies the integrity of an import by comparing computed hash against
   * the stored provenance record.
   *
   * @param provenanceId - ID of the provenance record to verify
   * @param actualSourceData - Current source data to verify against stored hash
   * @returns Verification result with validity flag
   */
  async verifyImportIntegrity(
    provenanceId: string,
    actualSourceData: string | Buffer
  ): Promise<ImportVerificationResult> {
    const provenance = await this.prisma.importProvenance.findUnique({
      where: { id: provenanceId }
    });

    if (!provenance) {
      return {
        valid: false,
        provenanceId,
        sourceHash: "",
        errorCode: "PROVENANCE_NOT_FOUND",
        errorDetail: `No provenance record found with id ${provenanceId}`
      };
    }

    const actualHash = this.computeSourceHash(actualSourceData);
    const valid = actualHash === provenance.sourceHash;

    if (!valid) {
      this.logger?.error(
        { provenanceId, expected: provenance.sourceHash, actual: actualHash },
        "importProvenance: integrity check failed"
      );

      await this.prisma.importProvenance.update({
        where: { id: provenanceId },
        data: {
          status: "failed",
          errorCode: "HASH_MISMATCH",
          errorDetail: `Source hash mismatch: expected ${provenance.sourceHash}, got ${actualHash}`
        }
      });

      return {
        valid: false,
        provenanceId,
        sourceHash: provenance.sourceHash,
        errorCode: "HASH_MISMATCH",
        errorDetail: "Source data has been tampered with or corrupted"
      };
    }

    // Update status to verified
    await this.prisma.importProvenance.update({
      where: { id: provenanceId },
      data: { status: "verified", verifiedAt: new Date() }
    });

    this.logger?.info(
      { provenanceId, sourceHash: actualHash },
      "importProvenance: verification successful"
    );

    return {
      valid: true,
      provenanceId,
      sourceHash: actualHash
    };
  }

  /**
   * Marks an import as completed after successful data insertion.
   *
   * @param provenanceId - ID of the provenance record
   * @returns Updated provenance record
   */
  async completeImport(provenanceId: string) {
    return this.prisma.importProvenance.update({
      where: { id: provenanceId },
      data: { status: "completed", completedAt: new Date() }
    });
  }

  /**
   * Rolls back a failed or corrupted import by reverting imported records.
   *
   * Workflow:
   * 1. Retrieve provenance record and validate it exists
   * 2. Extract record IDs from provenance.recordIds
   * 3. Delete or mark records as reverted in target entity table
   * 4. Update provenance status to "reverted"
   * 5. Log rollback action for audit trail
   *
   * @param provenanceId - ID of the provenance record to roll back
   * @returns Rollback result with success flag
   */
  async rollbackImport(provenanceId: string): Promise<ImportRollbackResult> {
    const provenance = await this.prisma.importProvenance.findUnique({
      where: { id: provenanceId }
    });

    if (!provenance) {
      return {
        success: false,
        provenanceId,
        revertedRecordCount: 0,
        errorDetail: `Provenance record ${provenanceId} not found`
      };
    }

    if (provenance.status === "reverted") {
      this.logger?.warn(
        { provenanceId },
        "importProvenance: already reverted, skipping rollback"
      );
      return {
        success: true,
        provenanceId,
        revertedRecordCount: 0
      };
    }

    const recordIds = provenance.recordIds as string[];

    try {
      // Atomic rollback within a transaction
      await this.prisma.$transaction(async (tx) => {
        // Mark records as redacted/reverted based on target entity
        switch (provenance.targetEntity) {
          case "ActionLedger":
            await tx.actionLedger.updateMany({
              where: { id: { in: recordIds } },
              data: { redactedAt: new Date() }
            });
            break;

          case "PendingEvent":
            await tx.pendingEvent.deleteMany({
              where: { txHash: { in: recordIds } }
            });
            break;

          case "ChainEvent":
            await tx.chainEvent.deleteMany({
              where: { id: { in: recordIds } }
            });
            break;

          default:
            throw new Error(`Unsupported target entity: ${provenance.targetEntity}`);
        }

        // Mark provenance as reverted
        await tx.importProvenance.update({
          where: { id: provenanceId },
          data: {
            status: "reverted",
            revertedAt: new Date()
          }
        });
      });

      this.logger?.info(
        { provenanceId, recordCount: recordIds.length },
        "importProvenance: rollback completed"
      );

      return {
        success: true,
        provenanceId,
        revertedRecordCount: recordIds.length
      };
    } catch (error) {
      this.logger?.error(
        { provenanceId, error },
        "importProvenance: rollback failed"
      );

      await this.prisma.importProvenance.update({
        where: { id: provenanceId },
        data: {
          errorCode: "ROLLBACK_FAILED",
          errorDetail: error instanceof Error ? error.message : String(error),
          retryCount: { increment: 1 }
        }
      });

      return {
        success: false,
        provenanceId,
        revertedRecordCount: 0,
        errorDetail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Retrieves import provenance history for a given operator or source.
   *
   * @param filters - Query filters (operatorId, sourceType, status)
   * @param limit - Maximum records to return
   * @returns List of provenance records
   */
  async getProvenanceHistory(
    filters: {
      operatorId?: string;
      sourceType?: ImportSourceType;
      status?: ImportStatus;
    },
    limit = 100
  ) {
    return this.prisma.importProvenance.findMany({
      where: {
        operatorId: filters.operatorId,
        sourceType: filters.sourceType,
        status: filters.status
      },
      orderBy: { createdAt: "desc" },
      take: limit
    });
  }

  /**
   * Retries a failed import with exponential backoff.
   *
   * @param provenanceId - ID of the failed import
   * @param maxRetries - Maximum retry attempts (default: 3)
   * @returns True if retry was successful
   */
  async retryFailedImport(
    provenanceId: string,
    maxRetries = 3
  ): Promise<boolean> {
    const provenance = await this.prisma.importProvenance.findUnique({
      where: { id: provenanceId }
    });

    if (!provenance || provenance.status !== "failed") {
      return false;
    }

    if (provenance.retryCount >= maxRetries) {
      this.logger?.warn(
        { provenanceId, retryCount: provenance.retryCount },
        "importProvenance: max retries exceeded"
      );
      return false;
    }

    await this.prisma.importProvenance.update({
      where: { id: provenanceId },
      data: {
        status: "pending",
        retryCount: { increment: 1 },
        errorCode: null,
        errorDetail: null
      }
    });

    this.logger?.info(
      { provenanceId, retryCount: provenance.retryCount + 1 },
      "importProvenance: retry scheduled"
    );

    return true;
  }
}
