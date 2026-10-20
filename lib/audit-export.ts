/**
 * Audit export with redaction profiles (#849).
 *
 * Deterministic audit export with configurable redaction profiles so
 * maintainers can share evidence without exposing private data.
 */

export type RedactionProfile = 'full' | 'redacted' | 'minimal';

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
}

export interface ExportOptions {
  profile: RedactionProfile;
  actorRole: 'maintainer' | 'admin' | 'viewer';
  purpose: 'internal' | 'external' | 'regulatory';
  schemaVersion: string;
}

export interface ExportedRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  verificationHash: string;
}

const SENSITIVE_FIELDS = ['ipAddress', 'userAgent', 'sessionId', 'email', 'phone', 'address'];

/**
 * Apply redaction profile to a record.
 */
function redactRecord(record: AuditRecord, profile: RedactionProfile): Record<string, unknown> {
  const redacted: Record<string, unknown> = {
    id: record.id,
    timestamp: record.timestamp,
    actor: record.actor,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    metadata: { ...record.metadata },
  };

  if (profile === 'minimal') {
    // Only keep essential fields
    delete redacted.metadata;
    return redacted;
  }

  if (profile === 'redacted') {
    // Remove sensitive fields from metadata
    for (const field of SENSITIVE_FIELDS) {
      delete (redacted.metadata as Record<string, unknown>)[field];
      if (redacted[field]) {
        redacted[field] = '[REDACTED]';
      }
    }
    return redacted;
  }

  // full profile - include everything
  return {
    ...redacted,
    ipAddress: record.ipAddress,
    userAgent: record.userAgent,
    sessionId: record.sessionId,
  };
}

/**
 * Generate verification hash for exported record.
 */
function generateVerificationHash(record: Record<string, unknown>): string {
  const str = JSON.stringify(record, Object.keys(record).sort());
  // Simple hash for demonstration - use crypto in production
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Export audit records with redaction profile.
 */
export function exportAuditRecords(
  records: AuditRecord[],
  options: ExportOptions
): ExportedRecord[] {
  // Check authorization
  if (options.actorRole === 'viewer' && options.profile === 'full') {
    throw new Error('Viewers cannot request full exports');
  }

  return records.map((record) => {
    const redacted = redactRecord(record, options.profile);
    return {
      ...(redacted as unknown as ExportedRecord),
      verificationHash: generateVerificationHash(redacted),
    };
  });
}

/**
 * Get export schema version info.
 */
export function getExportSchemaVersion(): string {
  return '1.0.0';
}
