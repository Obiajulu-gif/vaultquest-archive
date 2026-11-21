/**
 * Public/private visibility and authorization boundary checks (#851, #1109).
 *
 * Ensures private, restricted, archived, or deleted records are hidden consistently
 * across all access paths (direct lookup, search, export, relationships),
 * while enforcing strict role-based authorization, retry on transient auth/tokens,
 * and immutability guardrails on archived state.
 */

export type Visibility = 'public' | 'private' | 'restricted' | 'deleted' | 'archived';

export interface Record {
  id: string;
  visibility: Visibility;
  ownerId: string;
  data: Record<string, unknown>;
  cachedAt?: number;
  archived?: boolean;
  archivedAt?: number | string | null;
  retentionExpiresAt?: number | string | null;
  redactedAt?: number | string | null;
}

export interface VisibilityContext {
  viewerId: string;
  viewerRole: 'owner' | 'maintainer' | 'admin' | 'public';
  includeDeleted?: boolean;
  includeArchived?: boolean;
  authToken?: string;
  isTokenExpired?: boolean;
}

export class RecordAccessError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'RecordAccessError';
  }
}

/**
 * Check if a record is visible to the viewer based on role and archive/deletion status.
 */
export function isRecordVisible(
  record: Record,
  context: VisibilityContext
): boolean {
  // 1. Deleted records are never visible unless explicitly requested by an admin
  if (record.visibility === 'deleted') {
    return Boolean(context.includeDeleted && context.viewerRole === 'admin');
  }

  // 2. Archived records
  const isArchived = record.visibility === 'archived' || Boolean(record.archived) || Boolean(record.archivedAt);
  if (isArchived) {
    // If restricted/maintainer archive and caller does not request includeArchived
    if (record.visibility === 'restricted' && !context.includeArchived) {
      return false;
    }
    // If private archive, only owner and admin can view
    if (record.visibility === 'private') {
      return record.ownerId === context.viewerId || context.viewerRole === 'admin';
    }
    // If restricted archive, only maintainer, admin, or owner can view
    if (record.visibility === 'restricted') {
      return context.viewerRole === 'maintainer' || context.viewerRole === 'admin' || record.ownerId === context.viewerId;
    }
    // Public archived records are readable by anyone
    return true;
  }

  // 3. Public records are visible to everyone
  if (record.visibility === 'public') {
    return true;
  }

  // 4. Private records are visible only to owner and admins (hidden to all others)
  if (record.visibility === 'private') {
    return record.ownerId === context.viewerId || context.viewerRole === 'admin';
  }

  // 5. Restricted records are visible to maintainers, admins, or owner
  if (record.visibility === 'restricted') {
    return context.viewerRole === 'maintainer' ||
           context.viewerRole === 'admin' ||
           record.ownerId === context.viewerId;
  }

  return false;
}

/**
 * Filter a list of records by visibility.
 */
export function filterVisibleRecords(
  records: Record[],
  context: VisibilityContext
): Record[] {
  return records.filter((record) => isRecordVisible(record, context));
}

/**
 * Enforce authorization on direct record access.
 * Throws 404 (NOT_FOUND) for private/deleted records to prevent metadata enumeration.
 * Throws 403 (FORBIDDEN) when access to known restricted resources is denied.
 * Throws 409 (ILLEGAL_TRANSITION) when attempting mutation on archived or immutable records.
 */
export function assertRecordAccess(
  record: Record,
  context: VisibilityContext,
  action: 'read' | 'mutate' = 'read'
): Record {
  if (context.isTokenExpired) {
    throw new RecordAccessError('Authentication token expired; refresh required', 401, 'TOKEN_EXPIRED', true);
  }

  const visible = isRecordVisible(record, context);
  if (!visible) {
    if (record.visibility === 'restricted') {
      throw new RecordAccessError('Access forbidden to restricted record', 403, 'FORBIDDEN', false);
    }
    // Conceal private and deleted records with 404 to avoid information leakage
    throw new RecordAccessError('Record not found', 404, 'NOT_FOUND', false);
  }

  if (action === 'mutate') {
    const isArchived = record.visibility === 'archived' || Boolean(record.archived) || Boolean(record.archivedAt);
    if (isArchived) {
      throw new RecordAccessError('Cannot mutate archived or immutable record', 409, 'ILLEGAL_TRANSITION', false);
    }
    if (record.visibility === 'deleted') {
      throw new RecordAccessError('Cannot mutate deleted record', 409, 'ILLEGAL_TRANSITION', false);
    }
    // Only owner, maintainer, or admin can mutate
    const canMutate = record.ownerId === context.viewerId || context.viewerRole === 'maintainer' || context.viewerRole === 'admin';
    if (!canMutate) {
      throw new RecordAccessError('Unauthorized to mutate this record', 403, 'FORBIDDEN', false);
    }
  }

  return record;
}

export interface FetchWithRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  refreshToken?: () => Promise<string>;
}

/**
 * Executes a record retrieval with automatic retry on transient network or expired token failures.
 */
export async function fetchRecordWithRetry(
  fetcher: (ctx: VisibilityContext) => Promise<Record | null>,
  context: VisibilityContext,
  options: FetchWithRetryOptions = {}
): Promise<{ record: Record | null; attempts: number }> {
  const maxRetries = options.maxRetries ?? 3;
  let attempts = 0;
  let currentContext = { ...context };

  while (attempts < maxRetries) {
    attempts++;
    try {
      if (currentContext.isTokenExpired && options.refreshToken) {
        const newToken = await options.refreshToken();
        currentContext = { ...currentContext, authToken: newToken, isTokenExpired: false };
      }
      const record = await fetcher(currentContext);
      return { record, attempts };
    } catch (err: any) {
      const isRetryable = err instanceof RecordAccessError ? err.retryable : (err.code === 'ECONNRESET' || err.status === 429);
      if (attempts >= maxRetries || !isRetryable) {
        throw err;
      }
      if (err instanceof RecordAccessError && err.code === 'TOKEN_EXPIRED' && options.refreshToken) {
        const newToken = await options.refreshToken();
        currentContext = { ...currentContext, authToken: newToken, isTokenExpired: false };
      }
      if (options.initialDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.initialDelayMs! * attempts));
      }
    }
  }

  throw new RecordAccessError('Failed to fetch record after maximum retry attempts', 504, 'GATEWAY_TIMEOUT', false);
}

/**
 * Check visibility consistency across multiple access paths.
 */
export function checkVisibilityConsistency(
  directLookup: Record | null,
  searchResults: Record[],
  exportData: Record[],
  relatedRecords: Record[],
  context: VisibilityContext
): { consistent: boolean; issues: string[] } {
  const issues: string[] = [];

  // Check direct lookup
  if (directLookup && !isRecordVisible(directLookup, context)) {
    issues.push(`Direct lookup exposed invisible record ${directLookup.id}`);
  }

  // Check search results
  for (const record of searchResults) {
    if (!isRecordVisible(record, context)) {
      issues.push(`Search exposed invisible record ${record.id}`);
    }
  }

  // Check export data
  for (const record of exportData) {
    if (!isRecordVisible(record, context)) {
      issues.push(`Export exposed invisible record ${record.id}`);
    }
  }

  // Check related records
  for (const record of relatedRecords) {
    if (!isRecordVisible(record, context)) {
      issues.push(`Related records exposed invisible record ${record.id}`);
    }
  }

  return {
    consistent: issues.length === 0,
    issues,
  };
}
