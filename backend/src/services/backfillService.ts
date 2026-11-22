import type { PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";

export interface RawBackfillEvent {
  id: string;
  ledger: number;
  txHash: string;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp?: Date;
}

export type BackfillAction = "create" | "update" | "skip" | "error";

export interface RecordDiff {
  id: string;
  txHash: string;
  eventType: string;
  ledger: number;
  action: BackfillAction;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string;
  error?: string;
}

export interface BackfillOptions {
  fromLedger?: number;
  toLedger?: number;
  dryRun?: boolean;
  batchSize?: number;
  limit?: number;
  checkpointId?: string;
  resetCheckpoint?: number;
  force?: boolean;
}

export interface BackfillReport {
  dryRun: boolean;
  startLedger: number;
  endLedger: number;
  previousCheckpoint: number;
  newCheckpoint: number;
  totalScanned: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  diffs: RecordDiff[];
  durationMs: number;
}

export interface BackfillEventSource {
  fetchEvents(fromLedger: number, toLedger: number, limit?: number): Promise<RawBackfillEvent[]>;
  getLatestLedger(): Promise<number>;
}

export class BackfillService {
  private readonly checkpointId: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventSource?: BackfillEventSource,
    checkpointId = "singleton"
  ) {
    this.checkpointId = checkpointId;
  }

  /**
   * Retrieves the current checkpoint state.
   */
  async getCheckpoint(): Promise<{
    id: string;
    latestLedger: number;
    lastProcessedEventId: string | null;
    lastSyncTime: Date;
    lastError: string | null;
  } | null> {
    const cp = await this.prisma.indexerCheckpoint.findUnique({
      where: { id: this.checkpointId },
    });
    return cp;
  }

  /**
   * Status overview showing current gap between checkpoint and chain tip.
   */
  async getStatus(): Promise<{
    checkpointLedger: number;
    latestLedger: number;
    gap: number;
    estimatedHours: number;
    lastSyncTime?: Date;
    lastError?: string | null;
  }> {
    const cp = await this.getCheckpoint();
    const checkpointLedger = cp?.latestLedger ?? 0;
    const latestLedger = this.eventSource
      ? await this.eventSource.getLatestLedger()
      : checkpointLedger;

    const gap = Math.max(0, latestLedger - checkpointLedger);
    const estimatedHours = Math.round(((gap * 5) / 3600) * 10) / 10; // ~5s per Stellar ledger

    return {
      checkpointLedger,
      latestLedger,
      gap,
      estimatedHours,
      lastSyncTime: cp?.lastSyncTime,
      lastError: cp?.lastError,
    };
  }

  /**
   * Verifies consistency between IndexerCheckpoint and ActionLedger.
   */
  async verifyConsistency(): Promise<{
    consistent: boolean;
    checkpointLedger: number;
    maxActionLedger: number;
    gap: number;
    warning?: string;
  }> {
    const cp = await this.getCheckpoint();
    const checkpointLedger = cp?.latestLedger ?? 0;

    const agg = await this.prisma.actionLedger.aggregate({
      _max: { observedLedger: true },
    });
    const maxActionLedger = agg._max.observedLedger ?? 0;

    const gap = Math.abs(checkpointLedger - maxActionLedger);
    const consistent = gap <= 1000;

    return {
      consistent,
      checkpointLedger,
      maxActionLedger,
      gap,
      warning: !consistent
        ? `Inconsistency detected: checkpoint (${checkpointLedger}) diverges from max action ledger (${maxActionLedger}) by ${gap} ledgers`
        : undefined,
    };
  }

  /**
   * Runs the backfill operation with dry-run diff preview and resumable checkpoints.
   */
  async runBackfill(
    eventsToProcess?: RawBackfillEvent[],
    options: BackfillOptions = {}
  ): Promise<BackfillReport> {
    const startTime = performance.now();
    const dryRun = options.dryRun ?? false;
    const batchSize = options.batchSize ?? 100;

    // 1. Determine starting checkpoint
    let currentCheckpointRecord = await this.getCheckpoint();
    if (options.resetCheckpoint !== undefined) {
      if (!dryRun) {
        currentCheckpointRecord = await this.prisma.indexerCheckpoint.upsert({
          where: { id: this.checkpointId },
          create: {
            id: this.checkpointId,
            latestLedger: options.resetCheckpoint,
            lastSyncTime: new Date(),
            lastSuccessSyncTime: new Date(),
          },
          update: {
            latestLedger: options.resetCheckpoint,
            lastSyncTime: new Date(),
          },
        });
      }
    }

    const previousCheckpoint = currentCheckpointRecord?.latestLedger ?? 0;
    const startLedger = options.fromLedger ?? (previousCheckpoint > 0 ? previousCheckpoint + 1 : 1);
    const endLedger = options.toLedger ?? (options.fromLedger ? options.fromLedger + 100 : startLedger + 100);

    // 2. Fetch events if not directly supplied
    let events: RawBackfillEvent[] = [];
    if (eventsToProcess) {
      events = eventsToProcess;
    } else if (this.eventSource) {
      events = await this.eventSource.fetchEvents(startLedger, endLedger, options.limit);
    }

    if (options.limit && events.length > options.limit) {
      events = events.slice(0, options.limit);
    }

    const diffs: RecordDiff[] = [];
    let appliedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let maxProcessedLedger = previousCheckpoint;

    // 3. Process records batch by batch
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);

      for (const event of batch) {
        try {
          const diff = await this.evaluateRecord(event);
          diffs.push(diff);

          if (diff.action === "skip") {
            skippedCount++;
          } else if (diff.action === "create" || diff.action === "update") {
            if (!dryRun) {
              await this.applyRecord(event, diff.action);
            }
            appliedCount++;
          }

          if (event.ledger > maxProcessedLedger) {
            maxProcessedLedger = event.ledger;
          }
        } catch (err: any) {
          failedCount++;
          diffs.push({
            id: event.id,
            txHash: event.txHash,
            eventType: event.eventType,
            ledger: event.ledger,
            action: "error",
            error: err?.message ?? String(err),
          });
        }
      }

      // Update checkpoint after batch if not dry run
      if (!dryRun && maxProcessedLedger > previousCheckpoint) {
        await this.prisma.indexerCheckpoint.upsert({
          where: { id: this.checkpointId },
          create: {
            id: this.checkpointId,
            latestLedger: maxProcessedLedger,
            lastProcessedEventId: batch[batch.length - 1]?.id,
            lastSyncTime: new Date(),
            lastSuccessSyncTime: new Date(),
          },
          update: {
            latestLedger: maxProcessedLedger,
            lastProcessedEventId: batch[batch.length - 1]?.id,
            lastSyncTime: new Date(),
            lastSuccessSyncTime: new Date(),
            lastError: null,
          },
        });
      }
    }

    const newCheckpoint = !dryRun ? maxProcessedLedger : previousCheckpoint;
    const durationMs = Math.round(performance.now() - startTime);

    return {
      dryRun,
      startLedger,
      endLedger,
      previousCheckpoint,
      newCheckpoint,
      totalScanned: events.length,
      appliedCount,
      skippedCount,
      failedCount,
      diffs,
      durationMs,
    };
  }

  /**
   * Previews changes for an event against the current database state.
   */
  private async evaluateRecord(event: RawBackfillEvent): Promise<RecordDiff> {
    const existing = await this.prisma.actionLedger.findUnique({
      where: { txHash: event.txHash },
    });

    const projectedPayload = {
      txHash: event.txHash,
      walletAddress: (event.payload?.who as string) || (event.payload?.wallet as string) || "unknown",
      actionType: event.eventType,
      status: "confirmed",
      observedLedger: event.ledger,
      actionPayload: event.payload,
    };

    if (!existing) {
      return {
        id: event.id,
        txHash: event.txHash,
        eventType: event.eventType,
        ledger: event.ledger,
        action: "create",
        before: null,
        after: projectedPayload,
      };
    }

    // Check if already completely up to date
    if (
      existing.status === "confirmed" &&
      existing.observedLedger === event.ledger &&
      existing.actionType === event.eventType
    ) {
      return {
        id: event.id,
        txHash: event.txHash,
        eventType: event.eventType,
        ledger: event.ledger,
        action: "skip",
        reason: "RECORD_ALREADY_CONFIRMED",
        before: { status: existing.status, observedLedger: existing.observedLedger },
      };
    }

    return {
      id: event.id,
      txHash: event.txHash,
      eventType: event.eventType,
      ledger: event.ledger,
      action: "update",
      before: {
        status: existing.status,
        observedLedger: existing.observedLedger,
        actionType: existing.actionType,
      },
      after: projectedPayload,
    };
  }

  /**
   * Applies the record changes to ActionLedger.
   */
  private async applyRecord(event: RawBackfillEvent, action: "create" | "update"): Promise<void> {
    const walletAddress =
      (event.payload?.who as string) || (event.payload?.wallet as string) || "unknown";

    await this.prisma.actionLedger.upsert({
      where: { txHash: event.txHash },
      create: {
        txHash: event.txHash,
        walletAddress,
        actionType: event.eventType as any,
        status: "confirmed",
        observedLedger: event.ledger,
        actionPayload: event.payload as any,
        confirmedAt: event.timestamp ?? new Date(),
      },
      update: {
        status: "confirmed",
        observedLedger: event.ledger,
        actionPayload: event.payload as any,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Formats a BackfillReport into an operator-friendly dry-run diff preview.
   */
  static formatDiffReport(report: BackfillReport): string {
    const lines: string[] = [];
    const mode = report.dryRun ? "[DRY RUN PREVIEW - NO CHANGES APPLIED]" : "[LIVE EXECUTION]";
    lines.push(`=======================================================`);
    lines.push(`VaultQuest Backfill Report: ${mode}`);
    lines.push(`Ledger Range: ${report.startLedger} -> ${report.endLedger}`);
    lines.push(`Checkpoint: ${report.previousCheckpoint} -> ${report.newCheckpoint}`);
    lines.push(`Total Scanned: ${report.totalScanned}`);
    lines.push(`Applied: ${report.appliedCount} | Skipped: ${report.skippedCount} | Failed: ${report.failedCount}`);
    lines.push(`Duration: ${report.durationMs}ms`);
    lines.push(`-------------------------------------------------------`);

    if (report.diffs.length === 0) {
      lines.push("No records found in specified ledger range.");
    } else {
      for (const d of report.diffs) {
        if (d.action === "create") {
          lines.push(`+ [CREATE] tx:${d.txHash.slice(0, 10)}... type:${d.eventType} ledger:${d.ledger}`);
          lines.push(`    New payload: ${JSON.stringify(d.after)}`);
        } else if (d.action === "update") {
          lines.push(`~ [UPDATE] tx:${d.txHash.slice(0, 10)}... type:${d.eventType} ledger:${d.ledger}`);
          lines.push(`    Before: ${JSON.stringify(d.before)}`);
          lines.push(`    After:  ${JSON.stringify(d.after)}`);
        } else if (d.action === "skip") {
          lines.push(`= [SKIP]   tx:${d.txHash.slice(0, 10)}... reason:${d.reason}`);
        } else if (d.action === "error") {
          lines.push(`! [ERROR]  tx:${d.txHash?.slice(0, 10)}... error:${d.error}`);
        }
      }
    }
    lines.push(`=======================================================`);
    return lines.join("\n");
  }
}
