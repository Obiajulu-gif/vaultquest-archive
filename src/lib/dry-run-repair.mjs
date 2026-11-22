import { createHash, randomUUID } from "node:crypto";

export const REPAIR_PHASES = [
  "orphaned_actions",
  "stale_pending_events",
  "unresolved_settlements",
];

export const REPAIR_JOB_STATUSES = [
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
];

const PRIVILEGED_ROLES = new Set(["admin", "operator"]);

export class RepairAuthorizationError extends Error {
  constructor(message, code = "REPAIR_UNAUTHORIZED") {
    super(message);
    this.name = "RepairAuthorizationError";
    this.code = code;
    this.statusCode = 403;
  }
}

export class RepairExecutionError extends Error {
  constructor(message, { code = "REPAIR_EXECUTION_FAILED", retryable = false, cause = null } = {}) {
    super(message);
    this.name = "RepairExecutionError";
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * Authorize an actor for dry-run or live repair execution.
 * - `operator` and `admin` may run dry-run repairs.
 * - Live (`dryRun === false`) repairs require `admin` or explicit `repair:execute` scope.
 */
export function authorizeRepairActor(actor, { dryRun = true } = {}) {
  if (!actor || typeof actor.id !== "string" || !actor.id.trim()) {
    throw new RepairAuthorizationError("Authenticated actor is required for repair operations.");
  }

  const role = typeof actor.role === "string" ? actor.role.toLowerCase() : "";
  const scopes = new Set(Array.isArray(actor.scopes) ? actor.scopes : []);

  if (!PRIVILEGED_ROLES.has(role) && !scopes.has("repair:dry-run") && !scopes.has("repair:execute")) {
    throw new RepairAuthorizationError(
      `Actor ${actor.id} with role '${role || "none"}' is not authorized for repair tooling.`,
    );
  }

  if (!dryRun && role !== "admin" && !scopes.has("repair:execute")) {
    throw new RepairAuthorizationError(
      `Actor ${actor.id} requires 'admin' role or 'repair:execute' scope for live repair mutations.`,
    );
  }

  return true;
}

function createEmptyStats() {
  const phaseBreakdown = {};
  for (const phase of REPAIR_PHASES) {
    phaseBreakdown[phase] = { scanned: 0, repaired: 0, failed: 0 };
  }
  return {
    scannedCount: 0,
    repairedCount: 0,
    failedCount: 0,
    phaseBreakdown,
  };
}

/**
 * In-memory checkpoint store (injectable for tests or backed by DB/disk).
 */
export class InMemoryCheckpointStore {
  constructor() {
    this.checkpoints = new Map();
    this.appliedRecords = new Map(); // jobId -> Set<string> for idempotent resume
  }

  async save(checkpoint) {
    const copy = structuredClone(checkpoint);
    this.checkpoints.set(checkpoint.jobId, copy);
    return copy;
  }

  async load(jobId) {
    const found = this.checkpoints.get(jobId);
    return found ? structuredClone(found) : null;
  }

  async markRecordProcessed(jobId, recordKey) {
    let set = this.appliedRecords.get(jobId);
    if (!set) {
      set = new Set();
      this.appliedRecords.set(jobId, set);
    }
    set.add(recordKey);
  }

  async isRecordProcessed(jobId, recordKey) {
    return this.appliedRecords.get(jobId)?.has(recordKey) ?? false;
  }
}

async function withRetries(fn, { maxRetries = 2, isRetryable = (err) => Boolean(err?.retryable) } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      attempt += 1;
    }
  }
}

function getRecordId(phase, record) {
  if (phase === "stale_pending_events") return record.txHash;
  return record.id;
}

function buildPlanAction(phase, record) {
  const recordId = getRecordId(phase, record);
  if (phase === "orphaned_actions") {
    return {
      phase,
      recordId,
      action: "mark_orphaned",
      fromStatus: record.status,
      toStatus: "orphaned",
      reason: "stale_action_exceeded_threshold",
    };
  }
  if (phase === "stale_pending_events") {
    return {
      phase,
      recordId,
      action: "prune_pending_event",
      statusHint: record.statusHint,
      reason: "stale_pending_event_exceeded_threshold",
    };
  }
  return {
    phase,
    recordId,
    action: "mark_settlement_failed",
    fromState: record.state,
    toState: "failed",
    reason: "unresolved_settlement_exceeded_threshold",
  };
}

