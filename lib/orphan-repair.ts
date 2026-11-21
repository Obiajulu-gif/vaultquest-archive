import { promises as fs } from 'fs';
import path from 'path';

export type OrphanEntityType = 'deposit' | 'ticket' | 'reward' | 'session';
export type RepairAction = 'relink' | 'quarantine' | 'purge';
export type RepairRunStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'rolled_back';

export type RepairActorRole = 'admin' | 'operator' | 'auditor' | 'viewer';

export interface OrphanRepairActor {
  id: string;
  role: RepairActorRole;
  permissions?: string[];
}

export interface OrphanRecord {
  id: string;
  entityType: OrphanEntityType;
  parentId: string;
  detectedAt: string;
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface FailedRecordEntry {
  attempts: number;
  lastError: string;
  deadLettered: boolean;
  updatedAt: string;
}

export interface RollbackLogEntry {
  recordId: string;
  action: RepairAction;
  previousState: unknown;
  appliedAt: string;
  rolledBackAt?: string;
}

export interface OrphanRepairCheckpoint {
  version: 1;
  runId: string;
  status: RepairRunStatus;
  cursor: number;
  totalRecords: number;
  batchSize: number;
  maxRetries: number;
  dryRun: boolean;
  actorId: string;
  startedAt: string;
  updatedAt: string;
  completedIds: string[];
  failedRecords: Record<string, FailedRecordEntry>;
  rollbackLog: RollbackLogEntry[];
}

export interface CheckpointStore {
  load(runId: string): Promise<OrphanRepairCheckpoint | null>;
  save(checkpoint: OrphanRepairCheckpoint): Promise<void>;
}

export interface RepairRecordContext {
  dryRun: boolean;
  attempt: number;
  idempotencyKey: string;
}

export interface RepairRecordResult {
  action: RepairAction;
  previousState: unknown;
}

export interface OrphanRepairAdapter {
  listOrphans(): Promise<OrphanRecord[]>;
  repairRecord(
    record: OrphanRecord,
    context: RepairRecordContext
  ): Promise<RepairRecordResult>;
  rollbackRecord?(entry: RollbackLogEntry): Promise<void>;
}

export interface RunOrphanRepairOptions {
  runId: string;
  actor: OrphanRepairActor;
  adapter: OrphanRepairAdapter;
  checkpointStore: CheckpointStore;
  batchSize?: number;
  maxRetries?: number;
  dryRun?: boolean;
  resume?: boolean;
  retryDeadLettered?: boolean;
  stopOnFailure?: boolean;
  retryDelayMs?: number;
  signal?: AbortSignal;
  now?: () => string;
}

export interface OrphanRepairReport {
  runId: string;
  status: RepairRunStatus;
  resumed: boolean;
  dryRun: boolean;
  totalRecords: number;
  processedInThisRun: number;
  skippedAlreadyCompleted: number;
  succeededTotal: number;
  failedTotal: number;
  deadLetteredTotal: number;
  checkpoint: OrphanRepairCheckpoint;
}

export interface RollbackOrphanRepairOptions {
  runId: string;
  actor: OrphanRepairActor;
  adapter: OrphanRepairAdapter;
  checkpointStore: CheckpointStore;
  now?: () => string;
}

export interface RollbackOrphanRepairReport {
  runId: string;
  status: RepairRunStatus;
  rolledBackCount: number;
  checkpoint: OrphanRepairCheckpoint;
}

export class OrphanRepairAuthorizationError extends Error {
  readonly code = 'UNAUTHORIZED';
  constructor(message: string) {
    super(message);
    this.name = 'OrphanRepairAuthorizationError';
  }
}

export class OrphanRepairCheckpointError extends Error {
  readonly code = 'CHECKPOINT_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'OrphanRepairCheckpointError';
  }
}

const MUTATION_ROLES = new Set<RepairActorRole>(['admin', 'operator']);
const DRY_RUN_ROLES = new Set<RepairActorRole>(['admin', 'operator', 'auditor']);

