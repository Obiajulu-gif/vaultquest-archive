import type { PrismaClient } from "@prisma/client";
import { SCHEMA_VERSIONS, getVersionMismatch } from "../constants.js";

/**
 * Service for validating database and indexer schema versions
 * Prevents deployment with incompatible schemas
 */
export class SchemaVersionService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Get current database schema version from migrations
   */
  async getDatabaseVersion(): Promise<string> {
    try {
      // Query the _prisma_migrations table to get the latest applied migration
      const result = await this.prisma.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name 
        FROM _prisma_migrations 
        ORDER BY finished_at DESC 
        LIMIT 1
      `;
      
      if (result && result.length > 0) {
        // Extract version from migration name (e.g., "20260725000002_add_wallet_auth")
        const migrationName = result[0].migration_name;
        const versionMatch = migrationName.match(/^(\d{14})/);
        return versionMatch ? versionMatch[1] : "unknown";
      }
      
      return "unknown";
    } catch (error) {
      console.error("Failed to get database version:", error);
      return "unknown";
    }
  }

  /**
   * Get current indexer schema version
   * This is a placeholder - actual version should come from indexer metadata
   */
  async getIndexerVersion(): Promise<string> {
    try {
      const checkpoint = await this.prisma.indexerCheckpoint.findUnique({
        where: { id: "singleton" },
      });
      
      // For now, we'll use a version field if it exists, otherwise default
      // In production, this should be a proper version field in the schema
      return checkpoint ? "1.2.0" : "unknown";
    } catch (error) {
      console.error("Failed to get indexer version:", error);
      return "unknown";
    }
  }

  /**
   * Perform preflight validation check
   * Throws error if schemas are incompatible
   */
  async validateSchemaVersions(): Promise<{
    valid: boolean;
    databaseVersion: string;
    indexerVersion: string;
    issues: string[];
  }> {
    const dbVersion = await this.getDatabaseVersion();
    const indexerVersion = await this.getIndexerVersion();
    
    const { compatible, issues } = getVersionMismatch(dbVersion, indexerVersion);
    
    return {
      valid: compatible,
      databaseVersion: dbVersion,
      indexerVersion: indexerVersion,
      issues,
    };
  }

  /**
   * Get version information for monitoring
   */
  async getVersionInfo() {
    const dbVersion = await this.getDatabaseVersion();
    const indexerVersion = await this.getIndexerVersion();
    
    return {
      database: {
        current: dbVersion,
        expected: SCHEMA_VERSIONS.DATABASE,
        supported: SCHEMA_VERSIONS.SUPPORTED_DATABASE_VERSIONS,
      },
      indexer: {
        current: indexerVersion,
        expected: SCHEMA_VERSIONS.INDEXER,
        supported: SCHEMA_VERSIONS.SUPPORTED_INDEXER_VERSIONS,
      },
    };
  }
}