function computePlanDigest(plannedActions) {
  return createHash("sha256")
    .update(JSON.stringify(plannedActions))
    .digest("hex");
}

/**
 * Start a dry-run or live repair job with per-batch checkpoints.
 */
export async function runRepairJob({
  actor,
  dataSource,
  checkpointStore = new InMemoryCheckpointStore(),
  dryRun = true,
  batchSize = 25,
  phases = [...REPAIR_PHASES],
  olderThanMs = 60_000,
  maxRetries = 2,
  maxBatches = Infinity,
  jobId = randomUUID(),
  now = () => new Date(),
}) {
  authorizeRepairActor(actor, { dryRun });

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RepairExecutionError("batchSize must be an integer between 1 and 500.", {
      code: "INVALID_BATCH_SIZE",
      retryable: false,
    });
  }

  for (const phase of phases) {
    if (!REPAIR_PHASES.includes(phase)) {
      throw new RepairExecutionError(`Unsupported repair phase: ${phase}`, {
        code: "INVALID_REPAIR_PHASE",
        retryable: false,
      });
    }
  }

  const timestamp = now().toISOString();
  const checkpoint = {
    jobId,
    actorId: actor.id,
    phases: [...phases],
    currentPhase: phases[0] ?? "orphaned_actions",
    cursor: null,
    dryRun,
    batchSize,
    status: "running",
    stats: createEmptyStats(),
    plannedActions: [],
    errors: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await checkpointStore.save(checkpoint);

  return executeFromCheckpoint({
    checkpoint,
    dataSource,
    checkpointStore,
    olderThanMs,
    maxRetries,
    maxBatches,
    now,
  });
}

/**
 * Resume an existing paused/failed repair job from its last saved checkpoint.
 */
export async function resumeRepairJob({
  jobId,
  actor,
  dataSource,
  checkpointStore,
  olderThanMs = 60_000,
  maxRetries = 2,
  maxBatches = Infinity,
  now = () => new Date(),
}) {
  const checkpoint = await checkpointStore.load(jobId);
  if (!checkpoint) {
    throw new RepairExecutionError(`Checkpoint not found for job ${jobId}`, {
      code: "CHECKPOINT_NOT_FOUND",
      retryable: false,
    });
  }

  authorizeRepairActor(actor, { dryRun: checkpoint.dryRun });

  if (checkpoint.status === "completed") {
    return {
      checkpoint,
      planDigest: computePlanDigest(checkpoint.plannedActions),
      resumed: false,
    };
  }

  checkpoint.status = "running";
  checkpoint.updatedAt = now().toISOString();
  await checkpointStore.save(checkpoint);

  return executeFromCheckpoint({
    checkpoint,
    dataSource,
    checkpointStore,
    olderThanMs,
    maxRetries,
    maxBatches,
    now,
  });
}

async function fetchPhaseBatch(phase, dataSource, cursor, batchSize, olderThanMs) {
  if (phase === "orphaned_actions") {
    return dataSource.fetchStaleActions(cursor, batchSize, olderThanMs);
  }
  if (phase === "stale_pending_events") {
    return dataSource.fetchStalePendingEvents(cursor, batchSize, olderThanMs);
  }
  return dataSource.fetchUnresolvedSettlements(cursor, batchSize, olderThanMs);
}

async function applyPhaseMutation(phase, dataSource, record) {
  if (phase === "orphaned_actions") {
    return dataSource.repairAction(record.id, "orphaned", "stale_action_exceeded_threshold");
  }
  if (phase === "stale_pending_events") {
    return dataSource.prunePendingEvent(record.txHash);
  }
  return dataSource.repairSettlement(record.id, "failed", "unresolved_settlement_exceeded_threshold");
}

