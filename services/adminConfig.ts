/**
 * Schema-Driven Admin Config Forms (#847)
 *
 * Validates high-risk configuration changes through a schema, provides
 * diff preview before saving, and audits every change with before/after data.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'enum' | 'duration';

export interface ConfigFieldSchema {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  min?: number;
  max?: number;
  enumValues?: string[];
  description: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ConfigChange {
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface ConfigDiff {
  changes: ConfigChange[];
  isValid: boolean;
  errors: string[];
}

export interface AuditEntry {
  id: string;
  changedBy: string;
  timestamp: number;
  changes: ConfigChange[];
  applied: boolean;
}

/**
 * ConfigSchemaValidator validates configuration against a schema,
 * generates diffs, and tracks audit history.
 */
export class ConfigSchemaValidator {
  private schema: ConfigFieldSchema[];
  private currentConfig: Record<string, unknown>;
  private auditLog: AuditEntry[] = [];

  constructor(schema: ConfigFieldSchema[], initialConfig: Record<string, unknown>) {
    this.schema = schema;
    this.currentConfig = { ...initialConfig };
  }

  /**
   * Validate a proposed configuration change against the schema.
   */
  validate(proposed: Record<string, unknown>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const field of this.schema) {
      const value = proposed[field.key];

      if (field.required && (value === undefined || value === null)) {
        errors.push(`${field.label} is required`);
        continue;
      }
      if (value === undefined || value === null) continue;

      switch (field.type) {
        case 'number':
        case 'duration':
          if (typeof value !== 'number' || Number.isNaN(value)) {
            errors.push(`${field.label} must be a number`);
          } else {
            if (field.min !== undefined && value < field.min) {
              errors.push(`${field.label} must be at least ${field.min}`);
            }
            if (field.max !== undefined && value > field.max) {
              errors.push(`${field.label} must be at most ${field.max}`);
            }
          }
          break;
        case 'boolean':
          if (typeof value !== 'boolean') {
            errors.push(`${field.label} must be true or false`);
          }
          break;
        case 'enum':
          if (!field.enumValues?.includes(String(value))) {
            errors.push(`${field.label} must be one of: ${field.enumValues?.join(', ')}`);
          }
          break;
        case 'string':
          if (typeof value !== 'string') {
            errors.push(`${field.label} must be a string`);
          }
          break;
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Generate a diff between current and proposed config.
   */
  generateDiff(proposed: Record<string, unknown>): ConfigDiff {
    const changes: ConfigChange[] = [];
    const errors: string[] = [];

    for (const field of this.schema) {
      const oldVal = this.currentConfig[field.key];
      const newVal = proposed[field.key];
      if (oldVal !== newVal) {
        changes.push({ key: field.key, oldValue: oldVal, newValue: newVal });
      }
    }

    const validation = this.validate(proposed);
    errors.push(...validation.errors);

    return { changes, isValid: validation.isValid, errors };
  }

  /**
   * Apply a validated config change with audit logging.
   * Throws if the config is invalid.
   */
  applyChanges(
    proposed: Record<string, unknown>,
    changedBy: string
  ): { applied: boolean; diff: ConfigDiff; auditEntry: AuditEntry } {
    const diff = this.generateDiff(proposed);

    if (!diff.isValid) {
      throw new Error(`Invalid config: ${diff.errors.join('; ')}`);
    }

    const before = { ...this.currentConfig };
    this.currentConfig = { ...this.currentConfig, ...proposed };

    const auditEntry: AuditEntry = {
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      changedBy,
      timestamp: Date.now(),
      changes: diff.changes.map(c => ({ ...c })),
      applied: true,
    };
    this.auditLog.push(auditEntry);

    return { applied: true, diff, auditEntry };
  }

  /**
   * Get the current config.
   */
  getConfig(): Record<string, unknown> {
    return { ...this.currentConfig };
  }

  /**
   * Get the schema.
   */
  getSchema(): ConfigFieldSchema[] {
    return [...this.schema];
  }

  /**
   * Get the audit log.
   */
  getAuditLog(): AuditEntry[] {
    return [...this.auditLog];
  }
}