export function authorizeOrphanRepair(
  actor: OrphanRepairActor,
  mode: 'mutate' | 'dry_run' | 'rollback'
): void {
  if (!actor || !actor.id || !actor.id.trim()) {
    throw new OrphanRepairAuthorizationError('Actor id is required.');
  }

  const perms = new Set(actor.permissions ?? []);
  if (mode === 'dry_run') {
    if (DRY_RUN_ROLES.has(actor.role) || perms.has('orphan:read') || perms.has('orphan:repair')) {
      return;
    }
    throw new OrphanRepairAuthorizationError(
      `Actor ${actor.id} with role '${actor.role}' is not authorized to run orphan-repair dry-run.`
    );
  }

  const requiredPerm = mode === 'rollback' ? 'orphan:rollback' : 'orphan:repair';
  if (MUTATION_ROLES.has(actor.role) || perms.has(requiredPerm)) {
    return;
  }

  throw new OrphanRepairAuthorizationError(
    `Actor ${actor.id} with role '${actor.role}' is not authorized to execute orphan-repair ${mode}.`
  );
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly store = new Map<string, OrphanRepairCheckpoint>();

  async load(runId: string): Promise<OrphanRepairCheckpoint | null> {
    const existing = this.store.get(runId);
    return existing ? structuredClone(existing) : null;
  }

  async save(checkpoint: OrphanRepairCheckpoint): Promise<void> {
    this.store.set(checkpoint.runId, structuredClone(checkpoint));
  }
}

