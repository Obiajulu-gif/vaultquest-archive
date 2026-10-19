/**
 * React binding for the conflict-aware offline operation queue.
 *
 * The engine (`lib/offline-operation-queue.ts`) owns durability and conflict
 * detection; this hook only wires it to React, browser online/offline events,
 * and cross-tab storage events:
 *
 *  - restores the durable queue on mount and flushes when the browser is
 *    online (a refresh or reconnect resumes queued work automatically),
 *  - merges changes written by another tab and re-renders,
 *  - exposes deterministic retry/discard helpers for conflicted operations.
 */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  OfflineOperationQueue,
  type ConflictResolution,
  type EnqueueInput,
  type FlushReport,
  type OfflineOperationQueueOptions,
  type QueuedOperation,
  type QueueSnapshot,
} from "./offline-operation-queue";

export interface UseOfflineOperationQueueOptions {
  execute: OfflineOperationQueueOptions["execute"];
  getVersion: OfflineOperationQueueOptions["getVersion"];
  storage?: OfflineOperationQueueOptions["storage"];
  storageKey?: string;
  maxAttempts?: number;
  /** Automatically flush on mount and when the browser comes back online. Default true. */
  autoFlush?: boolean;
}

export interface UseOfflineOperationQueueResult {
  /** Current operations, FIFO by creation time. */
  operations: QueuedOperation[];
  /** Operations parked on a stale-version conflict. */
  conflicts: QueuedOperation[];
  pendingCount: number;
  snapshot: QueueSnapshot;
  enqueue: (input: EnqueueInput) => QueuedOperation;
  flush: (options?: { force?: boolean }) => Promise<FlushReport>;
  resolveConflict: (id: string, choice: ConflictResolution) => Promise<QueuedOperation | null>;
  retry: (id: string) => QueuedOperation | null;
  discard: (id: string) => boolean;
  reload: () => void;
  isOnline: boolean;
  isFlushing: boolean;
}

export function useOfflineOperationQueue(
  options: UseOfflineOperationQueueOptions,
): UseOfflineOperationQueueResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const queue = useMemo(
    () =>
      new OfflineOperationQueue({
        storage:
          options.storage ?? (typeof window !== "undefined" ? window.localStorage : undefined),
        storageKey: options.storageKey,
        maxAttempts: options.maxAttempts,
        execute: (operation) => optionsRef.current.execute(operation),
        getVersion: (operation) => optionsRef.current.getVersion(operation),
      }),
    // The engine is created once per mount and reads live callbacks via the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [snapshot, setSnapshot] = useState<QueueSnapshot>(() => queue.getSnapshot());
  const [isFlushing, setIsFlushing] = useState(false);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const flushingRef = useRef(false);

  useEffect(() => queue.subscribe(setSnapshot), [queue]);

  const flush = useCallback(
    async (flushOptions: { force?: boolean } = {}) => {
      if (flushingRef.current) {
        return { attempted: 0, succeeded: 0, conflicted: 0, failed: 0, deferred: 0, remaining: snapshot.operations.length };
      }
      flushingRef.current = true;
      setIsFlushing(true);
      try {
        return await queue.flush(flushOptions);
      } finally {
        flushingRef.current = false;
        setIsFlushing(false);
      }
    },
    [queue, snapshot.operations.length],
  );

  // Resume queued work when the app mounts online, and whenever the browser
  // reconnects or another tab writes to the shared queue.
  useEffect(() => {
    const autoFlush = optionsRef.current.autoFlush !== false;
    if (autoFlush && (typeof navigator === "undefined" || navigator.onLine)) void flush();
    if (typeof window === "undefined") return;

    const onOnline = () => {
      setIsOnline(true);
      if (autoFlush) void flush();
    };
    const onOffline = () => setIsOnline(false);
    const onStorage = () => queue.reload();

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("storage", onStorage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  const enqueue = useCallback((input: EnqueueInput) => queue.enqueue(input), [queue]);

  const resolveConflict = useCallback(
    (id: string, choice: ConflictResolution) => queue.resolveConflict(id, choice),
    [queue],
  );

  const retry = useCallback((id: string) => queue.retry(id), [queue]);
  const discard = useCallback((id: string) => queue.discard(id), [queue]);
  const reload = useCallback(() => queue.reload(), [queue]);

  return {
    operations: snapshot.operations,
    conflicts: snapshot.operations.filter((op) => op.status === "conflict"),
    pendingCount: snapshot.operations.filter((op) => op.status === "queued").length,
    snapshot,
    enqueue,
    flush,
    resolveConflict,
    retry,
    discard,
    reload,
    isOnline,
    isFlushing,
  };
}
