/**
 * Conflict-aware offline / multi-tab operation queue.
 *
 * Vault deposits, prize-round actions, and wallet flows must not be lost when
 * the browser refreshes, the network drops, or two tabs edit the same record.
 * This module provides a durable queue with optimistic concurrency control:
 *
 *  - every queued operation is written to storage *before* any execution, so
 *    a refresh or crash between attempts resumes exactly where it left off,
 *  - before executing, the queue compares the entity's current version token
 *    with the version captured when the operation was queued. A mismatch is a
 *    conflict: the operation is parked with the same `ConflictError` shape the
 *    rest of the app already uses, and the user gets deterministic
 *    retry/discard choices,
 *  - retrying a conflict re-reads the authoritative version once (no blind
 *    retries), and discarding removes the operation and records a tombstone
 *    so another tab cannot resurrect it,
 *  - transient failures are retried with a deterministic exponential backoff;
 *    permanent failures fail fast into a `failed` state for review,
 *  - snapshots are merged on every read/write, so concurrent tabs converge on
 *    the same queue state (newest `updatedAt` wins, ties broken by id).
 *
 * The engine takes an injectable storage adapter and executor, so the whole
 * lifecycle is testable without a DOM; `useOfflineOperationQueue` wires it to
 * React and online/offline events.
 */

import {
  createConflictError,
  isVersionValid,
  type ConflictError,
  type VersionToken,
} from "./concurrencyControl";

// ── Snapshot model ───────────────────────────────────────────────────────────

export const OFFLINE_QUEUE_SCHEMA = "vaultquest.offline-queue.v1";
export const OFFLINE_QUEUE_STORAGE_KEY = "vaultquest:offline-queue";
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_TOMBSTONE_LIMIT = 200;
export const MAX_BACKOFF_MS = 60_000;

/** Returns the later of `nowIso` and `previousIso + 1ms` so timestamps are strictly monotonic per operation. */
export function nextTimestamp(previousIso: string | undefined, nowIso: string): string {
  if (!previousIso) return nowIso;
  const previous = Date.parse(previousIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(previous)) return nowIso;
  if (!Number.isFinite(now) || now <= previous) return new Date(previous + 1).toISOString();
  return nowIso;
}

export type QueuedOperationStatus = "queued" | "conflict" | "failed";

export interface QueuedOperation {
  id: string;
  entityType: string;
  entityId: string;
  /** User-facing description, e.g. "Increase deposit to 250 XLM". */
  label: string;
  /** Opaque, JSON-serializable payload for the executor. */
  payload: unknown;
  /** Version of the entity when the operation was queued. */
  expectedVersion: VersionToken;
  status: QueuedOperationStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  /** Set when status is "conflict"; mirrors the app-wide conflict shape. */
  conflict: ConflictError | null;
  /** Earliest time the next automatic attempt may run (backoff). */
  nextAttemptAt: string | null;
}

export interface QueueTombstone {
  id: string;
  at: string;
  reason: "completed" | "discarded";
}

export interface QueueSnapshot {
  schema: typeof OFFLINE_QUEUE_SCHEMA;
  revision: number;
  operations: QueuedOperation[];
  tombstones: QueueTombstone[];
  /** False when the storage adapter rejected a write; queue still works in memory. */
  durable: boolean;
}

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Thrown by executors for errors that must not be retried. */
export class PermanentQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentQueueError";
  }
}

function emptySnapshot(): QueueSnapshot {
  return { schema: OFFLINE_QUEUE_SCHEMA, revision: 0, operations: [], tombstones: [], durable: true };
}

function isVersionToken(value: unknown): value is VersionToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token.entityId === "string" &&
    typeof token.entityType === "string" &&
    typeof token.version === "number" &&
    Number.isFinite(token.version)
  );
}