export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly filePath: string) {}

  async load(runId: string): Promise<OrphanRepairCheckpoint | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as OrphanRepairCheckpoint;
      if (!parsed || parsed.version !== 1 || typeof parsed.runId !== 'string') {
        throw new OrphanRepairCheckpointError(
          `Checkpoint file ${this.filePath} has invalid schema.`
        );
      }
      if (parsed.runId !== runId) {
        throw new OrphanRepairCheckpointError(
          `Checkpoint file runId '${parsed.runId}' does not match requested runId '${runId}'.`
        );
      }
      return parsed;
    } catch (err: unknown) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === 'ENOENT'
      ) {
        return null;
      }
      if (err instanceof OrphanRepairCheckpointError) {
        throw err;
      }
      throw new OrphanRepairCheckpointError(
        `Failed to load checkpoint from ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async save(checkpoint: OrphanRepairCheckpoint): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runOrphanRepair(
  options: RunOrphanRepairOptions
): Promise<OrphanRepairReport> {
  const {
    runId,
    actor,
    adapter,
    checkpointStore,
    batchSize = 10,
    maxRetries = 3,
    dryRun = false,
    resume = false,
    retryDeadLettered = false,
    stopOnFailure = false,
    retryDelayMs = 0,
    signal,
    now = () => new Date().toISOString(),
  } = options;

  if (!runId || !runId.trim()) {
    throw new OrphanRepairCheckpointError('runId is required.');
  }
  if (batchSize < 1 || !Number.isInteger(batchSize)) {
    throw new OrphanRepairCheckpointError('batchSize must be a positive integer.');
  }
  if (maxRetries < 1 || !Number.isInteger(maxRetries)) {
    throw new OrphanRepairCheckpointError('maxRetries must be a positive integer.');
  }

  authorizeOrphanRepair(actor, dryRun ? 'dry_run' : 'mutate');

  const existing = await checkpointStore.load(runId);
  if (resume && !existing) {
    throw new OrphanRepairCheckpointError(
      `Cannot resume run '${runId}': no checkpoint found.`
    );
  }
  if (!resume && existing && existing.status !== 'completed') {
    throw new OrphanRepairCheckpointError(
      `Checkpoint already exists for run '${runId}' (status: ${existing.status}). Pass resume=true to continue.`
    );
  }

  const rawOrphans = await adapter.listOrphans();
  const orphans = [...rawOrphans].sort((a, b) => a.id.localeCompare(b.id));

  const timestamp = now();
  const checkpoint: OrphanRepairCheckpoint = existing
    ? {
        ...existing,
        status: 'running',
        totalRecords: orphans.length,
        updatedAt: timestamp,
      }
    : {
        version: 1,
        runId,
        status: 'running',
        cursor: 0,
        totalRecords: orphans.length,
        batchSize,
        maxRetries,
        dryRun,
        actorId: actor.id,
        startedAt: timestamp,
        updatedAt: timestamp,
        completedIds: [],
        failedRecords: {},
        rollbackLog: [],
      };

  const completedSet = new Set(checkpoint.completedIds);
  let processedInThisRun = 0;
  let skippedAlreadyCompleted = 0;
  let aborted = false;
  let haltedOnFailure = false;

  await checkpointStore.save(checkpoint);

  for (let i = 0; i < orphans.length; i += batchSize) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }

    const batch = orphans.slice(i, i + batchSize);
    for (let j = 0; j < batch.length; j += 1) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }

      const record = batch[j];
      const globalIndex = i + j;

      if (completedSet.has(record.id)) {
        skippedAlreadyCompleted += 1;
        checkpoint.cursor = Math.max(checkpoint.cursor, globalIndex + 1);
        continue;
      }

      const prevFailure = checkpoint.failedRecords[record.id];
      if (prevFailure?.deadLettered && !retryDeadLettered) {
        checkpoint.cursor = Math.max(checkpoint.cursor, globalIndex + 1);
        continue;
      }

      const idempotencyKey = `orphan-repair:${runId}:${record.id}`;
      let succeeded = false;
      let attempts = prevFailure && !retryDeadLettered ? prevFailure.attempts : 0;
      let lastError = '';

      while (attempts < maxRetries) {
        attempts += 1;
        try {
          const result = await adapter.repairRecord(record, {
            dryRun: checkpoint.dryRun,
            attempt: attempts,
            idempotencyKey,
          });
          completedSet.add(record.id);
          checkpoint.completedIds.push(record.id);
          delete checkpoint.failedRecords[record.id];
          if (!checkpoint.dryRun) {
            checkpoint.rollbackLog.push({
              recordId: record.id,
              action: result.action,
              previousState: result.previousState,
              appliedAt: now(),
            });
          }
          succeeded = true;
          break;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempts < maxRetries && retryDelayMs > 0) {
            await sleep(retryDelayMs * attempts);
          }
        }
      }

      processedInThisRun += 1;
      checkpoint.cursor = Math.max(checkpoint.cursor, globalIndex + 1);
      checkpoint.updatedAt = now();

      if (!succeeded) {
        checkpoint.failedRecords[record.id] = {
          attempts,
          lastError: lastError.slice(0, 500),
          deadLettered: attempts >= maxRetries,
          updatedAt: checkpoint.updatedAt,
        };
        if (stopOnFailure) {
          haltedOnFailure = true;
          break;
        }
      }
    }

    checkpoint.updatedAt = now();
    await checkpointStore.save(checkpoint);

    if (aborted || haltedOnFailure) {
      break;
    }
  }

  const failedEntries = Object.values(checkpoint.failedRecords);
  const deadLetteredTotal = failedEntries.filter((e) => e.deadLettered).length;

  if (aborted || haltedOnFailure) {
    checkpoint.status = 'paused';
  } else if (failedEntries.length > 0) {
    checkpoint.status = 'failed';
  } else {
    checkpoint.status = 'completed';
  }

  checkpoint.updatedAt = now();
  await checkpointStore.save(checkpoint);

  return {
    runId,
    status: checkpoint.status,
    resumed: Boolean(existing),
    dryRun: checkpoint.dryRun,
    totalRecords: orphans.length,
    processedInThisRun,
    skippedAlreadyCompleted,
    succeededTotal: checkpoint.completedIds.length,
    failedTotal: failedEntries.length,
    deadLetteredTotal,
    checkpoint,
  };
}

export async function rollbackOrphanRepair(
  options: RollbackOrphanRepairOptions
): Promise<RollbackOrphanRepairReport> {
  const {
    runId,
    actor,
    adapter,
    checkpointStore,
    now = () => new Date().toISOString(),
  } = options;

  authorizeOrphanRepair(actor, 'rollback');

  const checkpoint = await checkpointStore.load(runId);
  if (!checkpoint) {
    throw new OrphanRepairCheckpointError(
      `Cannot rollback run '${runId}': no checkpoint found.`
    );
  }
  if (!adapter.rollbackRecord) {
    throw new OrphanRepairCheckpointError(
      'Adapter does not implement rollbackRecord.'
    );
  }

  let rolledBackCount = 0;
  for (let i = checkpoint.rollbackLog.length - 1; i >= 0; i -= 1) {
    const entry = checkpoint.rollbackLog[i];
    if (entry.rolledBackAt) {
      continue;
    }
    await adapter.rollbackRecord(entry);
    entry.rolledBackAt = now();
    rolledBackCount += 1;
    checkpoint.updatedAt = now();
    await checkpointStore.save(checkpoint);
  }

  checkpoint.status = 'rolled_back';
  checkpoint.updatedAt = now();
  await checkpointStore.save(checkpoint);

  return {
    runId,
    status: checkpoint.status,
    rolledBackCount,
    checkpoint,
  };
}
