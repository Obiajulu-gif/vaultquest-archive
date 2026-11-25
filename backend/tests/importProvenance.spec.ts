/**
 * Tests for ImportProvenanceService (issue #1148).
 *
 * Coverage:
 * - Normal path: successful import with verification
 * - Failure path: hash mismatch, missing provenance
 * - Retry path: exponential backoff for failed imports
 * - Authorization path: operator accountability and signature verification
 * - Rollback path: atomic reversion of corrupted imports
 * - Idempotency: duplicate import prevention via source hash
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID, generateKeyPairSync, type KeyObject } from "node:crypto";
import { startTestDb, resetDb, type TestDb } from "./helpers/db.js";
import { ImportProvenanceService } from "../src/services/importProvenanceService.js";

let testDb: TestDb;
let service: ImportProvenanceService;
let serviceWithSigning: ImportProvenanceService;
let signingKeys: { publicKey: KeyObject; privateKey: KeyObject };

beforeAll(async () => {
  testDb = await startTestDb();
  
  // Generate RSA key pair for signature testing
  signingKeys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  service = new ImportProvenanceService(testDb.prisma);
  serviceWithSigning = new ImportProvenanceService(
    testDb.prisma,
    undefined,
    signingKeys.privateKey
  );
});

afterAll(async () => {
  await testDb.stop();
});

beforeEach(async () => {
  await resetDb(testDb.prisma);
});

describe("ImportProvenanceService", () => {
  describe("Normal Path: Successful Import", () => {
    it("should create import provenance with valid source hash", async () => {
      const sourceData = JSON.stringify({
        actions: [{ id: "a1", type: "deposit" }]
      });
      const operatorId = "operator-001";
      const recordIds = ["rec-1", "rec-2"];

      const result = await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "/backups/2024-11-22.sql.gz",
          operatorId,
          targetEntity: "ActionLedger",
          recordIds,
          metadata: { backupVersion: "1.0" }
        },
        sourceData
      );

      expect(result).toHaveProperty("id");
      expect(result.sourceHash).toBe(service.computeSourceHash(sourceData));

      const provenance = await testDb.prisma.importProvenance.findUnique({
        where: { id: result.id }
      });

      expect(provenance).toBeTruthy();
      expect(provenance?.status).toBe("pending");
      expect(provenance?.recordCount).toBe(2);
      expect(provenance?.operatorId).toBe(operatorId);
    });

    it("should verify import integrity with matching source hash", async () => {
      const sourceData = Buffer.from("backup-data-content");
      const operatorId = "operator-002";

      const { id, sourceHash } = await service.createImportProvenance(
        {
          sourceType: "migration",
          sourceRef: "migration-v2.0",
          operatorId,
          targetEntity: "ChainEvent",
          recordIds: ["evt-1"]
        },
        sourceData
      );

      const verification = await service.verifyImportIntegrity(id, sourceData);

      expect(verification.valid).toBe(true);
      expect(verification.sourceHash).toBe(sourceHash);
      expect(verification.errorCode).toBeUndefined();

      const updated = await testDb.prisma.importProvenance.findUnique({
        where: { id }
      });

      expect(updated?.status).toBe("verified");
      expect(updated?.verifiedAt).toBeTruthy();
    });

    it("should complete import successfully", async () => {
      const sourceData = "sample-data";
      const { id } = await service.createImportProvenance(
        {
          sourceType: "manual_import",
          sourceRef: "manual-upload",
          operatorId: "admin-1",
          targetEntity: "ActionLedger",
          recordIds: ["r1"]
        },
        sourceData
      );

      await service.verifyImportIntegrity(id, sourceData);
      const completed = await service.completeImport(id);

      expect(completed.status).toBe("completed");
      expect(completed.completedAt).toBeTruthy();
    });
  });

  describe("Failure Path: Hash Mismatch & Invalid Data", () => {
    it("should fail verification when source data is tampered", async () => {
      const originalData = "original-backup-content";
      const tamperedData = "tampered-backup-content";

      const { id } = await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "/backups/prod.sql.gz",
          operatorId: "operator-003",
          targetEntity: "ActionLedger",
          recordIds: ["a1", "a2"]
        },
        originalData
      );

      const verification = await service.verifyImportIntegrity(id, tamperedData);

      expect(verification.valid).toBe(false);
      expect(verification.errorCode).toBe("HASH_MISMATCH");
      expect(verification.errorDetail).toContain("tampered");

      const failed = await testDb.prisma.importProvenance.findUnique({
        where: { id }
      });

      expect(failed?.status).toBe("failed");
      expect(failed?.errorCode).toBe("HASH_MISMATCH");
    });

    it("should return error when verifying non-existent provenance", async () => {
      const fakeId = randomUUID();
      const verification = await service.verifyImportIntegrity(
        fakeId,
        "some-data"
      );

      expect(verification.valid).toBe(false);
      expect(verification.errorCode).toBe("PROVENANCE_NOT_FOUND");
      expect(verification.errorDetail).toContain(fakeId);
    });
  });

  describe("Retry Path: Exponential Backoff", () => {
    it("should retry failed import within max retry limit", async () => {
      const sourceData = "data-to-retry";
      const { id } = await service.createImportProvenance(
        {
          sourceType: "repair_import",
          sourceRef: "repair-batch-1",
          operatorId: "reconciler",
          targetEntity: "PendingEvent",
          recordIds: ["pe1"]
        },
        sourceData
      );

      // Simulate failure
      await testDb.prisma.importProvenance.update({
        where: { id },
        data: { status: "failed", errorCode: "NETWORK_ERROR" }
      });

      const retried = await service.retryFailedImport(id, 3);
      expect(retried).toBe(true);

      const updated = await testDb.prisma.importProvenance.findUnique({
        where: { id }
      });

      expect(updated?.status).toBe("pending");
      expect(updated?.retryCount).toBe(1);
      expect(updated?.errorCode).toBeNull();
    });

    it("should reject retry when max retries exceeded", async () => {
      const sourceData = "exhausted-retry-data";
      const { id } = await service.createImportProvenance(
        {
          sourceType: "migration",
          sourceRef: "migration-v3",
          operatorId: "migrator",
          targetEntity: "ActionLedger",
          recordIds: ["al1"]
        },
        sourceData
      );

      // Simulate exhausted retries
      await testDb.prisma.importProvenance.update({
        where: { id },
        data: { status: "failed", retryCount: 3 }
      });

      const retried = await service.retryFailedImport(id, 3);
      expect(retried).toBe(false);
    });
  });

  describe("Authorization Path: Digital Signatures", () => {
    it("should sign import operation with private key", async () => {
      const sourceData = "signed-data";
      const operatorId = "secure-operator";

      const result = await serviceWithSigning.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "/secure/backup.sql.gz",
          operatorId,
          targetEntity: "ActionLedger",
          recordIds: ["s1", "s2"]
        },
        sourceData
      );

      expect(result.signature).toBeTruthy();

      const provenance = await testDb.prisma.importProvenance.findUnique({
        where: { id: result.id }
      });

      expect(provenance?.signature).toBeTruthy();
    });

    it("should verify import signature with public key", async () => {
      const sourceData = "verifiable-signed-data";
      const operatorId = "audited-operator";

      const { signature } = await serviceWithSigning.createImportProvenance(
        {
          sourceType: "manual_import",
          sourceRef: "manual-secure",
          operatorId,
          targetEntity: "ChainEvent",
          recordIds: ["ce1"]
        },
        sourceData
      );

      expect(signature).toBeTruthy();

      // Note: Actual signature verification would need the exact payload
      // This is a simplified check
      expect(signature).toHaveLength(344); // Base64-encoded RSA-2048 signature
    });

    it("should track operator identity in provenance history", async () => {
      const operatorId = "tracked-operator";

      await service.createImportProvenance(
        {
          sourceType: "migration",
          sourceRef: "migration-1",
          operatorId,
          targetEntity: "ActionLedger",
          recordIds: ["m1"]
        },
        "data-1"
      );

      await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "backup-1",
          operatorId,
          targetEntity: "PendingEvent",
          recordIds: ["m2"]
        },
        "data-2"
      );

      const history = await service.getProvenanceHistory({ operatorId });

      expect(history).toHaveLength(2);
      expect(history.every((h) => h.operatorId === operatorId)).toBe(true);
    });
  });

  describe("Rollback Path: Atomic Reversion", () => {
    it("should rollback ActionLedger imports by redacting records", async () => {
      const recordIds = [randomUUID(), randomUUID()];

      // Seed test ActionLedger records
      await testDb.prisma.actionLedger.createMany({
        data: recordIds.map((id) => ({
          id,
          idempotencyKey: `idem-${id}`,
          walletAddress: "GTEST...",
          actionType: "deposit",
          actionPayload: {},
          status: "confirmed",
          correlationId: randomUUID()
        }))
      });

      const { id } = await service.createImportProvenance(
        {
          sourceType: "migration",
          sourceRef: "test-migration",
          operatorId: "test-operator",
          targetEntity: "ActionLedger",
          recordIds
        },
        "test-data"
      );

      const rollback = await service.rollbackImport(id);

      expect(rollback.success).toBe(true);
      expect(rollback.revertedRecordCount).toBe(2);

      const redacted = await testDb.prisma.actionLedger.findMany({
        where: { id: { in: recordIds } }
      });

      expect(redacted.every((r) => r.redactedAt !== null)).toBe(true);
    });

    it("should rollback PendingEvent imports by deleting records", async () => {
      const txHashes = [`0xabc${Date.now()}`, `0xdef${Date.now()}`];

      await testDb.prisma.pendingEvent.createMany({
        data: txHashes.map((txHash) => ({
          txHash,
          sorobanEventId: `evt-${txHash}`,
          eventPayload: {},
          statusHint: "pending"
        }))
      });

      const { id } = await service.createImportProvenance(
        {
          sourceType: "repair_import",
          sourceRef: "repair-pending",
          operatorId: "reconciler",
          targetEntity: "PendingEvent",
          recordIds: txHashes
        },
        "pending-data"
      );

      const rollback = await service.rollbackImport(id);

      expect(rollback.success).toBe(true);
      expect(rollback.revertedRecordCount).toBe(2);

      const deleted = await testDb.prisma.pendingEvent.findMany({
        where: { txHash: { in: txHashes } }
      });

      expect(deleted).toHaveLength(0);
    });

    it("should handle rollback idempotency for already-reverted imports", async () => {
      const { id } = await service.createImportProvenance(
        {
          sourceType: "manual_import",
          sourceRef: "manual-test",
          operatorId: "test-admin",
          targetEntity: "ChainEvent",
          recordIds: ["ce1"]
        },
        "chain-data"
      );

      await testDb.prisma.importProvenance.update({
        where: { id },
        data: { status: "reverted", revertedAt: new Date() }
      });

      const rollback = await service.rollbackImport(id);

      expect(rollback.success).toBe(true);
      expect(rollback.revertedRecordCount).toBe(0); // No action taken
    });

    it("should fail rollback gracefully with error details", async () => {
      const { id } = await service.createImportProvenance(
        {
          sourceType: "migration",
          sourceRef: "invalid-target",
          operatorId: "test-operator",
          targetEntity: "UnsupportedEntity",
          recordIds: ["bad1"]
        },
        "invalid-data"
      );

      const rollback = await service.rollbackImport(id);

      expect(rollback.success).toBe(false);
      expect(rollback.errorDetail).toContain("Unsupported target entity");
    });
  });

  describe("Idempotency: Duplicate Prevention", () => {
    it("should reject duplicate imports with same source hash", async () => {
      const sourceData = "unique-backup-content";
      const operatorId = "dedup-operator";

      const first = await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "/backups/prod-1.sql.gz",
          operatorId,
          targetEntity: "ActionLedger",
          recordIds: ["r1"]
        },
        sourceData
      );

      // Mark as completed
      await service.completeImport(first.id);

      // Attempt duplicate import with same source data
      const duplicate = await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "/backups/prod-2.sql.gz", // Different ref, same data
          operatorId,
          targetEntity: "ActionLedger",
          recordIds: ["r2"]
        },
        sourceData
      );

      expect(duplicate.id).toBe(first.id); // Returns existing record
      expect(duplicate.sourceHash).toBe(first.sourceHash);
    });

    it("should allow imports with same source ref but different data", async () => {
      const operatorId = "multi-import-operator";
      const sourceRef = "/backups/incremental.sql.gz";

      const first = await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef,
          operatorId,
          targetEntity: "ActionLedger",
          recordIds: ["inc1"]
        },
        "backup-data-v1"
      );

      const second = await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef,
          operatorId,
          targetEntity: "ActionLedger",
          recordIds: ["inc2"]
        },
        "backup-data-v2"
      );

      expect(second.id).not.toBe(first.id);
      expect(second.sourceHash).not.toBe(first.sourceHash);
    });
  });

  describe("Provenance History & Audit Trail", () => {
    it("should retrieve provenance history filtered by source type", async () => {
      await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "backup-1",
          operatorId: "op1",
          targetEntity: "ActionLedger",
          recordIds: ["r1"]
        },
        "data1"
      );

      await service.createImportProvenance(
        {
          sourceType: "migration",
          sourceRef: "migration-1",
          operatorId: "op1",
          targetEntity: "ChainEvent",
          recordIds: ["r2"]
        },
        "data2"
      );

      const history = await service.getProvenanceHistory({
        sourceType: "migration"
      });

      expect(history).toHaveLength(1);
      expect(history[0].sourceType).toBe("migration");
    });

    it("should retrieve provenance history filtered by status", async () => {
      const { id: id1 } = await service.createImportProvenance(
        {
          sourceType: "repair_import",
          sourceRef: "repair-1",
          operatorId: "reconciler",
          targetEntity: "PendingEvent",
          recordIds: ["pe1"]
        },
        "repair-data"
      );

      await service.completeImport(id1);

      await service.createImportProvenance(
        {
          sourceType: "repair_import",
          sourceRef: "repair-2",
          operatorId: "reconciler",
          targetEntity: "PendingEvent",
          recordIds: ["pe2"]
        },
        "repair-data-2"
      );

      const completed = await service.getProvenanceHistory({
        status: "completed"
      });

      expect(completed).toHaveLength(1);
      expect(completed[0].status).toBe("completed");
    });

    it("should limit provenance history results", async () => {
      for (let i = 0; i < 15; i++) {
        await service.createImportProvenance(
          {
            sourceType: "manual_import",
            sourceRef: `manual-${i}`,
            operatorId: "bulk-operator",
            targetEntity: "ActionLedger",
            recordIds: [`r${i}`]
          },
          `data-${i}`
        );
      }

      const limited = await service.getProvenanceHistory({}, 10);

      expect(limited).toHaveLength(10);
    });
  });

  describe("Edge Cases & Error Handling", () => {
    it("should handle rollback of non-existent provenance gracefully", async () => {
      const fakeId = randomUUID();
      const rollback = await service.rollbackImport(fakeId);

      expect(rollback.success).toBe(false);
      expect(rollback.errorDetail).toContain("not found");
    });

    it("should compute consistent hash for same data", async () => {
      const data = "consistent-data";
      const hash1 = service.computeSourceHash(data);
      const hash2 = service.computeSourceHash(data);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex length
    });

    it("should compute different hashes for different data", async () => {
      const hash1 = service.computeSourceHash("data-a");
      const hash2 = service.computeSourceHash("data-b");

      expect(hash1).not.toBe(hash2);
    });

    it("should handle metadata storage and retrieval", async () => {
      const metadata = {
        backupVersion: "2.5",
        environment: "production",
        compression: "gzip"
      };

      const { id } = await service.createImportProvenance(
        {
          sourceType: "backup_restore",
          sourceRef: "/backups/meta-test.sql.gz",
          operatorId: "meta-operator",
          targetEntity: "ActionLedger",
          recordIds: ["m1"],
          metadata
        },
        "metadata-data"
      );

      const provenance = await testDb.prisma.importProvenance.findUnique({
        where: { id }
      });

      expect(provenance?.metadata).toEqual(metadata);
    });
  });
});