function sanitizeOperation(raw: unknown): QueuedOperation | null {
  if (!raw || typeof raw !== "object") return null;
  const op = raw as Record<string, unknown>;
  if (
    typeof op.id !== "string" ||
    typeof op.entityType !== "string" ||
    typeof op.entityId !== "string" ||
    typeof op.label !== "string" ||
    !isVersionToken(op.expectedVersion)
  ) {
    return null;
  }
  const status: QueuedOperationStatus =
    op.status === "conflict" || op.status === "failed" ? op.status : "queued";
  return {
    id: op.id,
    entityType: op.entityType,
    entityId: op.entityId,
    label: op.label,
    payload: op.payload ?? null,
    expectedVersion: op.expectedVersion,
    status,
    attempts: typeof op.attempts === "number" && op.attempts >= 0 ? Math.floor(op.attempts) : 0,
    maxAttempts:
      typeof op.maxAttempts === "number" && op.maxAttempts > 0 ? Math.floor(op.maxAttempts) : DEFAULT_MAX_ATTEMPTS,
    createdAt: typeof op.createdAt === "string" ? op.createdAt : new Date(0).toISOString(),
    updatedAt: typeof op.updatedAt === "string" ? op.updatedAt : typeof op.createdAt === "string" ? op.createdAt : new Date(0).toISOString(),
    lastError: typeof op.lastError === "string" ? op.lastError : null,
    conflict: (op.conflict as ConflictError | null) ?? null,
    nextAttemptAt: typeof op.nextAttemptAt === "string" ? op.nextAttemptAt : null,
  };
}

/**
 * Reads a queue snapshot from storage. Missing, malformed, or partially
 * corrupt payloads degrade to a usable snapshot rather than throwing —
 * individual bad operations are dropped.
 */
export function loadQueueSnapshot(
  storage: QueueStorage | undefined,
  key: string = OFFLINE_QUEUE_STORAGE_KEY,
): QueueSnapshot {
  if (!storage) return emptySnapshot();
  let parsed: unknown;
  try {
    const text = storage.getItem(key);
    if (!text) return emptySnapshot();
    parsed = JSON.parse(text);
  } catch {
    return emptySnapshot();
  }
  if (!parsed || typeof parsed !== "object") return emptySnapshot();
  const record = parsed as Record<string, unknown>;
  const operations = Array.isArray(record.operations)
    ? record.operations.map(sanitizeOperation).filter((op): op is QueuedOperation => op !== null)
    : [];
  const tombstones = Array.isArray(record.tombstones)
    ? record.tombstones.filter(
        (entry): entry is QueueTombstone =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as QueueTombstone).id === "string" &&
          typeof (entry as QueueTombstone).at === "string",
      )
    : [];
  const revision =
    typeof record.revision === "number" && Number.isSafeInteger(record.revision) && record.revision >= 0
      ? record.revision
      : 0;
  return { schema: OFFLINE_QUEUE_SCHEMA, revision, operations, tombstones, durable: true };
}

function compareOps(a: QueuedOperation, b: QueuedOperation): number {
  const byUpdated = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (byUpdated !== 0) return byUpdated;
  const byStatus = statusRank(a.status) - statusRank(b.status);
  if (byStatus !== 0) return byStatus;
  return a.id.localeCompare(b.id);
}

function statusRank(status: QueuedOperationStatus): number {
  return { queued: 0, conflict: 1, failed: 2 }[status];
}

/**
 * Deterministically merges two snapshots (e.g. two tabs, or memory + disk).
 *
 *  - operations are unioned by id; the newest `updatedAt` wins (ties broken
 *    by status rank, then id),
 *  - a tombstone removes any operation whose `updatedAt` is not newer than the
 *    tombstone timestamp, so a discard in one tab cannot be resurrected by a
 *    stale copy in another,
 *  - tombstones are unioned by id (latest wins) and kept newest-first.
 */
