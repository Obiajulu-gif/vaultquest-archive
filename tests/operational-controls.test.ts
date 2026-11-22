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

  it('evaluates normal, failure, retry, and authorization paths for dependency diagnostics', () => {
    // 1. Normal path
    const normalResults = runContributorDiagnostics({
      nodeVersion: '20.10.0',
      packageManager: 'pnpm',
      dependencies: [{ name: 'vitest', status: 'installed' }],
    });
    const vitestCheck = normalResults.find((r) => r.name === 'dependency:vitest');
    expect(vitestCheck?.ok).toBe(true);
    expect(vitestCheck?.detail).toBe('installed');

    // 2. Failure path with retries available
    const retryResults = runContributorDiagnostics({
      nodeVersion: '20.10.0',
      packageManager: 'pnpm',
      dependencies: [{ name: 'soroban-cli', status: 'failed', retryAttempts: 1, maxRetries: 3 }],
    });
    const sorobanCheck = retryResults.find((r) => r.name === 'dependency:soroban-cli');
    expect(sorobanCheck?.ok).toBe(false);
    expect(sorobanCheck?.retryable).toBe(true);
    expect(sorobanCheck?.remediation).toContain('Retry dependency resolution');

    // 3. Failure path with retries exhausted (rollback path)
    const exhaustedResults = runContributorDiagnostics({
      nodeVersion: '20.10.0',
      packageManager: 'pnpm',
      dependencies: [{ name: 'prisma-client', status: 'failed', retryAttempts: 3, maxRetries: 3 }],
    });
    const prismaCheck = exhaustedResults.find((r) => r.name === 'dependency:prisma-client');
    expect(prismaCheck?.ok).toBe(false);
    expect(prismaCheck?.retryable).toBe(false);
    expect(prismaCheck?.remediation).toContain('Roll back');

    // 4. Authorization path (unauthorized role)
    const unauthorizedResults = runContributorDiagnostics({
      nodeVersion: '20.10.0',
      packageManager: 'pnpm',
      actorRoles: ['contributor'],
      dependencies: [{ name: 'production-secret-store', status: 'installed', requiredRole: 'maintainer' }],
    });
    const authCheck = unauthorizedResults.find((r) => r.name === 'dependency:production-secret-store');
    expect(authCheck?.ok).toBe(false);
    expect(authCheck?.authorized).toBe(false);
    expect(authCheck?.detail).toBe('unauthorized');

    // 5. Authorization path (authorized role)
    const authorizedResults = runContributorDiagnostics({
      nodeVersion: '20.10.0',
      packageManager: 'pnpm',
      actorRoles: ['maintainer'],
      dependencies: [{ name: 'production-secret-store', status: 'installed', requiredRole: 'maintainer' }],
    });
    const authSuccess = authorizedResults.find((r) => r.name === 'dependency:production-secret-store');
    expect(authSuccess?.ok).toBe(true);
    expect(authSuccess?.authorized).toBe(true);
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
