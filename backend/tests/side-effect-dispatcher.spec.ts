import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../src/errors.js";
import { InMemoryJobStore } from "../src/worker/jobStore.js";
import { JobQueue, JobWorker } from "../src/worker/jobWorker.js";
import { InMemoryEffectLedger, type EffectLedger } from "../src/worker/effectLedger.js";
import { PrismaEffectLedger } from "../src/worker/prismaEffectLedger.js";
import {
  SideEffectDispatcher,
  SideEffectInFlightError,
  sideEffectHandler,
  summarizeEffectLedger,
} from "../src/worker/sideEffectDispatcher.js";
import { subscribeTelemetry, type OperationEvent } from "../src/services/telemetry.js";
import type { JobHandler } from "../src/worker/types.js";

/**
 * Idempotent side-effect dispatcher (#923): effects are keyed, retryable,
 * observable, and a dead-letter replay never repeats one that already happened.
 */
const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const POLICY = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 };
const LEASE = 60_000;

function clock(start = Date.UTC(2026, 9, 17)) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function build(ledger: EffectLedger = new InMemoryEffectLedger(), owner = "d1") {
  const c = clock();
  const dispatcher = new SideEffectDispatcher({ ledger, owner, leaseMs: LEASE, now: c.now });
  return { c, ledger, dispatcher };
}

function jobsHarness(c: ReturnType<typeof clock>, handlers: Record<string, JobHandler>) {
  const queue = new JobQueue({ store: new InMemoryJobStore(), policy: POLICY, now: c.now });
  const worker = new JobWorker({ queue, handlers, now: c.now, rng: () => 1, workerId: "w1", visibilityTimeoutMs: LEASE });
  return { queue, worker };
}