export function mergeQueueSnapshots(a: QueueSnapshot, b: QueueSnapshot): QueueSnapshot {
  const byId = new Map<string, QueuedOperation>();
  for (const op of [...a.operations, ...b.operations]) {
    const existing = byId.get(op.id);
    if (!existing || compareOps(existing, op) < 0) byId.set(op.id, op);
  }

  const tombstoneById = new Map<string, QueueTombstone>();
  for (const tombstone of [...a.tombstones, ...b.tombstones]) {
    const existing = tombstoneById.get(tombstone.id);
    if (!existing || Date.parse(tombstone.at) >= Date.parse(existing.at)) {
      tombstoneById.set(tombstone.id, tombstone);
    }
  }

  const operations = Array.from(byId.values())
    .filter((op) => {
      const tombstone = tombstoneById.get(op.id);
      return !tombstone || Date.parse(tombstone.at) < Date.parse(op.updatedAt);
    })
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt) || x.id.localeCompare(y.id));

  const tombstones = Array.from(tombstoneById.values())
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || x.id.localeCompare(y.id))
    .slice(0, DEFAULT_TOMBSTONE_LIMIT);

  return {
    schema: OFFLINE_QUEUE_SCHEMA,
    revision: Math.max(a.revision, b.revision),
    operations,
    tombstones,
    durable: a.durable && b.durable,
  };
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface EnqueueInput {
  entityType: string;
  entityId: string;
  label: string;
  payload: unknown;
  /** Version of the entity the mutation was composed against. */
  expectedVersion: VersionToken;
  /** Optional stable id (used to make enqueue idempotent across retries). */
  id?: string;
  maxAttempts?: number;
}

export interface FlushReport {
  attempted: number;
  succeeded: number;
  conflicted: number;
  failed: number;
  deferred: number;
  remaining: number;
}

export type ConflictResolution = "retry" | "discard";

export interface OfflineOperationQueueOptions {
  /** Durable storage; when absent the queue only lives for the session. */
  storage?: QueueStorage;
  storageKey?: string;
  now?: () => Date;
  /** Executes one operation against the backend. */
  execute: (operation: QueuedOperation) => Promise<void>;
  /** Reads the entity's current version, or null when it can no longer be found. */
  getVersion: (operation: QueuedOperation) => Promise<VersionToken | null>;
  maxAttempts?: number;
}

/** Deterministic backoff: 1s, 2s, 4s … capped at 60s. */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 6));
  return Math.min(1000 * 2 ** exponent, MAX_BACKOFF_MS);
}

