/**
 * #989 — versioned projection rebuild: normal, failure, retry and
 * authorization paths. The service is exercised through its ports with
 * in-memory doubles that model the real contracts (a lease that only one
 * holder can own, a log replayed in id order that halts at a quarantined
 * event), so every path runs without a database.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { JobLeaseHandle } from "../src/services/leaseService.js";
import { AppError } from "../src/errors.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { requirePermission, walletSessionResolver } from "../src/middleware/rbac.js";
import { AuditTrailService, InMemoryAuditTrailStore, type AuditActor } from "../src/services/auditTrail.js";
import {
  ProjectionRebuildService,
  isIndexerFenced,
  type IndexerFence,
  type NewProjectionRebuildRun,
  type ProjectionRebuildPatch,
  type ProjectionRebuildRun,
  type ProjectionRebuildStore,
  type ProjectionReplayer,
  type ProjectionTarget
} from "../src/services/projectionRebuild.js";
import { projectionRebuildRoutes } from "../src/routes/projectionRebuilds.js";

const V1 = "20261001000001";
const V2 = "20261020000000";
const ACTOR: AuditActor = { subject: "GADMIN", role: "maintainer" };

// ─── Doubles ──────────────────────────────────────────────────────────────────

class MemoryRunStore implements ProjectionRebuildStore {
  readonly rows = new Map<string, ProjectionRebuildRun>();
  private seq = 0;

  async create(run: NewProjectionRebuildRun, supersedes?: string): Promise<ProjectionRebuildRun> {
    const old = supersedes ? this.rows.get(supersedes) : undefined;
    if (old && (old.status === "running" || old.status === "failed")) this.rows.set(old.id, { ...old, status: "superseded" });
    const at = new Date(Date.UTC(2026, 9, 20, 0, 0, ++this.seq));
    const row: ProjectionRebuildRun = {
      ...run,
      id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`,
      status: "running",
      cursor: null,
      eventsReplayed: 0,
      attempts: 1,
      errorCode: null,
      lastError: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null
    };
    this.rows.set(row.id, row);
    return { ...row };
  }
  async get(id: string) {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async update(id: string, patch: ProjectionRebuildPatch) {
    const row = { ...this.rows.get(id)!, ...patch, updatedAt: new Date() };
    this.rows.set(id, row);
    return { ...row };
  }
  async transition(id: string, from: ProjectionRebuildRun["status"], patch: ProjectionRebuildPatch) {
    return this.rows.get(id)?.status === from ? this.update(id, patch) : null;
  }
  async list(limit: number) {
    return [...this.rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
  }
  async findIncomplete() {
    return (await this.list(1000)).find((r) => r.status === "running" || r.status === "failed") ?? null;
  }
  async latestCompleted() {
    const done = [...this.rows.values()].filter((r) => r.status === "completed");
    return done.sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())[0] ?? null;
  }
}

/** A log of ordered event ids; "projections" are the ids applied since the last reset. */
class MemoryTarget implements ProjectionTarget {
  readonly applied = new Set<string>();
  readonly quarantine = new Set<string>();
  resets = 0;
  checkpoint: { cursor: string; version: string } | null = null;
  /** Throw on the Nth batch (1-based) of the next replay. */
  failOnBatch: number | null = null;
  /** Runs before every batch; lets a test interfere mid-replay. */
  beforeBatch: (batch: number) => void = () => {};

  constructor(readonly log: string[], private readonly batchSize = 2) {
    this.log.forEach((id) => this.applied.add(id)); // the live projection before any rebuild
  }

  async logTip() {
    return this.log.at(-1) ?? null;
  }
  async countEvents(toEventId: string) {
    return this.log.filter((id) => id <= toEventId).length;
  }
  async resetProjections() {
    this.resets++;
    this.applied.clear();
  }
  async openReplay(cursor: string | null, toEventId: string): Promise<ProjectionReplayer> {
    let position = cursor;
    let batchNo = 0;
    return {
      next: async () => {
        this.beforeBatch(++batchNo);
        if (this.failOnBatch === batchNo) throw new Error("connection terminated unexpectedly");
        const batch = this.log.filter((id) => (position === null || id > position) && id <= toEventId).slice(0, this.batchSize);
        for (const id of batch) {
          if (this.quarantine.has(id)) return { processed: batch.length, quarantined: 1, cursor: position };
          this.applied.add(id);
          position = id;
        }
        return { processed: batch.length, quarantined: 0, cursor: position };
      }
    };
  }
  async commitCheckpoint(cursor: string, version: string) {
    this.checkpoint = { cursor, version };
  }
}

