/**
 * Versioned projection rebuild (#989).
 *
 * Rebuilds the chain-derived projections of the live database in place by
 * replaying the stored `chain_events` log through the unmodified production
 * StellarIndexer/LedgerService — the path `runReplayEquivalence` (#751)
 * proves deterministic — at a single projection version
 * (`SCHEMA_VERSIONS.INDEXER`, which REPLAY_DETERMINISM.md already treats as
 * the replay-behaviour version). The stored log is the source, not Soroban
 * RPC: `getEvents` only serves the node's retention window (default 120960
 * ledgers, about 7 days).
 *
 * Guarantees:
 *  - Versioned: a run records the projection version that builds it. Only a
 *    build at that same version may resume it (mixing versions would leave a
 *    projection no single version produces). Rebuilding at a version older
 *    than the last completed rebuild is a rollback and must be explicit.
 *  - Fenced: while executing, a run holds the indexer's job lease, and every
 *    run in `running`/`failed` durably fences the live indexer and the
 *    replay-equivalence job (`isIndexerFenced`), so a crash can never let
 *    live ingestion write on top of a half-built projection.
 *  - Resumable: the cursor is persisted after every committed batch.
 *    Re-applying a batch is a no-op (the log append skips duplicates and
 *    terminal rows ignore re-reconciliation), so resume is at-least-once safe.
 *  - Scoped to the log: only rows the log can reproduce are reset (see
 *    `PrismaProjectionTarget.resetProjections`); outcomes recorded without a
 *    logged event (`POST /internal/reconcile`, pre-#751 history) survive.
 *
 * Complexity (E logged events, B batch size, A reset rows):
 *  - plan:     O(E) primary-key index count, O(1) memory
 *  - reset:    O(A) in one transaction
 *  - replay:   O(E) time in E / B batches, O(B) memory, O(1) writes per batch
 *  - isFenced: O(1) via the (status, created_at) index
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { PrismaClient, ProjectionRebuild } from "@prisma/client";
import type { Logger } from "pino";
import { AppError } from "../errors.js";
import { ERROR_CODES, SCHEMA_VERSIONS } from "../constants.js";
import type { AuditActor, AuditRecorder } from "./auditTrail.js";
import type { LedgerService } from "./ledger.js";
import type { JobLeaseHandle, LeaseService } from "./leaseService.js";
import { StellarIndexer, ledgerOfEventId, type XdrDecoder } from "./stellarIndexer.js";
import { ChainEventLogSource, resolvedPoisonEventIds } from "./replayEquivalence.js";
import { EventLogIntegrityError, verifyEventLog } from "./eventLogIntegrity.js";

/** Job lease the indexer cron runs under; holding it pauses live ingestion. */
export const INDEXER_JOB_LEASE = "stellar-indexer";

export const PROJECTION_REBUILD_STATUSES = ["running", "failed", "completed", "superseded"] as const;
export type ProjectionRebuildStatus = (typeof PROJECTION_REBUILD_STATUSES)[number];

/** Statuses that leave projections partially rebuilt, so the indexer stays fenced. */
const FENCING_STATUSES: readonly ProjectionRebuildStatus[] = ["running", "failed"];

const MAX_ERROR_LENGTH = 2000;

