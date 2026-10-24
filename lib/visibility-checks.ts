/**
 * Public/private visibility boundary consistency checks (#851).
 *
 * Ensures private, restricted, or deleted records are hidden consistently
 * across all access paths (direct lookup, search, export, relationships).
 */

export type Visibility = 'public' | 'private' | 'restricted' | 'deleted';

export interface Record {
  id: string;
  visibility: Visibility;
  ownerId: string;
  data: Record<string, unknown>;
  cachedAt?: number;
}

export interface VisibilityContext {
  viewerId: string;
  viewerRole: 'owner' | 'maintainer' | 'admin' | 'public';
  includeDeleted: boolean;
}

/**
 * Check if a record is visible to the viewer.
 */
export function isRecordVisible(
  record: Record,
  context: VisibilityContext
): boolean {
  // Deleted records are never visible unless explicitly requested
  if (record.visibility === 'deleted' && !context.includeDeleted) {
    return false;
  }

  // Public records are visible to everyone
  if (record.visibility === 'public') {
    return true;
  }

  // Private records are visible to owner and admins
  if (record.visibility === 'private') {
    return record.ownerId === context.viewerId ||
           context.viewerRole === 'admin';
  }

  // Restricted records are visible to maintainers and admins
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
