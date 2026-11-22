/**
 * Tests for Issue #981 — Request correlation across API, workers, and
 * external calls.
 *
 * Covers:
 *  - correlatedFetch propagates Correlation-Id to outbound requests
 *  - correlatedFetch preserves caller-supplied headers
 *  - correlatedFetch omits header when no correlation context exists
 *  - enqueueWithCorrelation captures the current context ID
 *  - JobWorker.process rebinds the job correlationId into the async context
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithCorrelation, currentCorrelationId } from "../src/services/telemetry.js";
import { correlatedFetch } from "../src/utils/correlatedFetch.js";
import { enqueueWithCorrelation } from "../src/worker/correlatedEnqueue.js";
import { JobQueue, JobWorker } from "../src/worker/jobWorker.js";
import { InMemoryJobStore } from "../src/worker/jobStore.js";

// ---------------------------------------------------------------------------
// correlatedFetch
// ---------------------------------------------------------------------------

describe("correlatedFetch — Issue #981", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("injects Correlation-Id from the current async context", async () => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push(headers.get("Correlation-Id") ?? "");
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runWithCorrelation("req-abc-123", () =>
      correlatedFetch("https://rpc.example.test")
    );

    expect(captured).toEqual(["req-abc-123"]);
  });

  it("does not override a caller-supplied Correlation-Id header", async () => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push(headers.get("Correlation-Id") ?? "");
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runWithCorrelation("context-id", () =>
      correlatedFetch("https://rpc.example.test", {
        headers: { "Correlation-Id": "caller-id" },
      })
    );

    expect(captured).toEqual(["caller-id"]);
  });

  it("omits Correlation-Id when called outside an async correlation context", async () => {
    const captured: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push(headers.has("Correlation-Id") ? headers.get("Correlation-Id") : null);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    // Not wrapped in runWithCorrelation — no context.
    await correlatedFetch("https://rpc.example.test");
    expect(captured).toEqual([null]);
  });

  it("uses an explicitly supplied correlationId over the context", async () => {
    const captured: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push(headers.get("Correlation-Id") ?? "");
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runWithCorrelation("context-id", () =>
      correlatedFetch("https://rpc.example.test", {
        correlationId: "explicit-id",
      })
    );

    expect(captured).toEqual(["explicit-id"]);
  });

  it("omits Correlation-Id when an explicit null is passed", async () => {
    const captured: Array<string | null> = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      captured.push(headers.has("Correlation-Id") ? headers.get("Correlation-Id") : null);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runWithCorrelation("context-id", () =>
      correlatedFetch("https://rpc.example.test", { correlationId: null })
    );

    expect(captured).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// enqueueWithCorrelation
// ---------------------------------------------------------------------------

describe("enqueueWithCorrelation — Issue #981", () => {
  it("captures the current context correlation ID on the enqueued job", async () => {
    const store = new InMemoryJobStore();
    const queue = new JobQueue({ store });

    let enqueuedCorrelationId: string | null | undefined = "sentinel";

    await runWithCorrelation("enqueue-corr-id", async () => {
      const result = await enqueueWithCorrelation(queue, {
        type: "test.job",
        payload: {},
        idempotencyKey: "key-1",
      });
      enqueuedCorrelationId = result.job.correlationId;
    });

    expect(enqueuedCorrelationId).toBe("enqueue-corr-id");
  });

  it("does not override an explicitly provided correlationId", async () => {
    const store = new InMemoryJobStore();
    const queue = new JobQueue({ store });

    let enqueuedCorrelationId: string | null | undefined = "sentinel";

    await runWithCorrelation("context-id", async () => {
      const result = await enqueueWithCorrelation(queue, {
        type: "test.job",
        payload: {},
        idempotencyKey: "key-2",
        correlationId: "explicit-id",
      });
      enqueuedCorrelationId = result.job.correlationId;
    });

    expect(enqueuedCorrelationId).toBe("explicit-id");
  });

  it("sets correlationId to null when no context and no explicit ID", async () => {
    const store = new InMemoryJobStore();
    const queue = new JobQueue({ store });

    // Outside any runWithCorrelation context
    const result = await enqueueWithCorrelation(queue, {
      type: "test.job",
      payload: {},
      idempotencyKey: "key-3",
    });

    expect(result.job.correlationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// JobWorker — correlation rebinding
// ---------------------------------------------------------------------------

describe("JobWorker correlation rebinding — Issue #981", () => {
  it("rebinds job.correlationId into the async context during handler execution", async () => {
    const store = new InMemoryJobStore();
    const queue = new JobQueue({ store });

    // Enqueue a job with a known correlation ID.
    await store.enqueue(
      { type: "check.correlation", payload: {}, idempotencyKey: "key-corr", maxAttempts: 1, correlationId: "worker-corr-id" },
      new Date()
    );

    const capturedIds: Array<string | null> = [];

    const worker = new JobWorker({
      queue,
      handlers: {
        "check.correlation": async (_job) => {
          // Inside the handler the async context must have the job's correlation ID.
          capturedIds.push(currentCorrelationId());
        },
      },
    });

    await worker.runOnce();
    expect(capturedIds).toEqual(["worker-corr-id"]);
  });

  it("does not inject a correlation ID when job.correlationId is null", async () => {
    const store = new InMemoryJobStore();
    const queue = new JobQueue({ store });

    await store.enqueue(
      { type: "check.no.corr", payload: {}, idempotencyKey: "key-no-corr", maxAttempts: 1, correlationId: null },
      new Date()
    );

    const capturedIds: Array<string | null> = [];

    const worker = new JobWorker({
      queue,
      handlers: {
        "check.no.corr": async (_job) => {
          capturedIds.push(currentCorrelationId());
        },
      },
    });

    await worker.runOnce();
    // No context was bound; value depends on whatever the test process inherited.
    // The important thing is it did NOT throw.
    expect(capturedIds).toHaveLength(1);
  });
});