/**
 * Mirrors LeaseService: renew needs the current fencing token, but release
 * (`releaseJobLease`) matches on workerId only — and every rebuild in one
 * process shares a workerId.
 */
class MemoryFence implements IndexerFence {
  holder: bigint | null = null;
  private token = 0n;

  async acquire(): Promise<JobLeaseHandle | null> {
    if (this.holder !== null) return null;
    this.holder = ++this.token;
    return { jobName: "stellar-indexer", workerId: "rebuild", fencingToken: this.holder };
  }
  async renew(handle: JobLeaseHandle) {
    return this.holder === handle.fencingToken;
  }
  async release(handle: JobLeaseHandle) {
    if (handle.workerId === "rebuild") this.holder = null;
  }
  /** The lease expires and is taken over by this same process (same workerId, new token). */
  steal() {
    this.holder = ++this.token;
  }
}

function setup(opts: { log?: string[]; version?: string; audit?: { record: (i: unknown) => Promise<unknown> } } = {}) {
  const runs = new MemoryRunStore();
  const target = new MemoryTarget(opts.log ?? ["e1", "e2", "e3", "e4", "e5"]);
  const fence = new MemoryFence();
  const auditStore = new InMemoryAuditTrailStore();
  const svc = new ProjectionRebuildService({
    runs,
    target,
    fence,
    audit: opts.audit ?? new AuditTrailService(auditStore),
    projectionVersion: opts.version ?? V1
  });
  return { runs, target, fence, auditStore, svc };
}

async function expectAppError(promise: Promise<unknown>, code: string, statusCode: number) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect({ code: (err as AppError).code, statusCode: (err as AppError).statusCode }).toEqual({ code, statusCode });
}

// ─── Normal path ──────────────────────────────────────────────────────────────

describe("projection rebuild — normal path (#989)", () => {
  it("plans a dry run without writing anything", async () => {
    const { svc, runs, target } = setup();
    const plan = await svc.plan();
    expect(plan).toEqual({
      projectionVersion: V1,
      lastRebuiltVersion: null,
      rebuildRecommended: true,
      isDowngrade: false,
      toEventId: "e5",
      eventsToReplay: 5,
      activeRun: null
    });
    expect(runs.rows.size).toBe(0);
    expect(target.resets).toBe(0);
  });

  it("resets, replays the whole log, stamps the checkpoint with the version and lifts the fence", async () => {
    const { svc, target, fence, runs, auditStore } = setup();
    const { run, done } = await svc.start({ actor: ACTOR, reason: "decoder fix for fpooldep" });

    expect(run.status).toBe("running");
    expect(await svc.isFenced()).toBe(true); // fenced from the moment the run exists

    const finished = await done;
    expect(finished).toMatchObject({ status: "completed", cursor: "e5", eventsReplayed: 5, toEventId: "e5", attempts: 1 });
    expect(target.resets).toBe(1);
    expect([...target.applied]).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(target.checkpoint).toEqual({ cursor: "e5", version: V1 });
    expect(fence.holder).toBeNull();
    expect(await isIndexerFenced(runs)).toBe(false);

    const [audit] = await auditStore.query({ category: "recovery", limit: 10 });
    expect(audit).toMatchObject({
      action: "projection.rebuild.start",
      actor: ACTOR,
      reason: "decoder fix for fpooldep",
      target: { type: "projection_rebuild", id: run.id }
    });

    const plan = await svc.plan();
    expect(plan).toMatchObject({ lastRebuiltVersion: V1, rebuildRecommended: false, activeRun: null });
  });

  it("completes an empty log without touching the checkpoint", async () => {
    const { svc, target } = setup({ log: [] });
    const finished = await (await svc.start({ actor: ACTOR, reason: "fresh deploy" })).done;
    expect(finished.status).toBe("completed");
    expect(target.resets).toBe(0);
    expect(target.checkpoint).toBeNull();
  });

  it("never replays past the log tip captured at start", async () => {
    const { svc, target } = setup();
    target.beforeBatch = (n) => {
      if (n === 1) target.log.push("e6"); // cannot happen while fenced; proves the bound anyway
    };
    const finished = await (await svc.start({ actor: ACTOR, reason: "bounded" })).done;
    expect(finished.cursor).toBe("e5");
    expect(target.applied.has("e6")).toBe(false);
  });
});

