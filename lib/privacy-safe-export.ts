import { hasPermission, type Role } from './rbac';

export interface ExportRequest { actorId: string; roles: readonly Role[]; ownerId?: string; fields: readonly string[]; }
export interface PrivacySafeExport { schema: 'vaultquest.privacy-export.v1'; generatedAt: string; fields: string[]; records: Record<string, unknown>[]; redactedFields: string[]; }

const SAFE_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'status', 'asset', 'amount', 'network', 'description']);
const SENSITIVE_FIELDS = new Set(['walletAddress', 'email', 'phone', 'secret', 'token', 'privateKey', 'kycDocument']);

export function createPrivacySafeExport(records: readonly Record<string, unknown>[], request: ExportRequest, now = new Date().toISOString()): PrivacySafeExport {
  const admin = hasPermission(request.roles, 'admin.export.any');
  const own = hasPermission(request.roles, 'own.data.export') && (!request.ownerId || request.ownerId === request.actorId);
  if (!admin && !own) throw new Error('Export is not authorized for this actor.');
  const fields = [...new Set(request.fields)].filter((field) => SAFE_FIELDS.has(field) && !SENSITIVE_FIELDS.has(field));
  if (fields.length === 0) throw new Error('At least one non-sensitive export field is required.');
  const redactedFields = [...new Set(request.fields)].filter((field) => !fields.includes(field));
  return { schema: 'vaultquest.privacy-export.v1', generatedAt: now, fields, redactedFields, records: records.map((record) => Object.fromEntries(fields.map((field) => [field, record[field]]))) };
}

