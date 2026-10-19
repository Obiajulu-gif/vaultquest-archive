import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createLogger } from "../logger.js";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";

const logger = createLogger(process.env.LOG_LEVEL ?? "silent");

// ─── Types & Interfaces ──────────────────────────────────────────────────────

export const REPAIR_PHASES = [
  "orphaned_actions",
  "stale_pending_events",
  "unresolved_settlements"
] as const;

export type RepairPhase = (typeof REPAIR_PHASES)[number];

export type RepairJobStatus = "queued" | "running" | "paused" | "completed" | "failed";

export interface RepairCheckpoint {
  jobId: string;
  currentPhase: RepairPhase;
  cursor: string | null;
  dryRun: boolean;
  batchSize: number;
  status: RepairJobStatus;
  stats: {
    scannedCount: number;
    repairedCount: number;
    failedCount: number;
    phaseBreakdown: Record<RepairPhase, { scanned: number; repaired: number; failed: number }>;
  };
  errors: Array<{
    recordId: string;
    phase: RepairPhase;
    message: string;
    timestamp: string;
  }>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  lastError?: string;
}

export interface StartRepairOptions {
  dryRun?: boolean;
  batchSize?: number;
  phases?: RepairPhase[];
  staleActionThresholdMs?: number;
  staleEventThresholdMs?: number;
  staleSettlementThresholdMs?: number;
}

export interface ResumeRepairOptions {
  batchSize?: number;
  maxBatches?: number;
}

// ─── Data Source Abstraction ────────────────────────────────────────────────

export interface StaleActionRecord {
  id: string;
  status: string;
  txHash: string | null;
  updatedAt: Date;
}

export interface StaleEventRecord {
  txHash: string;
  statusHint: string;
  receivedAt: Date;
}

export interface StaleSettlementRecord {
  id: string;
  vaultId: string;
  state: string;
  attempts: number;
  updatedAt: Date;
}

export interface RepairDataSource {
  // Phase 1: Actions
  fetchStaleActions(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleActionRecord[]>;
  repairAction(id: string, newStatus: string, reason: string): Promise<boolean>;

  // Phase 2: Pending Events
  fetchStalePendingEvents(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleEventRecord[]>;
  prunePendingEvent(txHash: string): Promise<boolean>;

  // Phase 3: Settlements
  fetchUnresolvedSettlements(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleSettlementRecord[]>;
  repairSettlement(id: string, newState: string, detail?: string): Promise<boolean>;
}

// ─── Prisma Data Source Implementation ──────────────────────────────────────

export class PrismaRepairDataSource implements RepairDataSource {
  constructor(private readonly prisma: PrismaClient) {}

  async fetchStaleActions(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleActionRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.prisma.actionLedger.findMany({
      where: {
        status: { in: ["pending", "submitted"] },
        updatedAt: { lte: cutoff }
      },
      orderBy: { id: "asc" },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        status: true,
        txHash: true,
        updatedAt: true
      }
    });

    return rows;
  }

  async repairAction(id: string, newStatus: string, reason: string): Promise<boolean> {
    const updated = await this.prisma.actionLedger.updateMany({
      where: {
        id,
        status: { in: ["pending", "submitted"] }
      },
      data: {
        status: newStatus as any,
        errorDetail: reason,
        updatedAt: new Date()
      }
    });
    return updated.count > 0;
  }

  async fetchStalePendingEvents(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleEventRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.prisma.pendingEvent.findMany({
      where: {
        consumedAt: null,
        receivedAt: { lte: cutoff }
      },
      orderBy: { txHash: "asc" },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { txHash: cursor } } : {}),
      select: {
        txHash: true,
        statusHint: true,
        receivedAt: true
      }
    });

    return rows;
  }

  async prunePendingEvent(txHash: string): Promise<boolean> {
    const deleted = await this.prisma.pendingEvent.deleteMany({
      where: {
        txHash,
        consumedAt: null
      }
    });
    return deleted.count > 0;
  }

