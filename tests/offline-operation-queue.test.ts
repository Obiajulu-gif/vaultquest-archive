import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_ATTEMPTS,
  OfflineOperationQueue,
  PermanentQueueError,
  OFFLINE_QUEUE_STORAGE_KEY,
  loadQueueSnapshot,
  mergeQueueSnapshots,
  retryDelayMs,
  type QueuedOperation,
  type QueueSnapshot,
  type QueueStorage,
} from "../lib/offline-operation-queue";
import type { VersionToken } from "../lib/concurrencyControl";

function fakeStorage(initial: Record<string, string> = {}): QueueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  };
}

const T0 = new Date("2026-10-16T12:00:00.000Z");

function version(overrides: Partial<VersionToken> = {}): VersionToken {
  return { entityId: "pool-1", entityType: "saved_pool", version: 5, ...overrides };
}

function makeQueue(
  storage: QueueStorage | undefined,
  execute: (op: QueuedOperation) => Promise<void>,
  getVersion: (op: QueuedOperation) => Promise<VersionToken | null>,
  nowMs = T0.getTime(),
) {
  return new OfflineOperationQueue({
    storage,
    execute,
    getVersion,
    now: () => new Date(nowMs),
  });
}

describe("durable queue persistence", () => {
  it("persists an enqueued operation before any execution", () => {
    const storage = fakeStorage();
    const execute = vi.fn(async () => {});
    const queue = makeQueue(storage, execute, async () => version());

    const op = queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Update saved pool",
      payload: { note: "watchlist" },
      expectedVersion: version(),
    });

    expect(execute).not.toHaveBeenCalled();
    const persisted = loadQueueSnapshot(storage);
    expect(persisted.operations).toHaveLength(1);
    expect(persisted.operations[0].id).toBe(op.id);
    expect(persisted.operations[0].status).toBe("queued");
  });

  it("resumes queued work after a refresh with a brand-new engine instance", async () => {
    const storage = fakeStorage();
    const first = makeQueue(storage, async () => {}, async () => version());
    first.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Deposit",
      payload: { amount: 100 },
      expectedVersion: version(),
    });

    const execute = vi.fn(async () => {});
    const reloaded = makeQueue(storage, execute, async () => version());
    const report = await reloaded.flush();

    expect(report.succeeded).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(reloaded.list()).toHaveLength(0);
    expect(loadQueueSnapshot(storage).tombstones[0]?.reason).toBe("completed");
  });

  it("degrades to an in-memory queue when storage writes fail", async () => {
    const storage: QueueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    const queue = makeQueue(storage, async () => {}, async () => version());
    const op = queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Deposit",
      payload: {},
      expectedVersion: version(),
    });
    expect(op.id).toBeTruthy();
    expect(queue.getSnapshot().durable).toBe(false);
    expect((await queue.flush()).succeeded).toBe(1);
  });

  it("tolerates corrupt storage payloads and drops malformed operations", () => {
    const storage = fakeStorage({ [OFFLINE_QUEUE_STORAGE_KEY]: "{not json" });
    expect(loadQueueSnapshot(storage).operations).toEqual([]);

    storage.map.set(
      OFFLINE_QUEUE_STORAGE_KEY,
      JSON.stringify({
        schema: "vaultquest.offline-queue.v1",
        revision: 4,
        operations: [
          { id: "good", entityType: "t", entityId: "1", label: "ok", expectedVersion: version(), status: "queued" },
          { id: "bad" },
        ],
        tombstones: [],
      }),
    );
    const snapshot = loadQueueSnapshot(storage);
    expect(snapshot.operations.map((op) => op.id)).toEqual(["good"]);
    expect(snapshot.revision).toBe(4);
  });
});