export interface ProjectionRebuildRun {
  id: string;
  projectionVersion: string;
  status: ProjectionRebuildStatus;
  requestedBy: string;
  reason: string;
  toEventId: string | null;
  cursor: string | null;
  eventsReplayed: number;
  attempts: number;
  errorCode: string | null;
  lastError: string | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export type NewProjectionRebuildRun = Pick<
  ProjectionRebuildRun,
  "projectionVersion" | "requestedBy" | "reason" | "toEventId" | "heartbeatAt"
>;

export type ProjectionRebuildPatch = Partial<
  Pick<
    ProjectionRebuildRun,
    "status" | "cursor" | "eventsReplayed" | "attempts" | "errorCode" | "lastError" | "heartbeatAt" | "completedAt"
  >
>;

// ─── Ports ────────────────────────────────────────────────────────────────────

export interface ProjectionRebuildStore {
  /** Creates a `running` run; `supersedes` (an incomplete run) is marked `superseded` atomically. */
  create(run: NewProjectionRebuildRun, supersedes?: string): Promise<ProjectionRebuildRun>;
  get(id: string): Promise<ProjectionRebuildRun | null>;
  update(id: string, patch: ProjectionRebuildPatch): Promise<ProjectionRebuildRun>;
  /** Applies `patch` only while the run is still `from` (compare-and-set); null once it moved on. */
  transition(id: string, from: ProjectionRebuildStatus, patch: ProjectionRebuildPatch): Promise<ProjectionRebuildRun | null>;
  /** Newest first. */
  list(limit: number): Promise<ProjectionRebuildRun[]>;
  /** The newest run in `running` or `failed`, if any. */
  findIncomplete(): Promise<ProjectionRebuildRun | null>;
  /** The most recently completed run, if any. */
  latestCompleted(): Promise<ProjectionRebuildRun | null>;
}

export interface ReplayBatch {
  /** Events fetched from the log in this batch. */
  processed: number;
  /** Events quarantined; the replay halts at the first one. */
  quarantined: number;
  /** Last event id whose effects committed. */
  cursor: string | null;
}

export interface ProjectionReplayer {
  next(): Promise<ReplayBatch>;
}

export interface ProjectionTarget {
  /** Detect gaps or changed bytes before reset and again before declaring success. */
  validateLog?(): Promise<void>;
  /** Last event id in the stored log, or null when the log is empty. */
  logTip(): Promise<string | null>;
  /** Events in the log up to and including `toEventId`. */
  countEvents(toEventId: string): Promise<number>;
  /** Drops every projection row the log can rebuild. Idempotent; never touches the log or off-chain intents. */
  resetProjections(): Promise<void>;
  /** Replays the log after `cursor` (exclusive) up to `toEventId` (inclusive). */
  openReplay(cursor: string | null, toEventId: string): Promise<ProjectionReplayer>;
  /** Points the live indexer checkpoint at `cursor`, stamped with the projection version. */
  commitCheckpoint(cursor: string, projectionVersion: string): Promise<void>;
}

export interface IndexerFence {
  /** Null when another worker (an indexer tick or another rebuild) holds the lease. */
  acquire(): Promise<JobLeaseHandle | null>;
  /** False once the lease was lost; the holder must stop writing. */
  renew(handle: JobLeaseHandle): Promise<boolean>;
  release(handle: JobLeaseHandle): Promise<void>;
}

/** True while any rebuild is incomplete: the indexer and replay-equivalence crons must skip their ticks. */
export async function isIndexerFenced(runs: Pick<ProjectionRebuildStore, "findIncomplete">): Promise<boolean> {
  return (await runs.findIncomplete()) !== null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface RebuildPlan {
  /** Version this build replays at. */
  projectionVersion: string;
  /** Version of the last completed rebuild, or null if none ever completed. */
  lastRebuiltVersion: string | null;
  rebuildRecommended: boolean;
  /** Starting now would roll projections back to an older version (needs `allowDowngrade`). */
  isDowngrade: boolean;
  toEventId: string | null;
  eventsToReplay: number;
  activeRun: ProjectionRebuildRun | null;
}

export interface RebuildExecution {
  /** The run as it was when execution was handed to the background. */
  run: ProjectionRebuildRun;
  /** Settles (never rejects) with the run's final state. */
  done: Promise<ProjectionRebuildRun>;
}

export interface ProjectionRebuildServiceOptions {
  runs: ProjectionRebuildStore;
  target: ProjectionTarget;
  fence: IndexerFence;
  audit?: AuditRecorder;
  logger?: Logger;
  /** Defaults to `SCHEMA_VERSIONS.INDEXER`. */
  projectionVersion?: string;
  now?: () => Date;
}

/** A stop condition with a stable code, persisted on the failed run. */
class RebuildHalt extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RebuildHalt";
  }
}

export class ProjectionRebuildService {
  readonly projectionVersion: string;
  private readonly now: () => Date;