  async fetchUnresolvedSettlements(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleSettlementRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const rows = await this.prisma.vaultSettlement.findMany({
      where: {
        state: "Unresolved",
        updatedAt: { lte: cutoff }
      },
      orderBy: { id: "asc" },
      take: limit,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        vaultId: true,
        state: true,
        attempts: true,
        updatedAt: true
      }
    });

    return rows;
  }

  async repairSettlement(id: string, newState: string, detail?: string): Promise<boolean> {
    const updated = await this.prisma.vaultSettlement.updateMany({
      where: {
        id,
        state: "Unresolved"
      },
      data: {
        state: newState,
        errorDetail: detail,
        updatedAt: new Date()
      }
    });
    return updated.count > 0;
  }
}

// ─── In-Memory Data Source Implementation (Testing & Local Development) ──────

export class InMemoryRepairDataSource implements RepairDataSource {
  public actions: StaleActionRecord[] = [];
  public events: StaleEventRecord[] = [];
  public settlements: StaleSettlementRecord[] = [];

  async fetchStaleActions(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleActionRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const sorted = [...this.actions]
      .filter((a) => (a.status === "pending" || a.status === "submitted") && a.updatedAt <= cutoff)
      .sort((a, b) => a.id.localeCompare(b.id));

    let startIndex = 0;
    if (cursor) {
      const idx = sorted.findIndex((a) => a.id === cursor);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    return sorted.slice(startIndex, startIndex + limit);
  }

  async repairAction(id: string, newStatus: string, reason: string): Promise<boolean> {
    const item = this.actions.find((a) => a.id === id);
    if (!item || (item.status !== "pending" && item.status !== "submitted")) return false;
    item.status = newStatus;
    item.updatedAt = new Date();
    return true;
  }

  async fetchStalePendingEvents(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleEventRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const sorted = [...this.events]
      .filter((e) => e.receivedAt <= cutoff)
      .sort((a, b) => a.txHash.localeCompare(b.txHash));

    let startIndex = 0;
    if (cursor) {
      const idx = sorted.findIndex((e) => e.txHash === cursor);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    return sorted.slice(startIndex, startIndex + limit);
  }

  async prunePendingEvent(txHash: string): Promise<boolean> {
    const initialLen = this.events.length;
    this.events = this.events.filter((e) => e.txHash !== txHash);
    return this.events.length < initialLen;
  }

  async fetchUnresolvedSettlements(cursor: string | null, limit: number, olderThanMs: number): Promise<StaleSettlementRecord[]> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const sorted = [...this.settlements]
      .filter((s) => s.state === "Unresolved" && s.updatedAt <= cutoff)
      .sort((a, b) => a.id.localeCompare(b.id));

    let startIndex = 0;
    if (cursor) {
      const idx = sorted.findIndex((s) => s.id === cursor);
      if (idx !== -1) {
        startIndex = idx + 1;
      }
    }

    return sorted.slice(startIndex, startIndex + limit);
  }

  async repairSettlement(id: string, newState: string, detail?: string): Promise<boolean> {
    const item = this.settlements.find((s) => s.id === id);
    if (!item || item.state !== "Unresolved") return false;
    item.state = newState;
    item.updatedAt = new Date();
    return true;
  }
}

// ─── Checkpoint Store ───────────────────────────────────────────────────────

export interface RepairCheckpointStore {
  save(checkpoint: RepairCheckpoint): Promise<void>;
  get(jobId: string): Promise<RepairCheckpoint | null>;
  list(options?: { status?: RepairJobStatus; limit?: number }): Promise<RepairCheckpoint[]>;
}

export class InMemoryRepairCheckpointStore implements RepairCheckpointStore {
  private readonly checkpoints = new Map<string, RepairCheckpoint>();