describe("conflict detection and resolution", () => {
  it("parks an operation on a stale version without executing it", async () => {
    const storage = fakeStorage();
    const execute = vi.fn(async () => {});
    const queue = makeQueue(storage, execute, async () => version({ version: 6 }));
    queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Rename saved pool",
      payload: { name: "New name" },
      expectedVersion: version({ version: 5 }),
    });

    const report = await queue.flush();
    expect(report.conflicted).toBe(1);
    expect(execute).not.toHaveBeenCalled();

    const [conflict] = queue.conflicts();
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflict?.expectedVersion.version).toBe(5);
    expect(conflict.conflict?.actualVersion.version).toBe(6);
    expect(conflict.conflict?.userMessage.length).toBeGreaterThan(0);
    // Conflicts are durable: a reload still shows the parked operation.
    expect(loadQueueSnapshot(storage).operations[0].status).toBe("conflict");
  });

  it("retries a conflict against the authoritative version and then succeeds", async () => {
    const storage = fakeStorage();
    let serverVersion = version({ version: 5 });
    const execute = vi.fn(async () => {});
    const queue = makeQueue(storage, execute, async () => serverVersion);
    queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Rename saved pool",
      payload: { name: "New name" },
      expectedVersion: version({ version: 5 }),
    });

    serverVersion = version({ version: 6 });
    await queue.flush();
    const [conflict] = queue.conflicts();
    const requeued = await queue.resolveConflict(conflict.id, "retry");
    expect(requeued?.status).toBe("queued");
    expect(requeued?.expectedVersion.version).toBe(6);

    const report = await queue.flush();
    expect(report.succeeded).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("discards a conflict and records a tombstone", async () => {
    const queue = makeQueue(undefined, async () => {}, async () => version({ version: 9 }));
    queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Rename saved pool",
      payload: {},
      expectedVersion: version({ version: 5 }),
    });
    await queue.flush();
    const [conflict] = queue.conflicts();

    expect(await queue.resolveConflict(conflict.id, "discard")).toBeNull();
    expect(queue.list()).toHaveLength(0);
    expect(queue.getSnapshot().tombstones[0]?.reason).toBe("discarded");
  });

  it("fails a conflict retry when the record no longer exists", async () => {
    const queue = makeQueue(undefined, async () => {}, async () => version({ version: 9 }));
    queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Rename saved pool",
      payload: {},
      expectedVersion: version({ version: 5 }),
    });
    await queue.flush();

    const queueMissing = makeQueue(undefined, async () => {}, async () => null);
    queueMissing.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Rename saved pool",
      payload: {},
      expectedVersion: version({ version: 5 }),
    });
    const missing = await queueMissing.flush().then(() => queueMissing.conflicts()[0]);
    const outcome = await queueMissing.resolveConflict(missing.id, "retry");
    expect(outcome?.status).toBe("failed");
    expect(outcome?.lastError).toContain("no longer exists");
  });
});

describe("failure handling and backoff", () => {
  it("retries transient failures with deterministic backoff and gives up at maxAttempts", async () => {
    let clock = T0.getTime();
    const queue = new OfflineOperationQueue({
      execute: async () => {
        throw new Error("network unreachable");
      },
      getVersion: async () => version(),
      maxAttempts: 3,
      now: () => new Date(clock),
    });
    queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Deposit",
      payload: {},
      expectedVersion: version(),
    });

    const first = await queue.flush();
    expect(first.attempted).toBe(1);
    const afterFirst = queue.list()[0];
    expect(afterFirst.status).toBe("queued");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.lastError).toContain("network unreachable");
    expect(Date.parse(afterFirst.nextAttemptAt!)).toBe(clock + retryDelayMs(1));

    // Before the backoff elapses the operation is deferred, not attempted.
    const deferred = await queue.flush();
    expect(deferred.attempted).toBe(0);
    expect(deferred.deferred).toBe(1);

    clock += retryDelayMs(1);
    await queue.flush();
    expect(queue.list()[0].attempts).toBe(2);

    clock += retryDelayMs(2);
    const final = await queue.flush();
    expect(final.failed).toBe(1);
    expect(queue.list()[0].status).toBe("failed");
  });

  it("fails fast on permanent errors without consuming retries", async () => {
    const queue = makeQueue(undefined, async () => {
      throw new PermanentQueueError("validation rejected");
    }, async () => version());
    queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Deposit",
      payload: {},
      expectedVersion: version(),
    });
    await queue.flush();
    const [op] = queue.list();
    expect(op.status).toBe("failed");
    expect(op.lastError).toContain("Permanent failure");
    expect(op.attempts).toBe(1);
  });

  it("manual retry resets a failed operation with a fresh attempt budget", async () => {
    let shouldFail = true;
    const queue = makeQueue(undefined, async () => {
      if (shouldFail) throw new PermanentQueueError("boom");
    }, async () => version());
    const op = queue.enqueue({
      entityType: "saved_pool",
      entityId: "pool-1",
      label: "Deposit",
      payload: {},
      expectedVersion: version(),
    });
    await queue.flush();
    expect(queue.list()[0].status).toBe("failed");

    shouldFail = false;
    const requeued = queue.retry(op.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.attempts).toBe(0);
    expect((await queue.flush()).succeeded).toBe(1);
  });

  it("keeps per-entity ordering: a failed head blocks later ops for the same entity only", async () => {
    const executed: string[] = [];
    const queue = makeQueue(
      undefined,
      async (op) => {
        executed.push(op.label);
        if (op.label === "first") throw new PermanentQueueError("head failed");
      },
      async () => version(),
    );
    queue.enqueue({ entityType: "pool", entityId: "A", label: "first", payload: {}, expectedVersion: version() });
    queue.enqueue({ entityType: "pool", entityId: "A", label: "second", payload: {}, expectedVersion: version() });
    queue.enqueue({ entityType: "pool", entityId: "B", label: "other", payload: {}, expectedVersion: version() });

    await queue.flush();
    expect(executed).toEqual(["first", "other"]);
    const statuses = Object.fromEntries(queue.list().map((op) => [op.label, op.status]));
    expect(statuses.first).toBe("failed");
    expect(statuses.second).toBe("queued");
    expect(statuses.other).toBeUndefined(); // executed and removed
  });

  it("bounds the backoff and defaults to five attempts", () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(99)).toBe(60_000);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
  });
});

