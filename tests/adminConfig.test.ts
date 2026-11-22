/**
 * ConfigSchemaValidator tests (#847)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigSchemaValidator, ConfigFieldSchema } from '../services/adminConfig';

const schema: ConfigFieldSchema[] = [
  { key: 'maxVaultSize', label: 'Max Vault Size', type: 'number', required: true, min: 100, max: 100000, description: 'Maximum vault size', riskLevel: 'high' },
  { key: 'drawInterval', label: 'Draw Interval', type: 'duration', required: true, min: 3600, max: 86400, description: 'Seconds between draws', riskLevel: 'high' },
  { key: 'enabled', label: 'Enabled', type: 'boolean', required: true, description: 'Feature toggle', riskLevel: 'medium' },
  { key: 'mode', label: 'Mode', type: 'enum', required: true, enumValues: ['safe', 'fast'], description: 'Operation mode', riskLevel: 'low' },
];

describe('ConfigSchemaValidator', () => {
  let validator: ConfigSchemaValidator;

  beforeEach(() => {
    validator = new ConfigSchemaValidator(schema, {
      maxVaultSize: 1000,
      drawInterval: 86400,
      enabled: true,
      mode: 'safe',
    });
  });

  it('accepts valid config', () => {
    const result = validator.validate({ maxVaultSize: 2000, drawInterval: 3600, enabled: false, mode: 'fast' });
    expect(result.valid).toBe(true);
  });

  it('rejects number below min', () => {
    const result = validator.validate({ maxVaultSize: 50, drawInterval: 3600, enabled: true, mode: 'safe' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at least'))).toBe(true);
  });

  it('rejects number above max', () => {
    const result = validator.validate({ maxVaultSize: 200000, drawInterval: 3600, enabled: true, mode: 'safe' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('at most'))).toBe(true);
  });

  it('rejects invalid enum value', () => {
    const result = validator.validate({ maxVaultSize: 1000, drawInterval: 3600, enabled: true, mode: 'invalid' });
    expect(result.valid).toBe(false);
  });

  it('rejects missing required field', () => {
    const result = validator.validate({ drawInterval: 3600, enabled: true, mode: 'safe' });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('required'))).toBe(true);
  });

  it('generates diff for changed values', () => {
    const diff = validator.generateDiff({ maxVaultSize: 2000, drawInterval: 86400, enabled: true, mode: 'safe' });
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].key).toBe('maxVaultSize');
    expect(diff.changes[0].oldValue).toBe(1000);
    expect(diff.changes[0].newValue).toBe(2000);
  });

  it('applies valid changes with audit log', () => {
    const result = validator.applyChanges({ maxVaultSize: 2000, drawInterval: 86400, enabled: true, mode: 'safe' }, 'admin-1');
    expect(result.applied).toBe(true);
    expect(result.auditEntry.changedBy).toBe('admin-1');
    expect(validator.getConfig().maxVaultSize).toBe(2000);
  });

  it('rejects invalid config on apply', () => {
    expect(() =>
      validator.applyChanges({ maxVaultSize: 50, drawInterval: 86400, enabled: true, mode: 'safe' }, 'admin-1')
    ).toThrow();
  });

  it('tracks audit history', () => {
    validator.applyChanges({ maxVaultSize: 2000, drawInterval: 86400, enabled: true, mode: 'safe' }, 'admin-1');
    validator.applyChanges({ maxVaultSize: 3000, drawInterval: 86400, enabled: true, mode: 'safe' }, 'admin-2');
    expect(validator.getAuditLog()).toHaveLength(2);
  });
});