async function executeFromCheckpoint({
  checkpoint,
  dataSource,
  checkpointStore,
  olderThanMs,
  maxRetries,
  maxBatches,
  now,
}) {
  const startPhaseIdx = Math.max(0, checkpoint.phases.indexOf(checkpoint.currentPhase));
  let batchesProcessed = 0;

  for (let pIdx = startPhaseIdx; pIdx < checkpoint.phases.length; pIdx++) {
    const phase = checkpoint.phases[pIdx];
    checkpoint.currentPhase = phase;

    while (batchesProcessed < maxBatches) {
      let batch;
      try {
        batch = await withRetries(
          () => fetchPhaseBatch(phase, dataSource, checkpoint.cursor, checkpoint.batchSize, olderThanMs),
          { maxRetries },
        );
      } catch (err) {
        checkpoint.status = err?.retryable ? "paused" : "failed";
        checkpoint.lastError = err?.message ?? String(err);
        checkpoint.updatedAt = now().toISOString();
        await checkpointStore.save(checkpoint);
        return {
          checkpoint,
          planDigest: computePlanDigest(checkpoint.plannedActions),
          halted: true,
        };
      }

      if (!Array.isArray(batch) || batch.length === 0) {
        checkpoint.cursor = null;
        checkpoint.updatedAt = now().toISOString();
        await checkpointStore.save(checkpoint);
        break;
      }

      for (const record of batch) {
        const recordId = getRecordId(phase, record);
        const recordKey = `${phase}:${recordId}`;

        if (await checkpointStore.isRecordProcessed(checkpoint.jobId, recordKey)) {
          continue;
        }

        checkpoint.stats.scannedCount += 1;
        checkpoint.stats.phaseBreakdown[phase].scanned += 1;

        const plan = buildPlanAction(phase, record);
        if (checkpoint.dryRun) {
          checkpoint.plannedActions.push(plan);
          checkpoint.stats.repairedCount += 1;
          checkpoint.stats.phaseBreakdown[phase].repaired += 1;
          await checkpointStore.markRecordProcessed(checkpoint.jobId, recordKey);
          continue;
        }

        try {
          const applied = await withRetries(
            () => applyPhaseMutation(phase, dataSource, record),
            { maxRetries },
          );
          if (applied) {
            checkpoint.plannedActions.push({ ...plan, applied: true });
            checkpoint.stats.repairedCount += 1;
            checkpoint.stats.phaseBreakdown[phase].repaired += 1;
            await checkpointStore.markRecordProcessed(checkpoint.jobId, recordKey);
          } else {
            checkpoint.stats.failedCount += 1;
            checkpoint.stats.phaseBreakdown[phase].failed += 1;
            checkpoint.errors.push({
              recordId,
              phase,
              message: "Mutation returned false",
              timestamp: now().toISOString(),
            });
          }
        } catch (err) {
          checkpoint.stats.failedCount += 1;
          checkpoint.stats.phaseBreakdown[phase].failed += 1;
          checkpoint.errors.push({
            recordId,
            phase,
            message: err?.message ?? String(err),
            timestamp: now().toISOString(),
          });
          if (err?.retryable) {
            // Pause at the current cursor so a retry/resume picks up from this batch.
            checkpoint.status = "paused";
            checkpoint.lastError = err.message;
            checkpoint.updatedAt = now().toISOString();
            await checkpointStore.save(checkpoint);
            return {
              checkpoint,
              planDigest: computePlanDigest(checkpoint.plannedActions),
              halted: true,
            };
          }
        }
      }

      const lastRecord = batch[batch.length - 1];
      checkpoint.cursor = getRecordId(phase, lastRecord);
      batchesProcessed += 1;
      checkpoint.updatedAt = now().toISOString();
      await checkpointStore.save(checkpoint);

      if (batch.length < checkpoint.batchSize) {
        checkpoint.cursor = null;
        await checkpointStore.save(checkpoint);
        break;
      }

      if (batchesProcessed >= maxBatches) {
        checkpoint.status = "paused";
        checkpoint.updatedAt = now().toISOString();
        await checkpointStore.save(checkpoint);
        return {
          checkpoint,
          planDigest: computePlanDigest(checkpoint.plannedActions),
          halted: false,
        };
      }
    }
  }

  checkpoint.status = "completed";
  checkpoint.completedAt = now().toISOString();
  checkpoint.updatedAt = checkpoint.completedAt;
  await checkpointStore.save(checkpoint);

  return {
    checkpoint,
    planDigest: computePlanDigest(checkpoint.plannedActions),
    halted: false,
  };
}