// ─── Failure path ─────────────────────────────────────────────────────────────

describe("projection rebuild — failure path (#989)", () => {
  it("records a mid-replay failure, keeps committed progress and keeps the indexer fenced", async () => {
    const { svc, target, fence, runs } = setup();
    target.failOnBatch = 2;
    const failed = await (await svc.start({ actor: ACTOR, reason: "rebuild" })).done;

    expect(failed).toMatchObject({ status: "failed", errorCode: "REPLAY_FAILED", cursor: "e2", eventsReplayed: 2 });
    expect(failed.lastError).toContain("connection terminated");
    expect(target.checkpoint).toBeNull();
    expect(fence.holder).toBeNull(); // released so any replica can resume
    expect(await isIndexerFenced(runs)).toBe(true);
  });

  it("halts at a quarantined event with the cursor just before the gap", async () => {
    const { svc, target } = setup();
    target.quarantine.add("e4");
    const failed = await (await svc.start({ actor: ACTOR, reason: "rebuild" })).done;

    expect(failed).toMatchObject({ status: "failed", errorCode: "HALTED_ON_QUARANTINE", cursor: "e3" });
    expect(target.applied.has("e4")).toBe(false);
    expect(target.checkpoint).toBeNull();
  });

  it("stops writing when the indexer lease is taken over mid-rebuild", async () => {
    const { svc, target, fence } = setup();
    target.beforeBatch = (n) => {
      if (n === 2) fence.steal();
    };
    const failed = await (await svc.start({ actor: ACTOR, reason: "rebuild" })).done;

    // The takeover lands while batch 2 is in flight; the renew before batch 3 fails, so it never runs.
    expect(failed).toMatchObject({ status: "failed", errorCode: "FENCE_LOST", cursor: "e4" });
    expect(target.applied.has("e5")).toBe(false);
    expect(target.checkpoint).toBeNull();
    expect(fence.holder).not.toBeNull(); // the new holder's lease is left alone
  });

  it("does not resurrect a run that was superseded while its executor was stalled", async () => {
    const { svc, target, fence, runs } = setup();
    let staleId = "";
    target.beforeBatch = (n) => {
      if (n !== 2) return;
      // The stalled executor's lease lapsed; another start took over and superseded it.
      fence.steal();
      void runs.create({ projectionVersion: V1, requestedBy: "GOTHER", reason: "fresh", toEventId: "e5", heartbeatAt: null }, staleId);
    };
    const { run, done } = await svc.start({ actor: ACTOR, reason: "stalls" });
    staleId = run.id;
    const finished = await done;

    expect(finished.status).toBe("superseded");
    expect((await runs.get(run.id))!.status).toBe("superseded");
    expect((await runs.findIncomplete())!.requestedBy).toBe("GOTHER");
  });

  it("refuses to start while the indexer holds its lease, without creating a run", async () => {
    const { svc, fence, runs, target } = setup();
    await fence.acquire(); // an indexer tick is in flight
    await expectAppError(svc.start({ actor: ACTOR, reason: "rebuild" }), "PROJECTION_REBUILD_BUSY", 409);
    expect(runs.rows.size).toBe(0);
    expect(target.resets).toBe(0);
  });

  it("does not run an unaudited rebuild", async () => {
    const audit = { record: vi.fn(async () => Promise.reject(new Error("audit store unavailable"))) };
    const { svc, target, fence, runs } = setup({ audit });
    await expect(svc.start({ actor: ACTOR, reason: "rebuild" })).rejects.toThrow("audit store unavailable");

    const [run] = await runs.list(1);
    expect(run).toMatchObject({ status: "failed", errorCode: "AUDIT_FAILED" });
    expect(target.resets).toBe(0);
    expect(fence.holder).toBeNull();
  });
});

