/**
 * Optimistic Concurrency Control for VaultQuest
 *
 * Provides version tokens and conflict detection for editable workflows
 * to prevent silent overwrites of newer data from concurrent edits across
 * tabs or devices.
 *
 * This implementation:
 * - Uses version tokens (timestamps + entity identifiers) for optimistic locking
 * - Detects conflicts when stale data is used in mutations
 * - Provides user-safe conflict explanations with recovery actions
 * - Integrates with existing rejection reasons system
 */

import { getRejectionExplanation, VAULT_REJECTION_REASONS } from "./rejectionReasons";

/**
 * Version token for optimistic concurrency control
 *
 * Combines a timestamp with entity-specific metadata to create a unique
 * identifier that changes whenever the entity is modified.
 */
export interface VersionToken {
  /** Unique identifier for the entity (e.g., pool ID, wallet address) */
  entityId: string;
  /** Entity type (e.g., 'saved_pool', 'user_position', 'portfolio') */
  entityType: string;
  /** Last modification timestamp (milliseconds since epoch) */
  version: number;
  /** Optional sequence number for additional ordering guarantees */
  sequence?: number;
}

/**
 * Conflict error details
 */
export interface ConflictError {
  /** The reason code for the conflict */
  reasonCode: string;
  /** User-safe message explaining the conflict */
  userMessage: string;
  /** Actionable recovery hint */
  recoveryHint: string;
  /** The version token that was expected */
  expectedVersion: VersionToken;
  /** The actual current version on the server */
  actualVersion: VersionToken;
  /** Whether the operation can be retried after refresh */
  retryable: boolean;
}

/**
 * Result of a version-checked operation
 */
export type VersionCheckedResult<T> =
  | { success: true; data: T }
  | { success: false; conflict: ConflictError };

/**
 * Check if a version token is still valid (not stale)
 *
 * @param currentVersion The version token from the current data
 * @param expectedVersion The version token expected by the operation
 * @returns true if the versions match, false if there's a conflict
 */
export function isVersionValid(
  currentVersion: VersionToken | null | undefined,
  expectedVersion: VersionToken | null | undefined,
): boolean {
  if (!currentVersion || !expectedVersion) {
    // If either version is missing, we can't validate - be conservative
    return false;
  }

  return (
    currentVersion.entityId === expectedVersion.entityId &&
    currentVersion.entityType === expectedVersion.entityType &&
    currentVersion.version === expectedVersion.version &&
    (currentVersion.sequence ?? 0) === (expectedVersion.sequence ?? 0)
  );
}

/**
 * Create a version token from entity data
 *
 * @param entityId Unique identifier for the entity
 * @param entityType Type of the entity
 * @param updatedAt Last modification timestamp
 * @param sequence Optional sequence number
 * @returns A version token
 */
export function createVersionToken(
  entityId: string,
  entityType: string,
  updatedAt: number | string,
  sequence?: number,
): VersionToken {
  const version = typeof updatedAt === "string" ? new Date(updatedAt).getTime() : updatedAt;
  return {
    entityId,
    entityType,
    version,
    sequence,
  };
}

/**
 * Create a conflict error for a version mismatch
 *
 * @param entityType The type of entity that conflicted
 * @param expectedVersion The version that was expected
 * @param actualVersion The actual current version
 * @returns A conflict error with user-safe explanation
 */
export function createConflictError(
  entityType: string,
  expectedVersion: VersionToken,
  actualVersion: VersionToken,
): ConflictError {
  const rejectionExplanation = getRejectionExplanation(VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION);

  return {
    reasonCode: VAULT_REJECTION_REASONS.CONCURRENT_MODIFICATION,
    userMessage: rejectionExplanation.userMessage,
    recoveryHint: rejectionExplanation.recoveryHint,
    expectedVersion,
    actualVersion,
    retryable: rejectionExplanation.retryable,
  };
}

/**
 * Execute an operation with optimistic concurrency control
 *
 * @param operation The operation to execute
 * @param currentVersion The current version of the entity
 * @param expectedVersion The version expected by the operation
 * @returns Result with either success data or conflict error
 */
export async function executeWithVersionCheck<T>(
  operation: () => Promise<T>,
  currentVersion: VersionToken | null | undefined,
  expectedVersion: VersionToken | null | undefined,
): Promise<VersionCheckedResult<T>> {
  // Check if versions match
  if (!isVersionValid(currentVersion, expectedVersion)) {
    const conflict = createConflictError(
      expectedVersion?.entityType || "unknown",
      expectedVersion || { entityId: "unknown", entityType: "unknown", version: 0 },
      currentVersion || { entityId: "unknown", entityType: "unknown", version: 0 },
    );
    return { success: false, conflict };
  }

  try {
    const data = await operation();
    return { success: true, data };
  } catch (error) {
    // If the operation fails for other reasons, let it propagate
    throw error;
  }
}

/**
 * Wrap an async operation with automatic retry on conflict
 *
 * @param operation The operation to execute
 * @param getVersion Function to get the current version
 * @param maxRetries Maximum number of retry attempts
 * @returns Result with either success data or conflict error
 */
export async function executeWithRetryOnConflict<T>(
  operation: (version: VersionToken) => Promise<T>,
  getVersion: () => Promise<VersionToken | null>,
  maxRetries: number = 2,
): Promise<VersionCheckedResult<T>> {
  let lastConflict: ConflictError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const currentVersion = await getVersion();

    if (!currentVersion) {
      // Can't get version - proceed without check
      try {
        const data = await operation({ entityId: "unknown", entityType: "unknown", version: 0 });
        return { success: true, data };
      } catch (error) {
        throw error;
      }
    }

    try {
      const data = await operation(currentVersion);
      return { success: true, data };
    } catch (error) {
      const errorWithVersion = error as { conflict?: ConflictError };
      if (errorWithVersion.conflict) {
        lastConflict = errorWithVersion.conflict;
        // Retry with fresh version
        continue;
      }
      // Other errors should propagate
      throw error;
    }
  }

  // All retries exhausted
  return {
    success: false,
    conflict: lastConflict || createConflictError(
      "unknown",
      { entityId: "unknown", entityType: "unknown", version: 0 },
      { entityId: "unknown", entityType: "unknown", version: 0 },
    ),
  };
}

/**
 * Extract version token from common data structures
 *
 * @param data Entity data with version fields
 * @param entityId Entity identifier
 * @param entityType Entity type
 * @returns Version token or null if not found
 */
export function extractVersionToken(
  data: { updated_at?: string | number; updatedAt?: string | number; version?: number } | null | undefined,
  entityId: string,
  entityType: string,
): VersionToken | null {
  if (!data) return null;

  const updatedAt = data.updated_at || data.updatedAt;
  const sequence = data.version;

  if (!updatedAt) return null;

  return createVersionToken(entityId, entityType, updatedAt, sequence);
}

/**
 * Format a version token for display (debugging)
 */
export function formatVersionToken(token: VersionToken): string {
  return `${token.entityType}:${token.entityId}@${token.version}${token.sequence !== undefined ? `:${token.sequence}` : ""}`;
}