describe("multi-tab convergence", () => {
  it("merges snapshots by newest updatedAt with a deterministic tiebreak", () => {
    const base: QueueSnapshot = loadQueueSnapshot(undefined);
    const older = {
      ...base,
      operations: [
        { id: "op-1", entityType: "t", entityId: "1", label: "older", payload: {}, expectedVersion: version(), status: "queued" as const, attempts: 0, maxAttempts: 5, createdAt: "2026-10-16T10:00:00.000Z", updatedAt: "2026-10-16T10:00:00.000Z", lastError: null, conflict: null, nextAttemptAt: null },
      ],
    };
    const newer = {
      ...base,
      operations: [
        { ...older.operations[0], label: "newer", status: "failed" as const, updatedAt: "2026-10-16T11:00:00.000Z" },
      ],
    };
    const merged = mergeQueueSnapshots(older, newer);
    expect(merged.operations).toHaveLength(1);
    expect(merged.operations[0].label).toBe("newer");
    expect(merged.operations[0].status).toBe("failed");
  });

  it("a discard in one tab cannot be resurrected by a stale copy in another", () => {
    const storage = fakeStorage();
    const tabA = makeQueue(storage, async () => {}, async () => version());
    tabA.enqueue({ entityType: "pool", entityId: "A", label: "deposit", payload: {}, expectedVersion: version() });
    const [op] = tabA.list();

    // Tab B loaded before the discard, so its memory still contains the op.
    const staleSnapshot: QueueSnapshot = tabA.getSnapshot();
    const tabB = new OfflineOperationQueue({
      storage,
      execute: async () => {},
      getVersion: async () => version(),
    });
    tabA.discard(op.id);

    // Tab B commits an unrelated change; the merge must honor tab A's tombstone.
    const resurrected = mergeQueueSnapshots(loadQueueSnapshot(storage), {
      ...staleSnapshot,
      operations: [
        ...staleSnapshot.operations,
        { entityType: "pool", entityId: "B", label: "other", payload: {}, expectedVersion: version(), id: "op-b", status: "queued", attempts: 0, maxAttempts: 5, createdAt: T0.toISOString(), updatedAt: T0.toISOString(), lastError: null, conflict: null, nextAttemptAt: null },
      ],
    });
    expect(resurrected.operations.map((entry) => entry.id)).toEqual(["op-b"]);
    tabB.reload();
    expect(tabB.list()).toHaveLength(0);
  });

  it("two tabs sharing storage converge after reload", async () => {
    const storage = fakeStorage();
    const tabA = makeQueue(storage, async () => {}, async () => version());
    const tabB = makeQueue(storage, async () => {}, async () => version());

    tabA.enqueue({ entityType: "pool", entityId: "A", label: "from A", payload: {}, expectedVersion: version() });
    tabB.enqueue({ entityType: "pool", entityId: "B", label: "from B", payload: {}, expectedVersion: version() });

    tabA.reload();
    tabB.reload();
    expect(tabA.list().map((op) => op.label).sort()).toEqual(["from A", "from B"]);
    expect(tabB.list().map((op) => op.label).sort()).toEqual(["from A", "from B"]);

    const report = await tabA.flush();
    expect(report.succeeded).toBe(2);
    tabB.reload();
    expect(tabB.list()).toHaveLength(0);
  });

  it("notifies subscribers on every committed change", () => {
    const queue = makeQueue(undefined, async () => {}, async () => version());
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    queue.enqueue({ entityType: "pool", entityId: "A", label: "x", payload: {}, expectedVersion: version() });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    queue.enqueue({ entityType: "pool", entityId: "A", label: "y", payload: {}, expectedVersion: version() });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates enqueue by stable id", () => {
    const queue = makeQueue(undefined, async () => {}, async () => version());
    queue.enqueue({ id: "fixed", entityType: "pool", entityId: "A", label: "one", payload: {}, expectedVersion: version() });
    queue.enqueue({ id: "fixed", entityType: "pool", entityId: "A", label: "one-updated", payload: {}, expectedVersion: version({ version: 6 }) });
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0].label).toBe("one-updated");
    expect(queue.list()[0].expectedVersion.version).toBe(6);
  });
});