function makeOperationId(input: EnqueueInput, now: Date): string {
  if (input.id) return input.id;
  const seed = `${input.entityType}|${input.entityId}|${input.label}|${now.toISOString()}|${Math.random()}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `op-${(hash >>> 0).toString(36)}-${now.getTime().toString(36)}`;
}

export class OfflineOperationQueue {
  private snapshot: QueueSnapshot;
  private readonly listeners = new Set<(snapshot: QueueSnapshot) => void>();

  constructor(private readonly options: OfflineOperationQueueOptions) {
    this.snapshot = loadQueueSnapshot(options.storage, options.storageKey);
  }

  /** Current in-memory view (merged with the latest durable snapshot). */
  getSnapshot(): QueueSnapshot {
    return this.snapshot;
  }

  list(): QueuedOperation[] {
    return [...this.snapshot.operations];
  }

  conflicts(): QueuedOperation[] {
    return this.snapshot.operations.filter((op) => op.status === "conflict");
  }

  pendingCount(): number {
    return this.snapshot.operations.filter((op) => op.status === "queued").length;
  }

  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-reads storage, merges, and notifies. Call on focus/storage events. */
  reload(): QueueSnapshot {
    if (!this.options.storage) return this.snapshot;
    const disk = loadQueueSnapshot(this.options.storage, this.options.storageKey);
    this.snapshot = mergeQueueSnapshots(disk, this.snapshot);
    this.notify();
    return this.snapshot;
  }

  /**
   * Queues an operation and persists it before returning. De-duplicates by
   * stable id: enqueueing the same id again updates the payload/version in
   * place instead of stacking duplicates.
   */
  enqueue(input: EnqueueInput): QueuedOperation {
    const now = (this.options.now ?? (() => new Date()))();
    const id = makeOperationId(input, now);
    const existing = this.snapshot.operations.find((op) => op.id === id);
    const nowIso = now.toISOString();
    // FIFO ordering must not depend on id randomness when several operations
    // are queued within the same millisecond: createdAt is strictly monotonic
    // across the queue.
    const latestCreatedAt = this.snapshot.operations.reduce<string | undefined>(
      (latest, op) => (!latest || Date.parse(op.createdAt) > Date.parse(latest) ? op.createdAt : latest),
      undefined,
    );
    const operation: QueuedOperation = {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      label: input.label,
      payload: input.payload ?? null,
      expectedVersion: input.expectedVersion,
      status: "queued",
      attempts: existing?.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      createdAt: existing?.createdAt ?? nextTimestamp(latestCreatedAt, nowIso),
      updatedAt: nextTimestamp(existing?.updatedAt, nowIso),
      lastError: null,
      conflict: null,
      nextAttemptAt: null,
    };
    const others = this.snapshot.operations.filter((op) => op.id !== id);
    this.commit({ ...this.snapshot, operations: [...others, operation] });
    return operation;
  }

  /**
   * Attempts every queued operation in FIFO order. Operations for an entity
   * whose earlier operation conflicted or failed are skipped in this pass so
   * per-entity ordering is preserved. Conflicted/failed operations are left
   * for an explicit `resolveConflict`/`retry`/`discard` decision.
   */
  async flush(options: { force?: boolean } = {}): Promise<FlushReport> {
    this.reload();
    const now = (this.options.now ?? (() => new Date()))();
    const report: FlushReport = { attempted: 0, succeeded: 0, conflicted: 0, failed: 0, deferred: 0, remaining: 0 };
    const blockedEntities = new Set<string>();

    // Work on a copy; each mutation commits and persists atomically.
    const ordered = [...this.snapshot.operations].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );

    for (const operation of ordered) {
      const fresh = this.snapshot.operations.find((op) => op.id === operation.id);
      if (!fresh || fresh.status !== "queued") continue;
      const entityKey = `${fresh.entityType}:${fresh.entityId}`;
      if (blockedEntities.has(entityKey)) continue;
      if (!options.force && fresh.nextAttemptAt && Date.parse(fresh.nextAttemptAt) > now.getTime()) {
        report.deferred += 1;
        continue;
      }

      report.attempted += 1;
      let current: VersionToken | null;
      try {
        current = await this.options.getVersion(fresh);
      } catch (error) {
        blockedEntities.add(entityKey);
        this.recordFailure(fresh, error, report, now);
        continue;
      }

      if (!isVersionValid(current, fresh.expectedVersion)) {
        blockedEntities.add(entityKey);
        report.conflicted += 1;
        this.updateOperation(fresh.id, {
          status: "conflict",
          conflict: createConflictError(
            fresh.expectedVersion.entityType,
            fresh.expectedVersion,
            current ?? { entityId: fresh.entityId, entityType: fresh.entityType, version: 0 },
          ),
          updatedAt: now.toISOString(),
          lastError: null,
        });
        continue;
      }

      try {
        await this.options.execute(fresh);
        report.succeeded += 1;
        this.removeOperation(fresh.id, "completed", now);
      } catch (error) {
        blockedEntities.add(entityKey);
        this.recordFailure(fresh, error, report, now);
      }
    }

    report.remaining = this.snapshot.operations.length;
    return report;
  }

  /**
   * Resolves a conflict deterministically:
   *  - `"retry"` re-reads the authoritative version exactly once and requeues
   *    the operation against it; it does not execute the operation directly,
   *    so the caller's normal flush/backoff applies,
   *  - `"discard"` removes the operation and writes a tombstone so a stale
   *    copy in another tab cannot resurrect it.
   */
  async resolveConflict(id: string, choice: ConflictResolution): Promise<QueuedOperation | null> {
    const operation = this.snapshot.operations.find((op) => op.id === id);
    if (!operation) return null;
    const now = (this.options.now ?? (() => new Date()))();

    if (choice === "discard") {
      this.removeOperation(id, "discarded", now);
      return null;
    }

    let fresh: VersionToken | null;
    try {
      fresh = await this.options.getVersion(operation);
    } catch (error) {
      return this.updateOperation(id, {
        status: "failed",
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: now.toISOString(),
      });
    }
    if (!fresh) {
      return this.updateOperation(id, {
        status: "failed",
        lastError: "The record no longer exists; review and discard this queued change.",
        updatedAt: now.toISOString(),
      });
    }

    return this.updateOperation(id, {
      expectedVersion: fresh,
      status: "queued",
      conflict: null,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now.toISOString(),
    });
  }

  /** Manually requeues a failed operation with a fresh attempt budget. */
  retry(id: string): QueuedOperation | null {
    const now = (this.options.now ?? (() => new Date()))();
    const operation = this.snapshot.operations.find((op) => op.id === id);
    if (!operation) return null;
    return this.updateOperation(id, {
      status: "queued",
      attempts: 0,
      conflict: null,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: now.toISOString(),
    });
  }

  /** Discards an operation at any status, writing a tombstone. */
  discard(id: string): boolean {
    if (!this.snapshot.operations.some((op) => op.id === id)) return false;
    this.removeOperation(id, "discarded", (this.options.now ?? (() => new Date()))());
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private recordFailure(
    operation: QueuedOperation,
    error: unknown,
    report: FlushReport,
    now: Date,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof PermanentQueueError;
    const attempts = operation.attempts + 1;
    if (permanent || attempts >= operation.maxAttempts) {
      report.failed += 1;
      this.updateOperation(operation.id, {
        status: "failed",
        attempts,
        lastError: permanent ? `Permanent failure: ${message}` : message,
        nextAttemptAt: null,
        updatedAt: now.toISOString(),
      });
      return;
    }
    this.updateOperation(operation.id, {
      status: "queued",
      attempts,
      lastError: message,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)).toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  private updateOperation(id: string, patch: Partial<QueuedOperation>): QueuedOperation | null {
    const operation = this.snapshot.operations.find((op) => op.id === id);
    if (!operation) return null;
    const nowIso = (this.options.now ?? (() => new Date()))().toISOString();
    const updated: QueuedOperation = {
      ...operation,
      ...patch,
      // Monotonic timestamp: even with a coarse or fixed clock, a resolved
      // operation must be newer than the state it supersedes or the merge
      // would resurrect the stale copy.
      updatedAt: nextTimestamp(operation.updatedAt, patch.updatedAt ?? nowIso),
    };
    this.commit({
      ...this.snapshot,
      operations: this.snapshot.operations.map((op) => (op.id === id ? updated : op)),
    });
    return updated;
  }

  private removeOperation(id: string, reason: QueueTombstone["reason"], now: Date): void {
    const operation = this.snapshot.operations.find((op) => op.id === id);
    const tombstone: QueueTombstone = {
      id,
      at: nextTimestamp(operation?.updatedAt, now.toISOString()),
      reason,
    };
    this.commit({
      ...this.snapshot,
      operations: this.snapshot.operations.filter((op) => op.id !== id),
      tombstones: [tombstone, ...this.snapshot.tombstones].slice(0, DEFAULT_TOMBSTONE_LIMIT),
    });
  }

  /** Merges with the latest durable snapshot, persists, and notifies. */
  private commit(next: QueueSnapshot): void {
    let snapshot: QueueSnapshot = next;
    if (this.options.storage) {
      const disk = loadQueueSnapshot(this.options.storage, this.options.storageKey);
      snapshot = mergeQueueSnapshots(disk, next);
      snapshot.revision = Math.max(disk.revision, next.revision) + 1;
      try {
        this.options.storage.setItem(this.options.storageKey ?? OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        snapshot = { ...snapshot, durable: false };
      }
    }
    this.snapshot = snapshot;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.snapshot);
  }
}