  constructor(private readonly deps: ProjectionRebuildServiceOptions) {
    this.projectionVersion = deps.projectionVersion ?? SCHEMA_VERSIONS.INDEXER;
    this.now = deps.now ?? (() => new Date());
  }

  async plan(): Promise<RebuildPlan> {
    const [toEventId, lastCompleted, activeRun] = await Promise.all([
      this.deps.target.logTip(),
      this.deps.runs.latestCompleted(),
      this.deps.runs.findIncomplete()
    ]);
    const lastRebuiltVersion = lastCompleted?.projectionVersion ?? null;
    return {
      projectionVersion: this.projectionVersion,
      lastRebuiltVersion,
      rebuildRecommended: lastRebuiltVersion !== this.projectionVersion,
      isDowngrade: lastRebuiltVersion !== null && lastRebuiltVersion > this.projectionVersion,
      toEventId,
      eventsToReplay: toEventId ? await this.deps.target.countEvents(toEventId) : 0,
      activeRun
    };
  }

  get(id: string): Promise<ProjectionRebuildRun | null> {
    return this.deps.runs.get(id);
  }

  list(limit: number): Promise<ProjectionRebuildRun[]> {
    return this.deps.runs.list(limit);
  }

  isFenced(): Promise<boolean> {
    return isIndexerFenced(this.deps.runs);
  }

  /**
   * Starts a fresh rebuild from the beginning of the log. Any incomplete run
   * is superseded (its partial projection is reset again). Returns once the
   * run is recorded and fenced; the reset and replay continue in `done`.
   */
  async start(input: { actor: AuditActor; reason: string; allowDowngrade?: boolean }): Promise<RebuildExecution> {
    const lastCompleted = await this.deps.runs.latestCompleted();
    if (lastCompleted && lastCompleted.projectionVersion > this.projectionVersion && !input.allowDowngrade) {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `projections were last rebuilt at version ${lastCompleted.projectionVersion}, newer than this build's ` +
          `${this.projectionVersion}; set allow_downgrade to roll them back`
      );
    }

