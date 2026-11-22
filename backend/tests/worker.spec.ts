import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../src/app.js";
import { AppError } from "../src/errors.js";
import { InMemoryJobStore, type JobStore } from "../src/worker/jobStore.js";
import { PrismaJobStore } from "../src/worker/prismaJobStore.js";
import { JobQueue, JobWorker } from "../src/worker/jobWorker.js";
import { createJobHandlers, drawProofJobKey, JOB_TYPES } from "../src/worker/handlers.js";
import { DEFAULT_RETRY_POLICY, nextDelayMs, sanitizeMessage, toJobFailure } from "../src/worker/retryPolicy.js";
import { NonRetryableJobError, type JobHandler } from "../src/worker/types.js";
import { subscribeTelemetry, type OperationEvent } from "../src/services/telemetry.js";

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const POLICY = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 };

/** Controllable clock so retry scheduling is deterministic. */
function clock(start = Date.UTC(2026, 8, 26)) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function setup(handlers: Record<string, JobHandler>, opts: { store?: JobStore; workerId?: string } = {}) {
  const c = clock();
  const store = opts.store ?? new InMemoryJobStore();
  const queue = new JobQueue({ store, policy: POLICY, now: c.now });
  const worker = new JobWorker({ queue, handlers, now: c.now, rng: () => 1, workerId: opts.workerId ?? "w1", visibilityTimeoutMs: 60_000 });
  return { c, store, queue, worker };
}

describe("retry policy", () => {
  it("backs off exponentially, caps, and jitters within [50%,100%]", () => {
    expect(nextDelayMs(POLICY, 1, () => 1)).toBe(1_000);
    expect(nextDelayMs(POLICY, 2, () => 1)).toBe(2_000);
    expect(nextDelayMs(POLICY, 3, () => 1)).toBe(4_000);
    expect(nextDelayMs(POLICY, 10, () => 1)).toBe(10_000);
    expect(nextDelayMs(POLICY, 2, () => 0)).toBe(1_000);
    expect(nextDelayMs(DEFAULT_RETRY_POLICY, 0, () => 1)).toBe(1_000);
  });

  it("redacts wallets and tx hashes and bounds message size", () => {
    const msg = sanitizeMessage(`failed for ${WALLET} tx ${"a".repeat(64)} ${"x".repeat(1000)}`);
    expect(msg).not.toContain(WALLET);
    expect(msg).toContain("[REDACTED_WALLET]");
    expect(msg).toContain("[REDACTED_TX]");
    expect(msg.length).toBeLessThanOrEqual(500);
  });

  it("classifies failures by type", () => {
    const at = new Date(0);
    expect(toJobFailure(new Error("boom"), 1, at)).toMatchObject({ code: "INTERNAL", retryable: true, attempt: 1 });
    expect(toJobFailure(new NonRetryableJobError("bad", "INVALID_PAYLOAD"), 2, at)).toMatchObject({ code: "INVALID_PAYLOAD", retryable: false });
    expect(toJobFailure(AppError.notFound("x"), 1, at)).toMatchObject({ code: "NOT_FOUND", retryable: false });
    expect(toJobFailure(AppError.unauthorized(), 1, at).retryable).toBe(false);
    expect(toJobFailure(new AppError("NETWORK_ERROR", 502, "down"), 1, at).retryable).toBe(true);
    expect(toJobFailure("plain string", 1, at).message).toBe("plain string");
  });
});

