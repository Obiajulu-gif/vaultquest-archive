export type CheckpointState = 'pending' | 'in_flight' | 'succeeded' | 'failed' | 'compensated';
export interface RecoveryCheckpoint { operationId: string; stepId: string; idempotencyKey: string; state: CheckpointState; attempts: number; maxAttempts: number; externalReference?: string; lastError?: string; updatedAt: string; }

export class RecoveryCheckpointStore {
  private readonly records = new Map<string, RecoveryCheckpoint>();
  create(input: { operationId: string; stepId: string; idempotencyKey: string; maxAttempts?: number; now?: string }): RecoveryCheckpoint {
    const key = `${input.operationId}:${input.stepId}`;
    const existing = this.records.get(key);
    if (existing) return { ...existing };
    if (!input.operationId || !input.stepId || !input.idempotencyKey) throw new Error('Checkpoint identity is required.');
    const record: RecoveryCheckpoint = { operationId: input.operationId, stepId: input.stepId, idempotencyKey: input.idempotencyKey, state: 'pending', attempts: 0, maxAttempts: input.maxAttempts ?? 3, updatedAt: input.now ?? new Date().toISOString() };
    this.records.set(key, record); return { ...record };
  }
  start(operationId: string, stepId: string, now?: string): RecoveryCheckpoint { return this.transition(operationId, stepId, 'in_flight', now); }
  succeed(operationId: string, stepId: string, externalReference?: string, now?: string): RecoveryCheckpoint { const item = this.transition(operationId, stepId, 'succeeded', now); return this.save({ ...item, externalReference }); }
  fail(operationId: string, stepId: string, error: string, now?: string): RecoveryCheckpoint { const item = this.get(operationId, stepId); const attempts = item.attempts + 1; return this.save({ ...item, attempts, state: attempts >= item.maxAttempts ? 'failed' : 'pending', lastError: error.slice(0, 500), updatedAt: now ?? new Date().toISOString() }); }
  resume(operationId: string, stepId: string, now?: string): RecoveryCheckpoint { const item = this.get(operationId, stepId); if (item.state === 'succeeded') return { ...item }; if (item.attempts >= item.maxAttempts) throw new Error('Checkpoint retry limit reached.'); return this.start(operationId, stepId, now); }
  get(operationId: string, stepId: string): RecoveryCheckpoint { const item = this.records.get(`${operationId}:${stepId}`); if (!item) throw new Error('Recovery checkpoint not found.'); return { ...item }; }
  private transition(operationId: string, stepId: string, state: CheckpointState, now?: string): RecoveryCheckpoint { const item = this.get(operationId, stepId); if (item.state === 'succeeded' && state !== 'succeeded') return item; return this.save({ ...item, state, attempts: state === 'in_flight' ? item.attempts + 1 : item.attempts, updatedAt: now ?? new Date().toISOString() }); }
  private save(item: RecoveryCheckpoint): RecoveryCheckpoint { this.records.set(`${item.operationId}:${item.stepId}`, item); return { ...item }; }
}

