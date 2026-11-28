import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Record Provenance Tracking (#867) & Cryptographic Provenance.
 *
 * Provides provenance tracking and cryptographic attestation for imported and
 * derived records in VaultQuest. Models source, import batch, transform version,
 * actor metadata, lineage tracing, and HMAC-SHA256 provenance proofs over
 * canonicalized record payloads and metadata envelopes.
 */

export type ProvenanceSourceType =
  | "import_batch"
  | "derived_transform"
  | "migration"
  | "manual_operator"
  | "indexer_replay";

export interface CryptographicProvenanceProof {
  version: "1";
  algorithm: "hmac-sha256";
  keyId: string;
  /** SHA-256 hex digest of the canonicalized imported record payload. */
  payloadHash: string;
  /** SHA-256 hex digest of the canonicalized provenance metadata envelope. */
  envelopeHash: string;
  /** HMAC-SHA256 hex signature over `envelopeHash` using the key identified by `keyId`. */
  signature: string;
  signedAt: string;
}

export type ProvenanceVerificationStatus =
  | "verified"
  | "legacy_unsigned"
  | "missing_provenance"
  | "unsupported_algorithm"
  | "unknown_key_id"
  | "actor_mismatch"
  | "payload_hash_mismatch"
  | "envelope_hash_mismatch"
  | "invalid_signature";

export interface ProvenanceVerificationResult {
  valid: boolean;
  status: ProvenanceVerificationStatus;
  keyId?: string;
  payloadHash?: string;
  envelopeHash?: string;
  reason?: string;
}

export interface CryptographicImportProvenanceOptions {
  importBatchId: string;
  transformVersion: string;
  actor: string;
  /** Optional explicit payload to hash; defaults to the record object itself. */
  payload?: unknown;
  signingSecret: string;
  keyId?: string;
  timestamp?: string;
}

export interface VerifyCryptographicProvenanceOptions {
  /** Optional payload to check against `proof.payloadHash`. */
  payload?: unknown;
  /** Map of `keyId -> signingSecret` supporting key rotation. */
  keys: Record<string, string>;
  /** When set, verifies `provenance.actor === expectedActor`. */
  expectedActor?: string;
  /** When true, records without `cryptographicProof` pass as `legacy_unsigned`. */
  allowLegacyUnsigned?: boolean;
}

export interface RecordProvenance {
  id: string;
  source: ProvenanceSourceType;
  importBatchId?: string;
  transformVersion: string;
  actor: string;
  timestamp: string;
  sourceRecordIds?: string[];
  derivedFrom?: string[];
  parentDeleted?: boolean;
  deletedSourceIds?: string[];
  /** Metadata snapshots keep lineage available after a source is deleted. */
  sourceSnapshots?: Array<{ recordId: string; provenance?: RecordProvenance }>;
  /** Cryptographic attestation binding the imported payload and provenance envelope. */
  cryptographicProof?: CryptographicProvenanceProof;
  history?: Array<{
    updatedAt: string;
    actor: string;
    action: string;
  }>;
}

export interface ProvenanceExportSummary {
  exportedAt: string;
  totalRecords: number;
  recordsWithProvenance: number;
  cryptographicallySignedRecords?: number;
  bySource: Record<string, number>;
  byTransformVersion: Record<string, number>;
  deletedSourceReferences: number;
}

export interface RecordProvenanceReport {
  summary: ProvenanceExportSummary;
  records: Array<{
    recordId: string;
    provenance: RecordProvenance;
  }>;
}

function canonicalizeForHash(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        out[key] = canonicalizeForHash(record[key]);
      }
    }
    return out;
  }
  return value;
}

function sha256Hex(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeForHash(value)), "utf8")
    .digest("hex");
}