describe("JobQueue", () => {
  it("enqueues idempotently by key", async () => {
    const { queue } = setup({});
    const a = await queue.enqueue({ type: "t", payload: { n: 1 }, idempotencyKey: "k1", correlationId: "c1" });
    const b = await queue.enqueue({ type: "t", payload: { n: 2 }, idempotencyKey: "k1" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    expect(b.job.payload).toEqual({ n: 1 });
    expect(a.job).toMatchObject({ status: "queued", attempts: 0, maxAttempts: 3, correlationId: "c1" });
  });

  it("honours per-job maxAttempts and delayed runAt", async () => {
    const { queue, worker, c } = setup({ t: async () => {} });
    const runAt = new Date(c.now().getTime() + 5_000);
    const { job } = await queue.enqueue({ type: "t", payload: {}, idempotencyKey: "later", runAt, maxAttempts: 9 });
    expect(job.maxAttempts).toBe(9);
    expect((await worker.runOnce()).claimed).toBe(0);
    c.advance(5_000);
    expect((await worker.runOnce()).succeeded).toBe(1);
  });

  it("lists, filters and gets jobs", async () => {
    const { queue } = setup({});
    const a = await queue.enqueue({ type: "a", payload: {}, idempotencyKey: "1" });
    await queue.enqueue({ type: "b", payload: {}, idempotencyKey: "2" });
    expect(await queue.listJobs()).toHaveLength(2);
    expect((await queue.listJobs({ type: "a" })).map((j) => j.id)).toEqual([a.job.id]);
    expect(await queue.listJobs({ status: "dead" })).toEqual([]);
    expect(await queue.listJobs({ limit: 1 })).toHaveLength(1);
    expect((await queue.getJob(a.job.id))?.type).toBe("a");
    expect(await queue.getJob("missing")).toBeNull();
  });
});

describe("JobWorker", () => {
  it("runs a job to success", async () => {
    const seen: string[] = [];
    const { queue, worker } = setup({ t: async (job) => void seen.push(job.idempotencyKey) });
    const { job } = await queue.enqueue({ type: "t", payload: {}, idempotencyKey: "ok" });
    expect(await worker.runOnce()).toEqual({ claimed: 1, succeeded: 1, retried: 0, dead: 0 });
    expect(seen).toEqual(["ok"]);
    const done = await queue.getJob(job.id);
    expect(done).toMatchObject({ status: "succeeded", attempts: 1, lockedBy: null });
    expect(done?.completedAt).toBeInstanceOf(Date);
    expect((await worker.runOnce()).claimed).toBe(0);
  });

  it("retries with backoff, then dead-letters after retry exhaustion keeping every failure", async () => {
    const handler = vi.fn(async () => {
      throw new Error(`upstream 503 for ${WALLET}`);
    });
    const { queue, worker, c } = setup({ t: handler });
    const { job } = await queue.enqueue({ type: "t", payload: { actionId: "a1" }, idempotencyKey: "flaky", correlationId: "corr-1" });

    expect(await worker.runOnce()).toMatchObject({ retried: 1, dead: 0 });
    let cur = await queue.getJob(job.id);
    expect(cur).toMatchObject({ status: "queued", attempts: 1 });
    expect(cur!.runAt.getTime()).toBe(c.now().getTime() + 1_000);
    // Not due yet: no attempt happens.
    expect((await worker.runOnce()).claimed).toBe(0);

    c.advance(1_000);
    expect(await worker.runOnce()).toMatchObject({ retried: 1 });
    expect((await queue.getJob(job.id))!.runAt.getTime()).toBe(c.now().getTime() + 2_000);

    c.advance(2_000);
    expect(await worker.runOnce()).toMatchObject({ retried: 0, dead: 1 });
    cur = await queue.getJob(job.id);
    expect(cur).toMatchObject({ status: "dead", attempts: 3, correlationId: "corr-1", payload: { actionId: "a1" } });
    expect(cur!.failures.map((f) => f.attempt)).toEqual([1, 2, 3]);
    expect(cur!.lastError).toMatchObject({ code: "INTERNAL", retryable: true, attempt: 3 });
    expect(JSON.stringify(cur!.failures)).not.toContain(WALLET);
    expect(handler).toHaveBeenCalledTimes(3);

    // Dead jobs are never picked up again.
    c.advance(1_000_000);
    expect((await worker.runOnce()).claimed).toBe(0);
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("dead-letters immediately on non-retryable errors and unknown job types", async () => {
    const { queue, worker } = setup({
      bad: async () => {
        throw new NonRetryableJobError("nope", "INVALID_PAYLOAD");
      }
    });
    const bad = await queue.enqueue({ type: "bad", payload: {}, idempotencyKey: "b" });
    const unknown = await queue.enqueue({ type: "mystery", payload: {}, idempotencyKey: "m" });
    expect(await worker.runOnce()).toMatchObject({ claimed: 2, dead: 2 });
    expect((await queue.getJob(bad.job.id))!.attempts).toBe(1);
    expect((await queue.getJob(unknown.job.id))!.lastError!.message).toContain("no handler registered");
  });

  it("recovers a crashed worker's job and reprocesses it idempotently", async () => {
    const effects = new Set<string>();
    const handler: JobHandler = async (job) => {
      effects.add(job.idempotencyKey); // idempotent side effect
    };
    const store = new InMemoryJobStore();
    const { queue, c } = setup({}, { store });
    const { job } = await queue.enqueue({ type: "t", payload: {}, idempotencyKey: "once" });

    // Worker A claims the job and "crashes" before completing.
    const [claimed] = await store.claim({ workerId: "A", now: c.now(), visibilityTimeoutMs: 60_000, limit: 1 });
    expect(claimed.id).toBe(job.id);

    // Before the visibility timeout nobody else can take it.
    const workerB = new JobWorker({ queue, handlers: { t: handler }, now: c.now, workerId: "B", visibilityTimeoutMs: 60_000 });
    expect((await workerB.runOnce()).claimed).toBe(0);

    // After it, B reclaims and completes; the effect is applied exactly once.
    c.advance(60_000);
    expect(await workerB.runOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await queue.getJob(job.id)).toMatchObject({ status: "succeeded", attempts: 2 });

    // A resurfaces: its late result is fenced off and cannot clobber B's.
    expect(await store.complete(job.id, "A", c.now())).toBe(false);
    expect(await store.fail(job.id, "A", { failure: toJobFailure(new Error("late"), 1, c.now()), dead: true }, c.now())).toBe(false);
    expect(await queue.getJob(job.id)).toMatchObject({ status: "succeeded", lastError: null });
    expect([...effects]).toEqual(["once"]);
  });

  it("replays a re-enqueued key as a no-op", async () => {
    const handler = vi.fn(async () => {});
    const { queue, worker } = setup({ t: handler });
    await queue.enqueue({ type: "t", payload: {}, idempotencyKey: "same" });
    await worker.runOnce();
    const again = await queue.enqueue({ type: "t", payload: {}, idempotencyKey: "same" });
    expect(again.created).toBe(false);
    await worker.runOnce();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("lets an operator requeue a dead job with a fresh budget", async () => {
    let fail = true;
    const { queue, worker } = setup({
      t: async () => {
        if (fail) throw new NonRetryableJobError("once");
      }
    });
    const { job } = await queue.enqueue({ type: "t", payload: {}, idempotencyKey: "k" });
    await worker.runOnce();
    expect((await queue.getJob(job.id))!.status).toBe("dead");
    expect(await queue.retryDeadJob("missing")).toBeNull();
    expect(await queue.retryDeadJob(job.id)).toMatchObject({ status: "queued", attempts: 0 });
    fail = false;
    expect(await worker.runOnce()).toMatchObject({ succeeded: 1 });
    expect(await queue.retryDeadJob(job.id)).toBeNull(); // only dead jobs can be requeued
  });

  it("reports worker.job telemetry with the job type and correlation id", async () => {
    const events: OperationEvent[] = [];
    const off = subscribeTelemetry((e) => events.push(e));
    const { queue, worker } = setup({
      ok: async () => {},
      bad: async () => {
        throw new NonRetryableJobError("x", "INVALID_PAYLOAD");
      }
    });
    await queue.enqueue({ type: "ok", payload: {}, idempotencyKey: "1", correlationId: "c-ok" });
    await queue.enqueue({ type: "bad", payload: {}, idempotencyKey: "2" });
    await worker.runOnce();
    off();
    const jobEvents = events.filter((e) => e.operation === "worker.job");
    expect(jobEvents.map((e) => [e.detail, e.result, e.actor_type])).toEqual([
      ["ok", "success", "worker"],
      ["bad", "failure", "worker"]
    ]);
    expect(jobEvents[0].correlation_id).toBe("c-ok");
  });

  it("start/stop polls without overlapping ticks and drains in-flight work", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const handler = vi.fn(async () => gate);
      const store = new InMemoryJobStore();
      const queue = new JobQueue({ store, policy: POLICY });
      const worker = new JobWorker({ queue, handlers: { t: handler }, pollIntervalMs: 100, workerId: "w" });
      await queue.enqueue({ type: "t", payload: {}, idempotencyKey: "k" });
      worker.start();
      worker.start(); // idempotent
      await vi.advanceTimersByTimeAsync(350); // several ticks while the first is still blocked
      expect(handler).toHaveBeenCalledTimes(1);
      const stopped = worker.stop();
      release();
      await stopped;
      expect((await queue.listJobs({ status: "succeeded" })).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a failing store during polling", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), child: () => logger, info: vi.fn(), warn: vi.fn() } as any;
      const store = new InMemoryJobStore();
      vi.spyOn(store, "claim").mockRejectedValue(new Error("db down"));
      const worker = new JobWorker({ queue: new JobQueue({ store }), handlers: {}, pollIntervalMs: 100, logger });
      worker.start();
      await vi.advanceTimersByTimeAsync(150);
      await worker.stop();
      expect(logger.error).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("draw proof job handler", () => {
  it("generates the proof for a valid payload and dead-letters an invalid one", async () => {
    const generateProof = vi.fn().mockResolvedValue(null);
    const handlers = createJobHandlers({ drawProofs: { generateProof } as any });
    const { queue, worker } = setup(handlers);
    const good = await queue.enqueue({ type: JOB_TYPES.DRAW_PROOF_GENERATE, payload: { actionId: "a1" }, idempotencyKey: drawProofJobKey("a1") });
    const bad = await queue.enqueue({ type: JOB_TYPES.DRAW_PROOF_GENERATE, payload: {}, idempotencyKey: "bad" });
    await worker.runOnce();
    expect(generateProof).toHaveBeenCalledTimes(1);
    expect(generateProof).toHaveBeenCalledWith({ actionId: "a1" });
    expect((await queue.getJob(good.job.id))!.status).toBe("succeeded");
    const badJob = await queue.getJob(bad.job.id);
    expect(badJob).toMatchObject({ status: "dead", lastError: { code: "INVALID_PAYLOAD" } });
  });

  it("retries transient generation failures", async () => {
    const generateProof = vi.fn().mockRejectedValueOnce(new Error("rpc timeout")).mockResolvedValue(null);
    const { queue, worker, c } = setup(createJobHandlers({ drawProofs: { generateProof } as any }));
    const { job } = await queue.enqueue({ type: JOB_TYPES.DRAW_PROOF_GENERATE, payload: { actionId: "a1" }, idempotencyKey: "k" });
    await worker.runOnce();
    c.advance(1_000);
    await worker.runOnce();
    expect(generateProof).toHaveBeenCalledTimes(2);
    expect((await queue.getJob(job.id))!.status).toBe("succeeded");
  });
});

/** Minimal in-memory stand-in for the Prisma `backgroundJob` delegate. */
function fakePrisma() {
  const rows: any[] = [];
  let seq = 0;
  const match = (r: any, where: any): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === "OR") return v.some((w: any) => match(r, w));
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("lte" in v) return r[k] !== null && r[k] <= v.lte;
        return false;
      }
      if (v instanceof Date) return r[k] instanceof Date && r[k].getTime() === v.getTime();
      return r[k] === v;
    });
  const delegate = {
    findUnique: async ({ where }: any) => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    create: async ({ data }: any) => {
      if (rows.some((r) => r.idempotencyKey === data.idempotencyKey)) throw Object.assign(new Error("dup"), { code: "P2002" });
      const now = new Date();
      const row = { id: `id-${++seq}`, status: "queued", attempts: 0, lockedBy: null, lockedAt: null, lastError: null, failures: [], completedAt: null, createdAt: now, updatedAt: now, ...data };
      rows.push(row);
      return { ...row };
    },
    findMany: async ({ where = {}, orderBy, take }: any) => {
      let out = rows.filter((r) => match(r, where));
      if (orderBy?.runAt) out = out.sort((a, b) => a.runAt - b.runAt);
      if (orderBy?.createdAt) out = out.sort((a, b) => b.createdAt - a.createdAt);
      return out.slice(0, take).map((r) => ({ ...r }));
    },
    updateMany: async ({ where, data }: any) => {
      const hits = rows.filter((r) => match(r, where));
      hits.forEach((r) => Object.assign(r, data));
      return { count: hits.length };
    }
  };
  return { prisma: { backgroundJob: delegate } as any, rows, delegate };
}

describe("PrismaJobStore", () => {
  let fake: ReturnType<typeof fakePrisma>;
  beforeEach(() => {
    fake = fakePrisma();
  });

  it("runs the full retry -> dead-letter -> requeue lifecycle", async () => {
    const store = new PrismaJobStore(fake.prisma);
    const { queue, worker, c } = setup({ t: async () => { throw new Error("nope"); } }, { store });
    const { job } = await queue.enqueue({ type: "t", payload: { a: 1 }, idempotencyKey: "k", correlationId: "c" });
    for (let i = 0; i < 3; i++) {
      await worker.runOnce();
      c.advance(10_000);
    }
    const dead = await queue.getJob(job.id);
    expect(dead).toMatchObject({ status: "dead", attempts: 3, correlationId: "c" });
    expect(dead!.failures).toHaveLength(3);
    expect(await queue.listJobs({ status: "dead", type: "t" })).toHaveLength(1);
    expect(await queue.retryDeadJob(job.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await queue.retryDeadJob(job.id)).toBeNull();
    expect(await queue.getJob("nope")).toBeNull();
  });

  it("enqueue is idempotent, including when it loses a create race", async () => {
    const store = new PrismaJobStore(fake.prisma);
    const now = new Date();
    const input = { type: "t", payload: {}, idempotencyKey: "k", maxAttempts: 3 };
    const a = await store.enqueue(input, now);
    const b = await store.enqueue(input, now);
    expect([a.created, b.created]).toEqual([true, false]);

    // Simulate the race: lookup says "absent", create says "duplicate".
    const spy = vi.spyOn(fake.delegate, "findUnique").mockResolvedValueOnce(null);
    const raced = await store.enqueue(input, now);
    expect(spy).toHaveBeenCalled();
    expect(raced).toMatchObject({ created: false });
    expect(raced.job.id).toBe(a.job.id);
  });

  it("rethrows unexpected create errors", async () => {
    vi.spyOn(fake.delegate, "create").mockRejectedValue(new Error("db down"));
    await expect(new PrismaJobStore(fake.prisma).enqueue({ type: "t", payload: {}, idempotencyKey: "k", maxAttempts: 1 }, new Date())).rejects.toThrow("db down");
    vi.spyOn(fake.delegate, "create").mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    vi.spyOn(fake.delegate, "findUnique").mockResolvedValue(null);
    await expect(new PrismaJobStore(fake.prisma).enqueue({ type: "t", payload: {}, idempotencyKey: "k", maxAttempts: 1 }, new Date())).rejects.toThrow("dup");
  });

  it("claim is compare-and-swap: a contended row is claimed by exactly one worker", async () => {
    const store = new PrismaJobStore(fake.prisma);
    const now = new Date();
    await store.enqueue({ type: "t", payload: {}, idempotencyKey: "k", maxAttempts: 3 }, now);
    const opts = { now, visibilityTimeoutMs: 60_000, limit: 5 };
    const [a, b] = await Promise.all([store.claim({ ...opts, workerId: "A" }), store.claim({ ...opts, workerId: "B" })]);
    expect(a.length + b.length).toBe(1);
  });

  it("fences complete/fail by lock owner and status", async () => {
    const store = new PrismaJobStore(fake.prisma);
    const now = new Date();
    const { job } = await store.enqueue({ type: "t", payload: {}, idempotencyKey: "k", maxAttempts: 3 }, now);
    const failure = toJobFailure(new Error("x"), 1, now);
    expect(await store.complete(job.id, "A", now)).toBe(false); // not running
    expect(await store.fail("missing", "A", { failure, dead: true }, now)).toBe(false);
    await store.claim({ workerId: "A", now, visibilityTimeoutMs: 60_000, limit: 1 });
    expect(await store.complete(job.id, "B", now)).toBe(false); // wrong owner
    expect(await store.fail(job.id, "B", { failure, dead: true }, now)).toBe(false);
    expect(await store.fail(job.id, "A", { failure, dead: false }, now)).toBe(true); // retryAt defaults to now
    expect(await store.get(job.id)).toMatchObject({ status: "queued", lastError: { code: "INTERNAL" } });
    await store.claim({ workerId: "A", now, visibilityTimeoutMs: 60_000, limit: 1 });
    expect(await store.complete(job.id, "A", now)).toBe(true);
  });

  it("reclaims jobs whose lock outlived the visibility timeout", async () => {
    const store = new PrismaJobStore(fake.prisma);
    const t0 = new Date(Date.UTC(2026, 8, 26));
    await store.enqueue({ type: "t", payload: {}, idempotencyKey: "k", maxAttempts: 3 }, t0);
    await store.claim({ workerId: "A", now: t0, visibilityTimeoutMs: 60_000, limit: 1 });
    const early = await store.claim({ workerId: "B", now: new Date(t0.getTime() + 30_000), visibilityTimeoutMs: 60_000, limit: 1 });
    expect(early).toHaveLength(0);
    const late = await store.claim({ workerId: "B", now: new Date(t0.getTime() + 60_000), visibilityTimeoutMs: 60_000, limit: 1 });
    expect(late[0]).toMatchObject({ lockedBy: "B", attempts: 2 });
  });
});

describe("app wiring", () => {
  const SECRET = "s3cret";
  const headers = { "x-internal-secret": SECRET };
  const build = () => buildApp({ prisma: {} as any, internalSecret: SECRET, jobStore: new InMemoryJobStore() });

  it("does not expose a worker or job routes without a job store", async () => {
    const app = buildApp({ prisma: {} as any, internalSecret: SECRET });
    expect(app.jobWorker).toBeUndefined();
    expect((await app.inject({ method: "GET", url: "/internal/jobs", headers })).statusCode).toBe(404);
    await app.close();
  });

  it("requires the service secret for job inspection", async () => {
    const app = build();
    expect((await app.inject({ method: "GET", url: "/internal/jobs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/internal/jobs", headers: { "x-internal-secret": "wrong" } })).statusCode).toBe(401);
    await app.close();
  });

  it("lists, inspects and requeues dead jobs over HTTP", async () => {
    const app = build();
    const queue = app.jobQueue!;
    const { job } = await queue.enqueue({ type: "mystery", payload: { actionId: "a1" }, idempotencyKey: "k", correlationId: "corr-http" });
    const worker = new JobWorker({ queue, handlers: {}, workerId: "w" });
    await worker.runOnce();

    const list = await app.inject({ method: "GET", url: "/internal/jobs?status=dead&limit=10", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const one = await app.inject({ method: "GET", url: `/internal/jobs/${job.id}`, headers });
    expect(one.json().data).toMatchObject({
      id: job.id,
      status: "dead",
      correlation_id: "corr-http",
      payload: { actionId: "a1" },
      attempts: 1,
      max_attempts: 5,
      last_error: { code: "INTERNAL", retryable: false }
    });
    expect(one.json().data.failures).toHaveLength(1);

    const retried = await app.inject({ method: "POST", url: `/internal/jobs/${job.id}/retry`, headers });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().data.status).toBe("queued");

    expect((await app.inject({ method: "POST", url: `/internal/jobs/${job.id}/retry`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/internal/jobs/00000000-0000-4000-8000-000000000000", headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/internal/jobs/not-a-uuid", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/internal/jobs?status=bogus", headers })).statusCode).toBe(400);
    await app.close();
  });

  it("stops the worker when the app closes", async () => {
    const app = build();
    const stop = vi.spyOn(app.jobWorker!, "stop");
    await app.close();
    expect(stop).toHaveBeenCalled();
  });
});
