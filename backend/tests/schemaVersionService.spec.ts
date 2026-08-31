import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchemaVersionService } from "../src/services/schemaVersionService.js";
import { SCHEMA_VERSIONS } from "../src/constants.js";

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
        { migration_name: `${SCHEMA_VERSIONS.DATABASE}_some_migration` },
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
          expect.stringContaining("Indexer schema version 0.9.0 is not supported")
        ])
      );
    });
  });
});