function hmacSha256Hex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export class RecordProvenanceManager {
  private requireMetadata(...values: string[]): void {
    if (values.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("Provenance identifiers, version and actor must be non-empty strings.");
    }
  }

  /**
   * Attach provenance metadata to an imported record.
   */
  public attachImportProvenance<T extends { id: string }>(
    record: T,
    importBatchId: string,
    transformVersion: string,
    actor: string
  ): T & { provenance: RecordProvenance } {
    this.requireMetadata(record.id, importBatchId, transformVersion, actor);
    const provenance: RecordProvenance = {
      id: `prov-${globalThis.crypto.randomUUID()}`,
      source: "import_batch",
      importBatchId,
      transformVersion,
      actor,
      timestamp: new Date().toISOString(),
      parentDeleted: false,
      history: [
        {
          updatedAt: new Date().toISOString(),
          actor,
          action: `imported in batch ${importBatchId}`,
        },
      ],
    };

    return {
      ...record,
      provenance,
    };
  }

  /**
   * Attach cryptographically signed provenance metadata to an imported record.
   * Binds the canonicalized payload hash and provenance metadata envelope via
   * HMAC-SHA256 so post-import tampering or unauthorized attribution is detectable.
   */
  public attachCryptographicImportProvenance<T extends { id: string }>(
    record: T,
    options: CryptographicImportProvenanceOptions
  ): T & { provenance: RecordProvenance } {
    const keyId = options.keyId ?? "default";
    this.requireMetadata(
      record.id,
      options.importBatchId,
      options.transformVersion,
      options.actor,
      options.signingSecret,
      keyId
    );
    const timestamp = options.timestamp ?? new Date().toISOString();
    const payloadHash = sha256Hex(options.payload !== undefined ? options.payload : record);
    const envelopeHash = sha256Hex({
      version: "1",
      recordId: record.id,
      source: "import_batch",
      importBatchId: options.importBatchId,
      transformVersion: options.transformVersion,
      actor: options.actor,
      timestamp,
      payloadHash,
      keyId,
    });
    const signature = hmacSha256Hex(options.signingSecret, envelopeHash);

    const provenance: RecordProvenance = {
      id: `prov-${globalThis.crypto.randomUUID()}`,
      source: "import_batch",
      importBatchId: options.importBatchId,
      transformVersion: options.transformVersion,
      actor: options.actor,
      timestamp,
      parentDeleted: false,
      cryptographicProof: {
        version: "1",
        algorithm: "hmac-sha256",
        keyId,
        payloadHash,
        envelopeHash,
        signature,
        signedAt: timestamp,
      },
      history: [
        {
          updatedAt: timestamp,
          actor: options.actor,
          action: `imported in batch ${options.importBatchId} (signed:${keyId})`,
        },
      ],
    };

    return {
      ...record,
      provenance,
    };
  }

  /**
   * Verify cryptographic provenance attached to an imported record.
   */
  public verifyCryptographicProvenance(
    record: { id: string; provenance?: RecordProvenance },
    options: VerifyCryptographicProvenanceOptions
  ): ProvenanceVerificationResult {
    const provenance = record.provenance;
    if (!provenance) {
      return {
        valid: false,
        status: "missing_provenance",
        reason: "Record has no provenance metadata.",
      };
    }

    if (options.expectedActor && provenance.actor !== options.expectedActor) {
      return {
        valid: false,
        status: "actor_mismatch",
        keyId: provenance.cryptographicProof?.keyId,
        payloadHash: provenance.cryptographicProof?.payloadHash,
        envelopeHash: provenance.cryptographicProof?.envelopeHash,
        reason: `Expected actor "${options.expectedActor}" but provenance is attributed to "${provenance.actor}".`,
      };
    }

    const proof = provenance.cryptographicProof;
    if (!proof) {
      return {
        valid: Boolean(options.allowLegacyUnsigned),
        status: "legacy_unsigned",
        reason: options.allowLegacyUnsigned
          ? "Legacy record without cryptographic proof accepted under migration policy."
          : "Record provenance lacks a cryptographic proof.",
      };
    }

    if (proof.version !== "1" || proof.algorithm !== "hmac-sha256") {
      return {
        valid: false,
        status: "unsupported_algorithm",
        keyId: proof.keyId,
        payloadHash: proof.payloadHash,
        envelopeHash: proof.envelopeHash,
        reason: `Unsupported cryptographic proof version/algorithm: ${String(proof.version)}/${String(proof.algorithm)}.`,
      };
    }

    const secret = options.keys[proof.keyId];
    if (!secret || !secret.trim()) {
      return {
        valid: false,
        status: "unknown_key_id",
        keyId: proof.keyId,
        payloadHash: proof.payloadHash,
        envelopeHash: proof.envelopeHash,
        reason: `No signing key configured for keyId "${proof.keyId}".`,
      };
    }

    if (options.payload !== undefined) {
      const actualPayloadHash = sha256Hex(options.payload);
      if (!timingSafeHexEqual(actualPayloadHash, proof.payloadHash)) {
        return {
          valid: false,
          status: "payload_hash_mismatch",
          keyId: proof.keyId,
          payloadHash: proof.payloadHash,
          envelopeHash: proof.envelopeHash,
          reason: "Imported record payload hash does not match signed cryptographic provenance.",
        };
      }
    }

    const expectedEnvelopeHash = sha256Hex({
      version: proof.version,
      recordId: record.id,
      source: provenance.source,
      importBatchId: provenance.importBatchId ?? "",
      transformVersion: provenance.transformVersion,
      actor: provenance.actor,
      timestamp: provenance.timestamp,
      payloadHash: proof.payloadHash,
      keyId: proof.keyId,
    });

    if (!timingSafeHexEqual(expectedEnvelopeHash, proof.envelopeHash)) {
      return {
        valid: false,
        status: "envelope_hash_mismatch",
        keyId: proof.keyId,
        payloadHash: proof.payloadHash,
        envelopeHash: proof.envelopeHash,
        reason: "Provenance metadata envelope has been modified since signing.",
      };
    }

    const expectedSignature = hmacSha256Hex(secret, expectedEnvelopeHash);
    if (!timingSafeHexEqual(expectedSignature, proof.signature)) {
      return {
        valid: false,
        status: "invalid_signature",
        keyId: proof.keyId,
        payloadHash: proof.payloadHash,
        envelopeHash: proof.envelopeHash,
        reason: "Cryptographic provenance signature verification failed.",
      };
    }

    return {
      valid: true,
      status: "verified",
      keyId: proof.keyId,
      payloadHash: proof.payloadHash,
      envelopeHash: proof.envelopeHash,
    };
  }

  /**
   * Attach provenance metadata to a derived record created from one or more source records.
   */
  public attachDerivedProvenance<T extends { id: string }, S extends { id: string; provenance?: RecordProvenance }>(
    record: T,
    sourceRecords: S[],
    transformVersion: string,
    actor: string
  ): T & { provenance: RecordProvenance } {
    this.requireMetadata(record.id, transformVersion, actor, ...sourceRecords.map((s) => s.id));
    if (!sourceRecords.length || sourceRecords.some((s) => s.id === record.id)) {
      throw new Error("Derived records require sources distinct from the derived record.");
    }
    const sources = [...new Map(sourceRecords.map((s) => [s.id, s])).values()];
    const sourceIds = sources.map((s) => s.id);
    const provenance: RecordProvenance = {
      id: `prov-${globalThis.crypto.randomUUID()}`,
      source: "derived_transform",
      transformVersion,
      actor,
      timestamp: new Date().toISOString(),
      sourceRecordIds: sourceIds,
      derivedFrom: [...sourceIds],
      sourceSnapshots: sources.map((s) => ({
        recordId: s.id,
        ...(s.provenance ? { provenance: structuredClone(s.provenance) } : {}),
      })),
      parentDeleted: false,
      history: [
        {
          updatedAt: new Date().toISOString(),
          actor,
          action: `derived from ${sourceIds.length} source records`,
        },
      ],
    };

    return {
      ...record,
      provenance,
    };
  }

  /**
   * Update a record while preserving its original provenance lineage.
   */
  public updateRecordPreservingProvenance<T extends { id: string; provenance: RecordProvenance }>(
    existingRecord: T,
    updates: Partial<Omit<T, "id" | "provenance">>,
    actor: string
  ): T {
    this.requireMetadata(actor);
    const now = new Date().toISOString();
    const updatedHistory = [
      ...structuredClone(existingRecord.provenance.history || []),
      {
        updatedAt: now,
        actor,
        action: "record updated",
      },
    ];

    const updatedProvenance: RecordProvenance = {
      ...structuredClone(existingRecord.provenance),
      history: updatedHistory,
    };

    return {
      ...existingRecord,
      ...updates,
      id: existingRecord.id,
      provenance: updatedProvenance,
    };
  }

  /**
   * Handle deletion of a source record by marking parentDeleted in derived record provenance.
   */
  public handleDeletedSourceRecord<T extends { id: string; provenance: RecordProvenance }>(
    derivedRecord: T,
    deletedSourceId: string,
    actor: string = "system"
  ): T {
    this.requireMetadata(deletedSourceId, actor);
    const now = new Date().toISOString();
    const isParent =
      derivedRecord.provenance.sourceRecordIds?.includes(deletedSourceId) ||
      derivedRecord.provenance.derivedFrom?.includes(deletedSourceId);

    if (!isParent || derivedRecord.provenance.deletedSourceIds?.includes(deletedSourceId)) {
      return derivedRecord;
    }

    const updatedHistory = [
      ...structuredClone(derivedRecord.provenance.history || []),
      {
        updatedAt: now,
        actor,
        action: `source record ${deletedSourceId} was deleted`,
      },
    ];

    return {
      ...derivedRecord,
      provenance: {
        ...structuredClone(derivedRecord.provenance),
        parentDeleted: true,
        deletedSourceIds: [...(derivedRecord.provenance.deletedSourceIds ?? []), deletedSourceId],
        history: updatedHistory,
      },
    };
  }

  /**
   * Export maintainer provenance report across a set of domain records.
   */
  public exportProvenanceReport(
    records: Array<{ id: string; provenance?: RecordProvenance }>
  ): RecordProvenanceReport {
    const bySource: Record<string, number> = Object.create(null);
    const byTransformVersion: Record<string, number> = Object.create(null);
    let recordsWithProvenance = 0;
    let cryptographicallySignedRecords = 0;
    let deletedSourceReferences = 0;

    const reportRecords: Array<{ recordId: string; provenance: RecordProvenance }> = [];

    for (const rec of records) {
      if (rec.provenance) {
        recordsWithProvenance++;
        const p = rec.provenance;
        if (p.cryptographicProof) {
          cryptographicallySignedRecords++;
        }
        bySource[p.source] = (bySource[p.source] || 0) + 1;
        byTransformVersion[p.transformVersion] = (byTransformVersion[p.transformVersion] || 0) + 1;

        if (p.parentDeleted) {
          deletedSourceReferences += p.deletedSourceIds?.length ?? 1;
        }

        reportRecords.push({
          recordId: rec.id,
          provenance: structuredClone(p),
        });
      }
    }

    return {
      summary: {
        exportedAt: new Date().toISOString(),
        totalRecords: records.length,
        recordsWithProvenance,
        cryptographicallySignedRecords,
        bySource,
        byTransformVersion,
        deletedSourceReferences,
      },
      records: reportRecords,
    };
  }
}

export const provenanceManager = new RecordProvenanceManager();
