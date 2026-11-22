import { hasPermission, type Role } from './rbac';

export type RolloutState = 'active' | 'disabled' | 'completed';
export interface RolloutGuardrails { minSamples: number; maxErrorRate: number; }
export interface RolloutRecord {
  id: string; flag: string; state: RolloutState; previousValue: boolean; value: boolean;
  samples: number; failures: number; reason?: string; updatedAt: string;
}

function assertOperator(roles: readonly Role[] | undefined): void {
  if (!hasPermission(roles, 'admin.flags.write')) throw new Error('Feature rollout requires admin.flags.write.');
}

export function startGuardedRollout(input: { id: string; flag: string; previousValue?: boolean; guardrails?: Partial<RolloutGuardrails>; roles?: readonly Role[]; now?: string }): RolloutRecord {
  assertOperator(input.roles);
  const guardrails = { minSamples: input.guardrails?.minSamples ?? 10, maxErrorRate: input.guardrails?.maxErrorRate ?? 0.05 };
  if (!Number.isSafeInteger(guardrails.minSamples) || guardrails.minSamples < 1 || guardrails.maxErrorRate < 0 || guardrails.maxErrorRate > 1) throw new Error('Invalid rollout guardrails.');
  return { id: input.id, flag: input.flag, state: 'active', previousValue: input.previousValue ?? false, value: true, samples: 0, failures: 0, updatedAt: input.now ?? new Date().toISOString() };
}

export function recordRolloutOutcome(record: RolloutRecord, outcome: { ok: boolean; guardrails?: RolloutGuardrails; now?: string }): RolloutRecord {
  if (record.state !== 'active') return { ...record };
  const samples = record.samples + 1;
  const failures = record.failures + (outcome.ok ? 0 : 1);
  const guardrails = outcome.guardrails ?? { minSamples: 10, maxErrorRate: 0.05 };
  const breached = samples >= guardrails.minSamples && failures / samples > guardrails.maxErrorRate;
  return { ...record, samples, failures, state: breached ? 'disabled' : 'active', value: !breached, reason: breached ? 'error-rate-guardrail-breached' : record.reason, updatedAt: outcome.now ?? new Date().toISOString() };
}

export function emergencyDisable(record: RolloutRecord, reason: string, roles: readonly Role[] | undefined, now?: string): RolloutRecord {
  assertOperator(roles);
  if (!reason.trim()) throw new Error('Emergency disablement requires a reason.');
  return { ...record, state: 'disabled', value: record.previousValue, reason: reason.trim(), updatedAt: now ?? new Date().toISOString() };
}

export function verifyRolloutDisabled(record: RolloutRecord): boolean { return record.state === 'disabled' && record.value === record.previousValue; }

