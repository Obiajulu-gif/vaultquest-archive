/**
 * Schema version tracking for deployment validation
 */
export const SCHEMA_VERSIONS = {
  // Current database schema version (from latest migration)
  DATABASE: "20260725000002",
  
  // Current indexer checkpoint schema version
  INDEXER: "1.2.0",
  
  // Supported version ranges for this release
  SUPPORTED_DATABASE_VERSIONS: [
    "20260725000002",
    "20260725000001",
    "20260725000000",
  ],
  
  SUPPORTED_INDEXER_VERSIONS: ["1.2.0", "1.1.0"],
};

/**
 * Version compatibility check
 */
export function isVersionSupported(
  current: string,
  supported: string[]
): boolean {
  return supported.includes(current);
}

/**
 * Get version mismatch details
 */
export function getVersionMismatch(
  currentDb: string,
  currentIndexer: string
): {
  compatible: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  
  if (!isVersionSupported(currentDb, SCHEMA_VERSIONS.SUPPORTED_DATABASE_VERSIONS)) {
    issues.push(
      `Database schema version ${currentDb} is not supported. Expected one of: ${SCHEMA_VERSIONS.SUPPORTED_DATABASE_VERSIONS.join(", ")}`
    );
  }
  
  if (!isVersionSupported(currentIndexer, SCHEMA_VERSIONS.SUPPORTED_INDEXER_VERSIONS)) {
    issues.push(
      `Indexer schema version ${currentIndexer} is not supported. Expected one of: ${SCHEMA_VERSIONS.SUPPORTED_INDEXER_VERSIONS.join(", ")}`
    );
  }
  
  return {
    compatible: issues.length === 0,
    issues,
  };
}