    const handle = await this.acquireFence();
    let run: ProjectionRebuildRun;
    let supersedes: string | null;
    try {
      await this.deps.target.validateLog?.();
      // Re-read under the lease: only the lease holder creates or resumes runs.
      supersedes = (await this.deps.runs.findIncomplete())?.id ?? null;
      run = await this.deps.runs.create(
        {
          projectionVersion: this.projectionVersion,
          requestedBy: input.actor.subject,
          reason: input.reason,
          toEventId: await this.deps.target.logTip(),
          heartbeatAt: this.now()
        },
        supersedes ?? undefined
      );
    } catch (err) {
      await this.deps.fence.release(handle);
      throw err;
    }
    return this.launch(run, handle, "projection.rebuild.start", input.actor, input.reason, {
      supersedes,
      allowDowngrade: input.allowDowngrade ?? false
    });
  }

  /** Continues a failed (or orphaned `running`) run from its persisted cursor. */
  async resume(id: string, actor: AuditActor): Promise<RebuildExecution> {
    this.assertResumable(await this.requireRun(id));

    const handle = await this.acquireFence();
    let run: ProjectionRebuildRun;
    try {
      // Re-check under the lease: another worker may have resumed or finished it.
      const current = await this.requireRun(id);
      this.assertResumable(current);
      run = await this.deps.runs.update(id, {
        status: "running",
        attempts: current.attempts + 1,
        errorCode: null,
        lastError: null,
        heartbeatAt: this.now()
      });
    } catch (err) {
      await this.deps.fence.release(handle);
      throw err;
    }
    return this.launch(run, handle, "projection.rebuild.resume", actor, null, {
      attempt: run.attempts,
      cursor: run.cursor
    });
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async requireRun(id: string): Promise<ProjectionRebuildRun> {
    const run = await this.deps.runs.get(id);
    if (!run) throw AppError.notFound(`projection rebuild ${id} not found`);
    return run;
  }

  private assertResumable(run: ProjectionRebuildRun): void {
    if (!FENCING_STATUSES.includes(run.status)) {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `projection rebuild ${run.id} is ${run.status}; only running or failed rebuilds can be resumed`
      );
    }
    if (run.projectionVersion !== this.projectionVersion) {
      throw AppError.conflict(
        ERROR_CODES.ILLEGAL_TRANSITION,
        `projection rebuild ${run.id} was started at version ${run.projectionVersion} but this build replays at ` +
          `${this.projectionVersion}; start a new rebuild instead of mixing versions`
      );
    }
  }

  private async acquireFence(): Promise<JobLeaseHandle> {
    const handle = await this.deps.fence.acquire();
    if (!handle) {
      throw new AppError(
        ERROR_CODES.PROJECTION_REBUILD_BUSY,
        409,
        "the indexer lease is held by another worker (an indexer tick or a running rebuild); retry shortly"
      );
    }
    return handle;
  }

  /** Audits the transition, then hands execution to the background. */
  private async launch(
    run: ProjectionRebuildRun,
    handle: JobLeaseHandle,
    action: string,
    actor: AuditActor,
    reason: string | null,
    metadata: Record<string, unknown>
  ): Promise<RebuildExecution> {
    try {
      await this.deps.audit?.record({
        category: "recovery",
        action,
        actor,
        target: { type: "projection_rebuild", id: run.id },
        reason,
        metadata: { projectionVersion: run.projectionVersion, toEventId: run.toEventId, ...metadata }
      });
    } catch (err) {
      // An unaudited privileged operation must not run; the failed run stays
      // visible (and fencing) until an operator resumes or supersedes it.
      await this.fail(run, new RebuildHalt("AUDIT_FAILED", errorMessage(err)), handle);
      throw err;
    }
    return { run, done: this.execute(run, handle) };
  }

  private async execute(started: ProjectionRebuildRun, handle: JobLeaseHandle): Promise<ProjectionRebuildRun> {
    let run = started;
    try {
      await this.deps.target.validateLog?.();
      if (run.toEventId !== null) {
        if (run.cursor === null) await this.deps.target.resetProjections();
        const replay = await this.deps.target.openReplay(run.cursor, run.toEventId);
        for (;;) {
          await this.assertFenceHeld(handle);
          const batch = await replay.next();
          if (batch.quarantined > 0) {
            // Effects before the gap committed; keep them so resume starts at the gap.
            if (batch.cursor !== run.cursor) run = await this.deps.runs.update(run.id, { cursor: batch.cursor });
            throw new RebuildHalt(
              "HALTED_ON_QUARANTINE",
              `replay quarantined the event after ${batch.cursor ?? "the start of the log"}; ` +
                "fix the decoder or resolve the poison event, then resume"
            );
          }
          if (batch.processed === 0) break;
          if (batch.cursor === run.cursor) {
            throw new RebuildHalt("NO_PROGRESS", `replay made no progress past cursor ${run.cursor ?? "<start>"}`);
          }
          run = await this.deps.runs.update(run.id, {
            cursor: batch.cursor,
            eventsReplayed: run.eventsReplayed + batch.processed,
            heartbeatAt: this.now()
          });
        }
      }

      await this.assertFenceHeld(handle);
      await this.deps.target.validateLog?.();
      if (run.cursor !== null) await this.deps.target.commitCheckpoint(run.cursor, run.projectionVersion);
      const completedAt = this.now();
      run = await this.deps.runs.update(run.id, { status: "completed", completedAt, heartbeatAt: completedAt });
      await this.deps.fence.release(handle);
      this.deps.logger?.info(
        { event: "projection_rebuild.completed", runId: run.id, projectionVersion: run.projectionVersion, eventsReplayed: run.eventsReplayed },
        "projection rebuild completed"
      );
      return run;
    } catch (err) {
      return this.fail(run, err, handle);
    }
  }

  private async assertFenceHeld(handle: JobLeaseHandle): Promise<void> {
    if (!(await this.deps.fence.renew(handle))) {
      throw new RebuildHalt("FENCE_LOST", "the indexer lease was lost mid-rebuild; resume once no other worker holds it");
    }
  }

  /**
   * Records the failure (only while the run is still `running`, so a run
   * superseded during a stall is not resurrected) and releases the lease
   * unless it was lost — release matches on workerId, which a same-process
   * takeover shares. The failed run keeps the indexer fenced. Never throws.
   */
  private async fail(run: ProjectionRebuildRun, err: unknown, handle: JobLeaseHandle): Promise<ProjectionRebuildRun> {
    const errorCode = err instanceof RebuildHalt || err instanceof EventLogIntegrityError ? err.code : "REPLAY_FAILED";
    const lastError = errorMessage(err).slice(0, MAX_ERROR_LENGTH);
    this.deps.logger?.error({ event: "projection_rebuild.failed", runId: run.id, errorCode, err }, "projection rebuild failed");
    let failed: ProjectionRebuildRun = { ...run, status: "failed", errorCode, lastError };
    try {
      failed = (await this.deps.runs.transition(run.id, "running", { status: "failed", errorCode, lastError })) ??
        (await this.deps.runs.get(run.id)) ??
        failed;
    } catch (storeErr) {
      // The row still says `running`, which keeps the fence up; resume works once the lease lapses.
      this.deps.logger?.error({ runId: run.id, err: storeErr }, "projection rebuild: could not persist failure");
    }
    if (errorCode !== "FENCE_LOST") {
      await this.deps.fence.release(handle).catch((releaseErr) => {
        this.deps.logger?.warn({ runId: run.id, err: releaseErr }, "projection rebuild: lease release failed; it will expire");
      });
    }
    return failed;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Adapters ─────────────────────────────────────────────────────────────────

/** Lease-backed fence on the indexer's own job lease (see `withJobLease` in cron.ts). */
export class LeaseIndexerFence implements IndexerFence {
  constructor(
    private readonly leases: LeaseService,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly workerId = `projection-rebuild-${hostname()}-${randomUUID().slice(0, 8)}`
  ) {}

  acquire(): Promise<JobLeaseHandle | null> {
    return this.leases.acquireJobLease({ jobName: INDEXER_JOB_LEASE, workerId: this.workerId, ttlMs: this.ttlMs });
  }

  renew(handle: JobLeaseHandle): Promise<boolean> {
    return this.leases.renewJobLease(handle.jobName, handle.workerId, handle.fencingToken, this.ttlMs);
  }

  release(handle: JobLeaseHandle): Promise<void> {
    return this.leases.releaseJobLease(handle.jobName, handle.workerId);
  }
}

const toRun = (row: ProjectionRebuild): ProjectionRebuildRun => ({
  ...row,
  status: row.status as ProjectionRebuildStatus
});

export class PrismaProjectionRebuildStore implements ProjectionRebuildStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(run: NewProjectionRebuildRun, supersedes?: string): Promise<ProjectionRebuildRun> {
    const created = await this.prisma.$transaction(async (tx) => {
      if (supersedes) {
        await tx.projectionRebuild.updateMany({
          where: { id: supersedes, status: { in: [...FENCING_STATUSES] } },
          data: { status: "superseded" }
        });
      }
      return tx.projectionRebuild.create({ data: { ...run, status: "running" } });
    });
    return toRun(created);
  }

  async get(id: string): Promise<ProjectionRebuildRun | null> {
    const row = await this.prisma.projectionRebuild.findUnique({ where: { id } });
    return row ? toRun(row) : null;
  }

  async update(id: string, patch: ProjectionRebuildPatch): Promise<ProjectionRebuildRun> {
    return toRun(await this.prisma.projectionRebuild.update({ where: { id }, data: patch }));
  }

  async transition(id: string, from: ProjectionRebuildStatus, patch: ProjectionRebuildPatch): Promise<ProjectionRebuildRun | null> {
    const { count } = await this.prisma.projectionRebuild.updateMany({ where: { id, status: from }, data: patch });
    return count === 1 ? this.get(id) : null;
  }

  async list(limit: number): Promise<ProjectionRebuildRun[]> {
    const rows = await this.prisma.projectionRebuild.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    return rows.map(toRun);
  }

  async findIncomplete(): Promise<ProjectionRebuildRun | null> {
    const row = await this.prisma.projectionRebuild.findFirst({
      where: { status: { in: [...FENCING_STATUSES] } },
      orderBy: { createdAt: "desc" }
    });
    return row ? toRun(row) : null;
  }

  async latestCompleted(): Promise<ProjectionRebuildRun | null> {
    const row = await this.prisma.projectionRebuild.findFirst({
      where: { status: "completed" },
      orderBy: { completedAt: "desc" }
    });
    return row ? toRun(row) : null;
  }
}