describe("SideEffectDispatcher", () => {
  it("runs an effect once and reports later calls as duplicates", async () => {
    const { dispatcher, ledger } = build();
    const effect = vi.fn().mockResolvedValue({ messageId: "m-1" });

    const first = await dispatcher.dispatch({ key: "email:k1", type: "email" }, effect);
    const second = await dispatcher.dispatch({ key: "email:k1", type: "email" }, effect);

    expect(first).toEqual({ status: "executed", result: { messageId: "m-1" }, attempt: 1 });
    expect(second).toEqual({ status: "duplicate", result: { messageId: "m-1" } });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(await ledger.get("email:k1")).toMatchObject({ status: "completed", attempts: 1, lockedBy: null });
  });

  it("keys effects independently", async () => {
    const { dispatcher } = build();
    const effect = vi.fn().mockResolvedValue(null);
    await dispatcher.dispatch({ key: "email:a", type: "email" }, effect);
    await dispatcher.dispatch({ key: "email:b", type: "email" }, effect);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("records a failure, rethrows it unchanged, and lets a replay run the effect", async () => {
    const { dispatcher, ledger } = build();
    const boom = new Error(`provider rejected ${WALLET}`);
    const effect = vi.fn().mockRejectedValueOnce(boom).mockResolvedValue("sent");

    await expect(dispatcher.dispatch({ key: "email:k", type: "email" }, effect)).rejects.toBe(boom);
    expect(await ledger.get("email:k")).toMatchObject({ status: "failed", attempts: 1, lastError: "INTERNAL", lockedBy: null });

    const replay = await dispatcher.dispatch({ key: "email:k", type: "email" }, effect);
    expect(replay).toMatchObject({ status: "executed", result: "sent", attempt: 2 });
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it("stores only the stable error code, never the message", async () => {
    const { dispatcher, ledger } = build();
    await dispatcher.dispatch({ key: "a", type: "t" }, async () => { throw AppError.forbidden(); }).catch(() => {});
    await dispatcher.dispatch({ key: "b", type: "t" }, async () => { throw new Error(`for ${WALLET}`); }).catch(() => {});
    expect((await ledger.get("a"))!.lastError).toBe("FORBIDDEN");
    const b = await ledger.get("b");
    expect(b!.lastError).toBe("INTERNAL");
    expect(JSON.stringify(b)).not.toContain(WALLET);
  });

  it("does not run an effect that another worker is running", async () => {
    const { c, ledger } = build();
    const a = new SideEffectDispatcher({ ledger, owner: "a", leaseMs: LEASE, now: c.now });
    const b = new SideEffectDispatcher({ ledger, owner: "b", leaseMs: LEASE, now: c.now });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const effect = vi.fn(async () => { await gate; return "done"; });

    const running = a.dispatch({ key: "k", type: "email" }, effect);
    const concurrent = await b.dispatch({ key: "k", type: "email" }, effect);
    expect(concurrent).toEqual({ status: "in_flight" });

    release();
    expect(await running).toMatchObject({ status: "executed" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("lets two simultaneous dispatches of one key run the effect once", async () => {
    const { dispatcher } = build();
    const effect = vi.fn().mockResolvedValue(1);
    const results = await Promise.all([
      dispatcher.dispatch({ key: "k", type: "email" }, effect),
      dispatcher.dispatch({ key: "k", type: "email" }, effect),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["executed", "in_flight"]);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("reclaims an effect whose worker crashed, after the lease expires", async () => {
    const { c, ledger, dispatcher } = build();
    await ledger.begin({ key: "k", type: "email", owner: "crashed", now: c.now(), leaseMs: LEASE });
    const effect = vi.fn().mockResolvedValue("ok");

    expect(await dispatcher.dispatch({ key: "k", type: "email" }, effect)).toEqual({ status: "in_flight" });
    c.advance(LEASE + 1);
    expect(await dispatcher.dispatch({ key: "k", type: "email" }, effect)).toMatchObject({ status: "executed", attempt: 2 });
  });

  it("fences a worker that lost its claim from overwriting the new owner's outcome", async () => {
    const { c, ledger } = build();
    await ledger.begin({ key: "k", type: "email", owner: "slow", now: c.now(), leaseMs: LEASE });
    c.advance(LEASE + 1);
    await ledger.begin({ key: "k", type: "email", owner: "fast", now: c.now(), leaseMs: LEASE });

    expect(await ledger.complete("k", "slow", "late", c.now())).toBe(false);
    expect(await ledger.fail("k", "slow", "LATE", c.now())).toBe(false);
    expect(await ledger.complete("k", "fast", "fresh", c.now())).toBe(true);
    expect(await ledger.get("k")).toMatchObject({ status: "completed", result: "fresh" });
  });

  it("rejects an empty or oversized key as a non-retryable error", async () => {
    const { dispatcher } = build();
    await expect(dispatcher.dispatch({ key: "", type: "email" }, async () => 1)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(dispatcher.dispatch({ key: "k".repeat(201), type: "email" }, async () => 1)).rejects.toMatchObject({ name: "NonRetryableJobError" });
  });

  it("emits one telemetry event per dispatch, with the effect type as detail", async () => {
    const { dispatcher } = build();
    const events: OperationEvent[] = [];
    const off = subscribeTelemetry((e) => events.push(e));
    try {
      await dispatcher.dispatch({ key: "k", type: "webhook" }, async () => 1);
      await dispatcher.dispatch({ key: "k", type: "webhook" }, async () => 1);
      await dispatcher.dispatch({ key: "x", type: "webhook" }, async () => { throw AppError.forbidden(); }).catch(() => {});
    } finally {
      off();
    }
    expect(events.map((e) => [e.operation, e.detail, e.result])).toEqual([
      ["side_effect.dispatch", "webhook", "success"],
      ["side_effect.dispatch", "webhook", "success"],
      ["side_effect.dispatch", "webhook", "failure"],
    ]);
    expect(events[2].error_code).toBe("FORBIDDEN");
  });
});

describe("dead-letter replay without duplicate side effects", () => {
  it("re-runs only the effect that failed after the job is requeued from the dead-letter state", async () => {
    const c = clock();
    const dispatcher = new SideEffectDispatcher({ ledger: new InMemoryEffectLedger(), owner: "d1", leaseMs: LEASE, now: c.now });
    const sent: string[] = [];
    let providerDown = true;
    const handler: JobHandler = async (job) => {
      await dispatcher.dispatch({ key: `email:${job.idempotencyKey}`, type: "email" }, async () => { sent.push("email"); });
      await dispatcher.dispatch({ key: `webhook:${job.idempotencyKey}`, type: "webhook" }, async () => {
        if (providerDown) throw new Error("provider 503");
        sent.push("webhook");
      });
    };
    const { queue, worker } = jobsHarness(c, { notify: handler });
    const { job } = await queue.enqueue({ type: "notify", payload: {}, idempotencyKey: "prize-77" });

    for (let i = 0; i < POLICY.maxAttempts; i += 1) {
      await worker.runOnce();
      c.advance(10_000);
    }
    expect((await queue.getJob(job.id))!.status).toBe("dead");
    expect(sent).toEqual(["email"]); // three attempts, one email

    providerDown = false;
    await queue.retryDeadJob(job.id);
    await worker.runOnce();

    expect((await queue.getJob(job.id))!.status).toBe("succeeded");
    expect(sent).toEqual(["email", "webhook"]); // webhook delivered, email not repeated
  });

  it("retries a job whose effect is in flight elsewhere, then runs it once the lease lapses", async () => {
    const c = clock();
    const ledger = new InMemoryEffectLedger();
    const dispatcher = new SideEffectDispatcher({ ledger, owner: "d1", leaseMs: LEASE, now: c.now });
    const run = vi.fn().mockResolvedValue(undefined);
    const { queue, worker } = jobsHarness(c, { notify: sideEffectHandler(dispatcher, { type: "email", run }) });
    await ledger.begin({ key: "email:k", type: "email", owner: "other", now: c.now(), leaseMs: LEASE });
    const { job } = await queue.enqueue({ type: "notify", payload: {}, idempotencyKey: "k" });

    await worker.runOnce();
    expect(run).not.toHaveBeenCalled();
    expect(await queue.getJob(job.id)).toMatchObject({ status: "queued" });
    expect((await queue.getJob(job.id))!.lastError!.message).toContain(new SideEffectInFlightError("email:k").message);

    c.advance(LEASE + 1);
    await worker.runOnce();
    expect(run).toHaveBeenCalledTimes(1);
    expect((await queue.getJob(job.id))!.status).toBe("succeeded");
  });
});

describe("summarizeEffectLedger", () => {
  it("counts by status and type and flags stale claims and failures awaiting replay", async () => {
    const c = clock();
    const ledger = new InMemoryEffectLedger();
    const mk = (key: string, type: string) => ledger.begin({ key, type, owner: "o", now: c.now(), leaseMs: LEASE });
    await mk("done", "email");
    await ledger.complete("done", "o", null, c.now());
    await mk("failed", "webhook");
    await ledger.fail("failed", "o", "INTERNAL", c.now());
    await mk("stuck", "email");
    c.advance(LEASE + 1);
    await mk("fresh", "email");

    const summary = summarizeEffectLedger(await ledger.list(), { now: c.now(), leaseMs: LEASE });
    expect(summary).toMatchObject({
      total: 4,
      byStatus: { completed: 1, failed: 1, in_progress: 2 },
      byType: { email: 3, webhook: 1 },
      staleInProgress: 1,
      awaitingReplay: 1,
    });
    expect(summary.oldestStaleAt).not.toBeNull();
  });
});

/** Minimal in-memory stand-in for the Prisma `sideEffectLedger` delegate. */
function fakePrisma() {
  const rows: any[] = [];
  const match = (r: any, where: any): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === "OR") return v.some((w: any) => match(r, w));
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("lt" in v) return r[k] !== null && r[k] < v.lt;
        return false;
      }
      return r[k] === v;
    });
  const apply = (r: any, data: any) => {
    for (const [k, v] of Object.entries<any>(data)) {
      if (v && typeof v === "object" && "increment" in v) r[k] += v.increment;
      else r[k] = v;
    }
  };
  const delegate = {
    findUnique: async ({ where }: any) => rows.find((r) => r.effectKey === where.effectKey) ?? null,
    create: async ({ data }: any) => {
      if (rows.some((r) => r.effectKey === data.effectKey)) throw Object.assign(new Error("dup"), { code: "P2002" });
      const now = new Date();
      const row = { lockedBy: null, lockedAt: null, lastError: null, result: null, completedAt: null, createdAt: now, updatedAt: now, ...data };
      rows.push(row);
      return { ...row };
    },
    findMany: async ({ where = {}, take }: any) => rows.filter((r) => match(r, where)).slice(0, take).map((r) => ({ ...r })),
    updateMany: async ({ where, data }: any) => {
      const hits = rows.filter((r) => match(r, where));
      hits.forEach((r) => apply(r, data));
      return { count: hits.length };
    },
  };
  return { prisma: { sideEffectLedger: delegate } as any, rows, delegate };
}

describe("PrismaEffectLedger", () => {
  let fake: ReturnType<typeof fakePrisma>;
  beforeEach(() => {
    fake = fakePrisma();
  });

  it("runs the same claim, fail, replay and complete lifecycle as the in-memory ledger", async () => {
    const { dispatcher, ledger } = build(new PrismaEffectLedger(fake.prisma));
    const effect = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue({ id: 1 });

    await dispatcher.dispatch({ key: "k", type: "email" }, effect).catch(() => {});
    expect(await ledger.get("k")).toMatchObject({ status: "failed", attempts: 1, lastError: "INTERNAL" });

    expect(await dispatcher.dispatch({ key: "k", type: "email" }, effect)).toMatchObject({ status: "executed", attempt: 2 });
    expect(await dispatcher.dispatch({ key: "k", type: "email" }, effect)).toEqual({ status: "duplicate", result: { id: 1 } });
    expect(effect).toHaveBeenCalledTimes(2);
    expect(await ledger.list({ status: "completed", type: "email" })).toHaveLength(1);
  });

  it("does not claim a live lease but reclaims an expired one", async () => {
    const ledger = new PrismaEffectLedger(fake.prisma);
    const t0 = new Date(Date.UTC(2026, 9, 17));
    expect((await ledger.begin({ key: "k", type: "t", owner: "a", now: t0, leaseMs: LEASE })).claimed).toBe(true);
    expect((await ledger.begin({ key: "k", type: "t", owner: "b", now: new Date(t0.getTime() + 1_000), leaseMs: LEASE })).claimed).toBe(false);
    const later = await ledger.begin({ key: "k", type: "t", owner: "b", now: new Date(t0.getTime() + LEASE + 1), leaseMs: LEASE });
    expect(later).toMatchObject({ claimed: true, record: { attempts: 2, lockedBy: "b" } });
    expect(await ledger.complete("k", "a", null, t0)).toBe(false);
  });

  it("treats losing the create race as an unclaimed, in-flight effect", async () => {
    const ledger = new PrismaEffectLedger(fake.prisma);
    const now = new Date();
    await ledger.begin({ key: "k", type: "t", owner: "a", now, leaseMs: LEASE });
    vi.spyOn(fake.delegate, "findUnique").mockResolvedValueOnce(null);
    const raced = await ledger.begin({ key: "k", type: "t", owner: "b", now, leaseMs: LEASE });
    expect(raced.claimed).toBe(false);
    expect(raced.record.lockedBy).toBe("a");
  });

  it("rethrows unexpected create errors", async () => {
    vi.spyOn(fake.delegate, "create").mockRejectedValueOnce(new Error("connection reset"));
    await expect(new PrismaEffectLedger(fake.prisma).begin({ key: "k", type: "t", owner: "a", now: new Date(), leaseMs: LEASE })).rejects.toThrow("connection reset");
  });
});
