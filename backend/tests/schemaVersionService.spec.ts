import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchemaVersionService } from "../src/services/schemaVersionService.js";
import { SCHEMA_VERSIONS, getVersionMismatch } from "../src/constants.js";
import {
  RECORD_SCHEMA_VERSION,
  RecordCompatibilityError,
  UnsupportedSchemaVersionError,
} from "../src/schemas/recordCompatibility.js";

/**
 * SchemaVersionService covers the deployment-facing half of schema versioning:
 * the database/indexer stamps and the preflight compatibility check (#803).
 *
 * Record-shape compatibility (legacy reads, new writes, unsupported versions)
 * is covered against the fixture pack in `tests/legacyRecordMigration.spec.ts`.
 */
describe("SchemaVersionService", () => {
  let mockPrisma: any;
  let service: SchemaVersionService;

  beforeEach(() => {
    mockPrisma = {
      $queryRaw: vi.fn(),
      indexerCheckpoint: {
        findUnique: vi.fn(),
      },
    };
    service = new SchemaVersionService(mockPrisma);
  });

  describe("getIndexerVersion", () => {
    it("returns real indexer version from metadata instead of hardcoded literal", async () => {
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
        indexerVersion: "2.5.0",
      });

      const version = await service.getIndexerVersion();
      expect(version).toBe("2.5.0");
    });
  });

  describe("validateSchemaVersions", () => {
    it("detects a mismatch between old indexer and new expected schema", async () => {
      // Force database version to match expected
      mockPrisma.$queryRaw.mockResolvedValue([
        { migration_name: `${SCHEMA_VERSIONS.DATABASE}some_migration` },
      ]);
      // Force old indexer version
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
        indexerVersion: "0.9.0", // An old version
      });

      const result = await service.validateSchemaVersions();
      expect(result.valid).toBe(false);
      expect(result.indexerVersion).toBe("0.9.0");
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Indexer schema version 0.9.0 is not supported"),
        ]),
      );
    });

    it("accepts database and indexer stamps inside the supported window", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { migration_name: "20260725000002_add_wallet_auth" },
      ]);
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
        indexerVersion: "20260725000002",
      });

      const result = await service.validateSchemaVersions();
      expect(result).toMatchObject({ valid: true, issues: [] });
      expect(result.databaseVersion).toBe("20260725000002");
    });

    it("rejects a database stamp older than the supported window", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { migration_name: "20260101000000_pre_window" },
      ]);
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue({
        indexerVersion: SCHEMA_VERSIONS.INDEXER,
      });

      const result = await service.validateSchemaVersions();
      expect(result.valid).toBe(false);
      expect(result.issues.join(" ")).toContain("Database schema version 20260101000000 is not supported");
    });

    it("reports stamps it cannot read instead of guessing", async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);
      mockPrisma.indexerCheckpoint.findUnique.mockResolvedValue(null);

      const result = await service.validateSchemaVersions();
      expect(result.valid).toBe(false);
      expect(result.databaseVersion).toBe("unknown");
      expect(result.issues).toHaveLength(2);
    });
  });

  describe("record migration delegation", () => {
    const legacyRecord = {
      schemaVersion: "0.9.0",
      id: "legacy-vault-010",
      owner: "0x5555555555555555555555555555555555555555",
      asset: "0x0000000000000000000000000000000000000000",
      balance: "1000000000000000000",
      prizePoolId: "prize-pool-010",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    };

    it("validates a legacy record against its declared version", () => {
      expect(service.validateLegacyRecord(legacyRecord)).toEqual([]);
      expect(service.validateLegacyRecord({ schemaVersion: "0.1.0" })).toEqual([
        expect.stringContaining("incompatible schema version: 0.1.0"),
      ]);
      expect(
        service.validateLegacyRecord({ ...legacyRecord, prizePoolId: undefined }),
      ).toEqual([expect.stringContaining("prizePoolId")]);
    });

    it("migrates a legacy record to the current schema version", () => {
      const result = service.migrateLegacyRecord(legacyRecord);
      expect(result.ok).toBe(true);
      expect(result.record?.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
      expect(result.record?.ownerAddress).toBe(legacyRecord.owner);
    });

    it("fails migration with a descriptive error for unsupported versions", () => {
      const result = service.migrateLegacyRecord({ ...legacyRecord, schemaVersion: "9.9.9" });
      expect(result.ok).toBe(false);
      expect(result.issues).toContain("incompatible schema version: 9.9.9");
    });
  });
});

describe("getVersionMismatch", () => {
  it("treats matching stamps inside the window as compatible", () => {
    expect(getVersionMismatch(SCHEMA_VERSIONS.DATABASE, SCHEMA_VERSIONS.INDEXER)).toEqual({
      compatible: true,
      issues: [],
    });
  });

  it("flags stamps newer than the build understands", () => {
    const future = "29991231235959";
    const { compatible, issues } = getVersionMismatch(future, SCHEMA_VERSIONS.INDEXER);
    expect(compatible).toBe(false);
    expect(issues.join(" ")).toContain(`Database schema version ${future} is not supported`);
  });

  it("flags unreadable stamps on both halves", () => {
    const { compatible, issues } = getVersionMismatch("unknown", "unknown");
    expect(compatible).toBe(false);
    expect(issues).toHaveLength(2);
  });
});

describe("compatibility layer error contract", () => {
  it("exposes a stable machine-readable code for unsupported versions", () => {
    const error = new UnsupportedSchemaVersionError("0.1.0");
    expect(error.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    expect(error.message).toContain("incompatible schema version: 0.1.0");
  });

  it("exposes the failing field issues for invalid records", () => {
    const error = new RecordCompatibilityError(["prizePoolId: Required"]);
    expect(error.code).toBe("RECORD_SCHEMA_INVALID");
    expect(error.issues).toEqual(["prizePoolId: Required"]);
  });
});