  async save(checkpoint: RepairCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.jobId, { ...checkpoint, updatedAt: new Date().toISOString() });
  }

  async get(jobId: string): Promise<RepairCheckpoint | null> {
    const cp = this.checkpoints.get(jobId);
    return cp ? { ...cp } : null;
  }

  async list(options?: { status?: RepairJobStatus; limit?: number }): Promise<RepairCheckpoint[]> {
    let list = Array.from(this.checkpoints.values());
    if (options?.status) {
      list = list.filter((cp) => cp.status === options.status);
    }
    const limit = options?.limit ?? 50;
    return list.slice(0, limit);
  }
}

// ─── Resumable Repair Engine ────────────────────────────────────────────────

export class ResumableRepairEngine {
  private readonly dataSource: RepairDataSource;
  private readonly checkpointStore: RepairCheckpointStore;
  private activeJobs = new Set<string>();
  private pauseFlags = new Set<string>();

  constructor(options: {
    dataSource: RepairDataSource;
    checkpointStore?: RepairCheckpointStore;
  }) {
    this.dataSource = options.dataSource;
    this.checkpointStore = options.checkpointStore ?? new InMemoryRepairCheckpointStore();
  }

  /**
   * Initializes and executes a new resumable repair job.
   * Space Complexity: O(B) bounded memory per batch.
   * Time Complexity: O(N log N) with cursor-based pagination.
   */
  async startJob(options: StartRepairOptions = {}): Promise<RepairCheckpoint> {
    const jobId = randomUUID();
    const dryRun = options.dryRun ?? false;
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 50, 200));
    const nowIso = new Date().toISOString();

    const checkpoint: RepairCheckpoint = {
      jobId,
      currentPhase: "orphaned_actions",
      cursor: null,
      dryRun,
      batchSize,
      status: "running",
      stats: {
        scannedCount: 0,
        repairedCount: 0,
        failedCount: 0,
        phaseBreakdown: {
          orphaned_actions: { scanned: 0, repaired: 0, failed: 0 },
          stale_pending_events: { scanned: 0, repaired: 0, failed: 0 },
          unresolved_settlements: { scanned: 0, repaired: 0, failed: 0 }
        }
      },
      errors: [],
      createdAt: nowIso,
      updatedAt: nowIso
    };

    await this.checkpointStore.save(checkpoint);
    return this.runJobExecution(checkpoint, options);
  }

  /**
   * Resumes a paused or interrupted job from its exact persisted checkpoint.
   */
  async resumeJob(jobId: string, options: ResumeRepairOptions = {}): Promise<RepairCheckpoint> {
    const checkpoint = await this.checkpointStore.get(jobId);
    if (!checkpoint) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, `Repair job checkpoint '${jobId}' not found`);
    }

    if (checkpoint.status === "completed") {
      return checkpoint; // Idempotent: already complete
    }

    checkpoint.status = "running";
    if (options.batchSize) {
      checkpoint.batchSize = Math.max(1, Math.min(options.batchSize, 200));
    }
    checkpoint.updatedAt = new Date().toISOString();
    await this.checkpointStore.save(checkpoint);

    return this.runJobExecution(checkpoint, {
      dryRun: checkpoint.dryRun,
      batchSize: checkpoint.batchSize
    });
  }

  /**
   * Signals an active job to pause at the next batch boundary.
   */
  async pauseJob(jobId: string): Promise<RepairCheckpoint | null> {
    this.pauseFlags.add(jobId);
    const cp = await this.checkpointStore.get(jobId);
    if (cp && cp.status === "running") {
      cp.status = "paused";
      cp.updatedAt = new Date().toISOString();
      await this.checkpointStore.save(cp);
      return cp;
    }
    return cp;
  }

  /**
   * Retrieves current status and statistics for a repair job.
   */
  async getCheckpoint(jobId: string): Promise<RepairCheckpoint | null> {
    return this.checkpointStore.get(jobId);
  }

  // ─── Execution Logic ────────────────────────────────────────────────────────

  private async runJobExecution(
    checkpoint: RepairCheckpoint,
    options: StartRepairOptions
  ): Promise<RepairCheckpoint> {
    this.activeJobs.add(checkpoint.jobId);
    this.pauseFlags.delete(checkpoint.jobId);

    const phases: RepairPhase[] = options.phases ?? [...REPAIR_PHASES];
    const staleActionThresholdMs = options.staleActionThresholdMs ?? 30 * 60 * 1000;      // 30 min
    const staleEventThresholdMs = options.staleEventThresholdMs ?? 60 * 60 * 1000;        // 1 hour
    const staleSettlementThresholdMs = options.staleSettlementThresholdMs ?? 60 * 60 * 1000; // 1 hour

    try {
      const startPhaseIdx = phases.indexOf(checkpoint.currentPhase);
      const activePhases = startPhaseIdx === -1 ? phases : phases.slice(startPhaseIdx);

      for (const phase of activePhases) {
        if (this.pauseFlags.has(checkpoint.jobId)) {
          checkpoint.status = "paused";
          await this.checkpointStore.save(checkpoint);
          break;
        }

        checkpoint.currentPhase = phase;

        if (phase === "orphaned_actions") {
          await this.executeActionsPhase(checkpoint, staleActionThresholdMs);
        } else if (phase === "stale_pending_events") {
          await this.executeEventsPhase(checkpoint, staleEventThresholdMs);
        } else if (phase === "unresolved_settlements") {
          await this.executeSettlementsPhase(checkpoint, staleSettlementThresholdMs);
        }

        // Phase finished: reset cursor for next phase unless paused
        if (!this.pauseFlags.has(checkpoint.jobId)) {
          checkpoint.cursor = null;
          await this.checkpointStore.save(checkpoint);
        } else {
          break;
        }
      }

      if (!this.pauseFlags.has(checkpoint.jobId)) {
        checkpoint.status = "completed";
        checkpoint.completedAt = new Date().toISOString();
        await this.checkpointStore.save(checkpoint);
      }
    } catch (err: any) {
      checkpoint.status = "failed";
      checkpoint.lastError = err.message ?? "Unknown repair failure";
      await this.checkpointStore.save(checkpoint);
      throw err;
    } finally {
      this.activeJobs.delete(checkpoint.jobId);
      this.pauseFlags.delete(checkpoint.jobId);
    }

    return checkpoint;
  }

  // ─── Phase Handlers ─────────────────────────────────────────────────────────

  private async executeActionsPhase(checkpoint: RepairCheckpoint, thresholdMs: number): Promise<void> {
    let hasMore = true;

    while (hasMore) {
      if (this.pauseFlags.has(checkpoint.jobId)) break;

      const batch = await this.dataSource.fetchStaleActions(
        checkpoint.cursor,
        checkpoint.batchSize,
        thresholdMs
      );

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const record of batch) {
        checkpoint.stats.scannedCount++;
        checkpoint.stats.phaseBreakdown.orphaned_actions.scanned++;

        try {
          if (!checkpoint.dryRun) {
            const repaired = await this.dataSource.repairAction(
              record.id,
              "orphaned",
              "Resumable repair job: broadcast timeout exceeded"
            );
            if (repaired) {
              checkpoint.stats.repairedCount++;
              checkpoint.stats.phaseBreakdown.orphaned_actions.repaired++;
            }
          } else {
            // Dry run planning
            checkpoint.stats.repairedCount++;
            checkpoint.stats.phaseBreakdown.orphaned_actions.repaired++;
          }
        } catch (err: any) {
          checkpoint.stats.failedCount++;
          checkpoint.stats.phaseBreakdown.orphaned_actions.failed++;
          this.recordError(checkpoint, record.id, "orphaned_actions", err.message);
        }

        checkpoint.cursor = record.id;
      }

      // Checkpoint progress after each bounded batch
      checkpoint.updatedAt = new Date().toISOString();
      await this.checkpointStore.save(checkpoint);

      if (batch.length < checkpoint.batchSize) {
        hasMore = false;
      }
    }
  }

  private async executeEventsPhase(checkpoint: RepairCheckpoint, thresholdMs: number): Promise<void> {
    let hasMore = true;

    while (hasMore) {
      if (this.pauseFlags.has(checkpoint.jobId)) break;

      const batch = await this.dataSource.fetchStalePendingEvents(
        checkpoint.cursor,
        checkpoint.batchSize,
        thresholdMs
      );

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const record of batch) {
        checkpoint.stats.scannedCount++;
        checkpoint.stats.phaseBreakdown.stale_pending_events.scanned++;

        try {
          if (!checkpoint.dryRun) {
            const pruned = await this.dataSource.prunePendingEvent(record.txHash);
            if (pruned) {
              checkpoint.stats.repairedCount++;
              checkpoint.stats.phaseBreakdown.stale_pending_events.repaired++;
            }
          } else {
            checkpoint.stats.repairedCount++;
            checkpoint.stats.phaseBreakdown.stale_pending_events.repaired++;
          }
        } catch (err: any) {
          checkpoint.stats.failedCount++;
          checkpoint.stats.phaseBreakdown.stale_pending_events.failed++;
          this.recordError(checkpoint, record.txHash, "stale_pending_events", err.message);
        }

        checkpoint.cursor = record.txHash;
      }

      checkpoint.updatedAt = new Date().toISOString();
      await this.checkpointStore.save(checkpoint);

      if (batch.length < checkpoint.batchSize) {
        hasMore = false;
      }
    }
  }

  private async executeSettlementsPhase(checkpoint: RepairCheckpoint, thresholdMs: number): Promise<void> {
    let hasMore = true;

    while (hasMore) {
      if (this.pauseFlags.has(checkpoint.jobId)) break;

      const batch = await this.dataSource.fetchUnresolvedSettlements(
        checkpoint.cursor,
        checkpoint.batchSize,
        thresholdMs
      );

      if (batch.length === 0) {
        hasMore = false;
        break;
      }

      for (const record of batch) {
        checkpoint.stats.scannedCount++;
        checkpoint.stats.phaseBreakdown.unresolved_settlements.scanned++;

        try {
          if (!checkpoint.dryRun) {
            const repaired = await this.dataSource.repairSettlement(
              record.id,
              "Escalated",
              "Resumable repair job: settlement reconciliation timeout"
            );
            if (repaired) {
              checkpoint.stats.repairedCount++;
              checkpoint.stats.phaseBreakdown.unresolved_settlements.repaired++;
            }
          } else {
            checkpoint.stats.repairedCount++;
            checkpoint.stats.phaseBreakdown.unresolved_settlements.repaired++;
          }
        } catch (err: any) {
          checkpoint.stats.failedCount++;
          checkpoint.stats.phaseBreakdown.unresolved_settlements.failed++;
          this.recordError(checkpoint, record.id, "unresolved_settlements", err.message);
        }

        checkpoint.cursor = record.id;
      }

      checkpoint.updatedAt = new Date().toISOString();
      await this.checkpointStore.save(checkpoint);

      if (batch.length < checkpoint.batchSize) {
        hasMore = false;
      }
    }
  }

  private recordError(
    checkpoint: RepairCheckpoint,
    recordId: string,
    phase: RepairPhase,
    message: string
  ): void {
    // Keep errors bounded to the most recent 100 to avoid unbounded memory / JSON growth
    if (checkpoint.errors.length >= 100) {
      checkpoint.errors.shift();
    }
    checkpoint.errors.push({
      recordId,
      phase,
      message: message || "Unknown error",
      timestamp: new Date().toISOString()
    });
  }
}