export interface PrismaProjectionTargetOptions {
  decoder: XdrDecoder;
  /** Must be the live indexer's VAULT_FACTORY_ADDRESS, or registry events replay differently. */
  factoryAddress?: string;
  batchSize?: number;
  logger?: Logger;
}

/**
 * The live database as a rebuild target. `ledger` must be cache-aware (the
 * same CacheService as the live indexer) so the checkpoint lands where the
 * indexer and the write-behind sync read it, and must register no
 * `onActionConfirmed` callback (side effects are not projections).
 */
export class PrismaProjectionTarget implements ProjectionTarget {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ledger: LedgerService,
    private readonly options: PrismaProjectionTargetOptions
  ) {}

  async validateLog(): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => { await verifyEventLog(tx); },
        { isolationLevel: "RepeatableRead", timeout: 120000 });
    } catch (error) {
      if (error instanceof EventLogIntegrityError) throw AppError.conflict("ILLEGAL_TRANSITION", error.message);
      throw error;
    }
  }

  async logTip(): Promise<string | null> {
    const row = await this.prisma.chainEvent.findFirst({ orderBy: { id: "desc" }, select: { id: true } });
    return row?.id ?? null;
  }

  countEvents(toEventId: string): Promise<number> {
    return this.prisma.chainEvent.count({ where: { id: { lte: toEventId } } });
  }

  /**
   * Resets only what a logged event produced (EXISTS on chain_events), in
   * one transaction. pool_registry is not reset: replay re-upserts every
   * logged registry event, and `active` is operator state replay never sets.
   */
  async resetProjections(): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        DELETE FROM "pending_events" p
        WHERE EXISTS (SELECT 1 FROM "chain_events" c WHERE c."id" = p."soroban_event_id")`,
      this.prisma.$executeRaw`
        DELETE FROM "poison_events" q
        WHERE q."resolved_at" IS NULL
          AND EXISTS (SELECT 1 FROM "chain_events" c WHERE c."id" = q."soroban_event_id")`,
      this.prisma.$executeRaw`
        UPDATE "action_ledger" a
        SET "status" = 'submitted', "soroban_event_id" = NULL, "verified_payload" = NULL,
            "confirmed_at" = NULL, "error_code" = NULL, "error_detail" = NULL, "updated_at" = CURRENT_TIMESTAMP
        WHERE a."status" IN ('confirmed', 'reverted')
          AND EXISTS (SELECT 1 FROM "chain_events" c WHERE c."id" = a."soroban_event_id")`
    ]);
  }

  async openReplay(cursor: string | null, toEventId: string): Promise<ProjectionReplayer> {
    const indexer = new StellarIndexer({
      ledger: this.ledger,
      // Operator-resolved poison events were skipped by the live cursor, so replay skips them too.
      source: new ChainEventLogSource(this.prisma, { toEventId, skipEventIds: await resolvedPoisonEventIds(this.prisma) }),
      decoder: this.options.decoder,
      factoryAddress: this.options.factoryAddress,
      batchSize: this.options.batchSize,
      logger: this.options.logger
    });
    indexer.setCursor(cursor);
    return {
      next: async () => {
        const result = await indexer.tick();
        return { processed: result.processed, quarantined: result.quarantined, cursor: result.cursor };
      }
    };
  }

  async commitCheckpoint(cursor: string, projectionVersion: string): Promise<void> {
    const latestLedger = ledgerOfEventId(cursor) ?? (await this.ledger.getIndexerCheckpoint())?.latestLedger ?? 0;
    await this.ledger.updateIndexerCheckpoint({
      latestLedger,
      lastProcessedEventId: cursor,
      success: true,
      indexerVersion: projectionVersion
    });
  }
}