// ─── Retry path ───────────────────────────────────────────────────────────────

describe("projection rebuild — retry path (#989)", () => {
  it("resumes a failed run from its cursor without resetting again", async () => {
    const { svc, target, auditStore, runs } = setup();
    target.failOnBatch = 2;
    const failed = await (await svc.start({ actor: ACTOR, reason: "rebuild" })).done;

    target.failOnBatch = null;
    const resumed = await svc.resume(failed.id, ACTOR);
    expect(resumed.run).toMatchObject({ status: "running", attempts: 2, errorCode: null, lastError: null });
    const finished = await resumed.done;

    expect(finished).toMatchObject({ status: "completed", cursor: "e5", eventsReplayed: 5, attempts: 2 });
    expect(target.resets).toBe(1);
    expect(target.checkpoint).toEqual({ cursor: "e5", version: V1 });
    expect(await isIndexerFenced(runs)).toBe(false);
    const actions = (await auditStore.query({ category: "recovery", limit: 10 })).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["projection.rebuild.start", "projection.rebuild.resume"]));
  });

  it("resumes past a quarantined event once it is resolved", async () => {
    const { svc, target } = setup();
    target.quarantine.add("e4");
    const failed = await (await svc.start({ actor: ACTOR, reason: "rebuild" })).done;

    target.quarantine.delete("e4"); // fixed decoder or operator resolution
    const finished = await (await svc.resume(failed.id, ACTOR)).done;
    expect(finished.status).toBe("completed");
    expect([...target.applied]).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("resumes a run orphaned in `running` by a crash once its lease has lapsed", async () => {
    const { svc, runs, target } = setup();
    const orphan = await runs.create({ projectionVersion: V1, requestedBy: "GADMIN", reason: "crashed", toEventId: "e5", heartbeatAt: null });
    await runs.update(orphan.id, { cursor: "e2", eventsReplayed: 2 });

    const finished = await (await svc.resume(orphan.id, ACTOR)).done;
    expect(finished).toMatchObject({ status: "completed", cursor: "e5", attempts: 2 });
    expect(target.resets).toBe(0); // the cursor proves the reset already happened
  });

  it("reports a retryable conflict while another worker still holds the lease", async () => {
    const { svc, target, fence } = setup();
    target.failOnBatch = 1;
    const failed = await (await svc.start({ actor: ACTOR, reason: "rebuild" })).done;
    await fence.acquire();
    await expectAppError(svc.resume(failed.id, ACTOR), "PROJECTION_REBUILD_BUSY", 409);
  });

  it("refuses to resume a run built by another projection version", async () => {
    const v1 = setup({ version: V1 });
    v1.target.failOnBatch = 1;
    const failed = await (await v1.svc.start({ actor: ACTOR, reason: "rebuild" })).done;

    const v2 = new ProjectionRebuildService({ runs: v1.runs, target: v1.target, fence: v1.fence, projectionVersion: V2 });
    await expectAppError(v2.resume(failed.id, ACTOR), "ILLEGAL_TRANSITION", 409);
  });

  it("refuses to resume completed or unknown runs", async () => {
    const { svc } = setup();
    const done = await (await svc.start({ actor: ACTOR, reason: "rebuild" })).done;
    await expectAppError(svc.resume(done.id, ACTOR), "ILLEGAL_TRANSITION", 409);
    await expectAppError(svc.resume("00000000-0000-4000-8000-999999999999", ACTOR), "NOT_FOUND", 404);
  });

  it("supersedes an incomplete run when a fresh rebuild is started", async () => {
    const { svc, target, runs } = setup();
    target.failOnBatch = 2;
    const failed = await (await svc.start({ actor: ACTOR, reason: "first" })).done;

    target.failOnBatch = null;
    const fresh = await (await svc.start({ actor: ACTOR, reason: "second" })).done;
    expect(fresh.status).toBe("completed");
    expect((await runs.get(failed.id))!.status).toBe("superseded");
    expect(target.resets).toBe(2);
  });

  it("requires an explicit downgrade to roll projections back to an older version", async () => {
    const newer = setup({ version: V2 });
    await (await newer.svc.start({ actor: ACTOR, reason: "v2 rebuild" })).done;

    const older = new ProjectionRebuildService({ runs: newer.runs, target: newer.target, fence: newer.fence, projectionVersion: V1 });
    expect((await older.plan()).isDowngrade).toBe(true);
    await expectAppError(older.start({ actor: ACTOR, reason: "rollback" }), "ILLEGAL_TRANSITION", 409);

    const rolledBack = await (await older.start({ actor: ACTOR, reason: "rollback", allowDowngrade: true })).done;
    expect(rolledBack).toMatchObject({ status: "completed", projectionVersion: V1 });
    expect(newer.target.checkpoint).toEqual({ cursor: "e5", version: V1 });
  });
});

