import { describe, expect, it } from 'vitest';
import { runContributorDiagnostics } from '../lib/contributor-diagnostics';
import { startGuardedRollout, recordRolloutOutcome, emergencyDisable, verifyRolloutDisabled } from '../lib/rollout-guardrails';
import { createPrivacySafeExport } from '../lib/privacy-safe-export';
import { RecoveryCheckpointStore } from '../lib/recovery-checkpoints';

describe('operational controls', () => {
  it('reports contributor environment failures without exposing values', () => {
    const results = runContributorDiagnostics({ nodeVersion: '18.20.0', packageManager: 'npm', requiredEnv: { SECRET: '' }, lockfiles: [''] });
    expect(results.every((result) => !result.detail.includes('SECRET'))).toBe(true);
    expect(results.filter((result) => !result.ok)).toHaveLength(4);
  });

  it('disables a rollout after the configured error budget is exceeded', () => {
    let rollout = startGuardedRollout({ id: 'r1', flag: 'new-flow', roles: ['maintainer'], guardrails: { minSamples: 2, maxErrorRate: 0.5 }, now: '2026-01-01T00:00:00.000Z' });
    rollout = recordRolloutOutcome(rollout, { ok: false, guardrails: { minSamples: 2, maxErrorRate: 0.5 } });
    rollout = recordRolloutOutcome(rollout, { ok: false, guardrails: { minSamples: 2, maxErrorRate: 0.5 } });
    expect(rollout.state).toBe('disabled');
    expect(verifyRolloutDisabled(emergencyDisable(rollout, 'contain failure', ['maintainer']))).toBe(true);
  });

  it('projects only authorized non-sensitive fields', () => {
    const result = createPrivacySafeExport([{ id: '1', amount: 10, walletAddress: 'G...', email: 'x@y.test' }], { actorId: 'u1', ownerId: 'u1', roles: ['user'], fields: ['id', 'amount', 'walletAddress', 'email'] }, '2026-01-01T00:00:00.000Z');
    expect(result.records).toEqual([{ id: '1', amount: 10 }]);
    expect(result.redactedFields).toEqual(['walletAddress', 'email']);
  });

  it('resumes failed external work without duplicating a succeeded step', () => {
    const store = new RecoveryCheckpointStore();
    store.create({ operationId: 'op1', stepId: 'upload', idempotencyKey: 'op1-upload', maxAttempts: 3 });
    store.start('op1', 'upload');
    expect(store.fail('op1', 'upload', 'network timeout').state).toBe('pending');
    store.resume('op1', 'upload');
    const completed = store.succeed('op1', 'upload', 'remote-1');
    expect(store.resume('op1', 'upload')).toEqual(completed);
    expect(completed.state).toBe('succeeded');
  });
});