// ─── Authorization path ───────────────────────────────────────────────────────

describe("projection rebuild routes — authorization (#989)", () => {
  const sessions: Record<string, { walletAddress: string }> = {
    "admin-token": { walletAddress: "GADMIN" },
    "user-token": { walletAddress: "GUSER" }
  };
  const principal = walletSessionResolver({ validateSession: async (t: string) => sessions[t] ?? null }, ["GADMIN"]);

  function buildApp(svc: ProjectionRebuildService): FastifyInstance {
    const app = Fastify();
    app.setErrorHandler(errorHandler as any);
    app.register(
      projectionRebuildRoutes(svc, {
        read: requirePermission("admin.recovery.read", [principal]),
        write: requirePermission("admin.recovery.write", [principal])
      })
    );
    return app;
  }

  const start = (app: FastifyInstance, token?: string, payload: unknown = { reason: "decoder fix" }) =>
    app.inject({
      method: "POST",
      url: "/admin/projections/rebuilds",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: payload as object
    });

  it("rejects anonymous callers with 401 and wallet users with 403, before any work", async () => {
    const { svc, runs, fence } = setup();
    const app = buildApp(svc);

    expect((await start(app)).statusCode).toBe(401);
    expect((await start(app, "forged")).statusCode).toBe(401);
    expect((await start(app, "user-token")).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/projections/plan", headers: { authorization: "Bearer user-token" } })).statusCode).toBe(403);
    expect(runs.rows.size).toBe(0);
    expect(fence.holder).toBeNull();
  });

  it("lets a maintainer plan, start (202), poll and see a busy conflict", async () => {
    const { svc, fence } = setup();
    const app = buildApp(svc);
    const auth = { authorization: "Bearer admin-token" };

    const plan = await app.inject({ method: "GET", url: "/admin/projections/plan", headers: auth });
    expect(plan.statusCode).toBe(200);
    expect(plan.json().data).toMatchObject({ projection_version: V1, events_to_replay: 5, rebuild_recommended: true });

    const started = await start(app, "admin-token");
    expect(started.statusCode).toBe(202);
    const id = started.json().data.id as string;
    expect(started.json().data).toMatchObject({ status: "running", requested_by: "GADMIN", projection_version: V1 });

    await vi.waitFor(async () => {
      const polled = await app.inject({ method: "GET", url: `/admin/projections/rebuilds/${id}`, headers: auth });
      expect(polled.json().data.status).toBe("completed");
    });

    await fence.acquire();
    const busy = await start(app, "admin-token");
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe("PROJECTION_REBUILD_BUSY");
  });

  it("validates input: a reason is required and ids must be uuids", async () => {
    const { svc } = setup();
    const app = buildApp(svc);
    expect((await start(app, "admin-token", {})).statusCode).toBe(400);
    const badId = await app.inject({
      method: "POST",
      url: "/admin/projections/rebuilds/not-a-uuid/resume",
      headers: { authorization: "Bearer admin-token" }
    });
    expect(badId.statusCode).toBe(400);
  });
});
