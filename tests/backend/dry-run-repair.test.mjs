import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryCheckpointStore,
  RepairAuthorizationError,
  RepairExecutionError,
  authorizeRepairActor,
  resumeRepairJob,
  runRepairJob,
} from "../../src/lib/dry-run-repair.mjs";

function createFakeDataSource({
  actions = [],
  events = [],
  settlements = [],
  failRepairForId = null,
  transientFailuresBeforeSuccess = 0,
} = {}) {
  let mutationCalls = 0;
  let transientCount = 0;

  return {
    getMutationCalls: () => mutationCalls,
    async fetchStaleActions(cursor, limit) {
      const start = cursor ? actions.findIndex((a) => a.id === cursor) + 1 : 0;
      return actions.slice(start, start + limit);
    },
    async repairAction(id) {
      if (id === failRepairForId && transientCount < transientFailuresBeforeSuccess) {
        transientCount += 1;
        const err = new Error("transient db timeout");
        err.retryable = true;
        throw err;
      }
      if (id === failRepairForId && transientFailuresBeforeSuccess === 0) {
        const err = new Error("permanent constraint error");
        err.retryable = false;
        throw err;
      }
      mutationCalls += 1;
      return true;
    },
    async fetchStalePendingEvents(cursor, limit) {
      const start = cursor ? events.findIndex((e) => e.txHash === cursor) + 1 : 0;
      return events.slice(start, start + limit);
    },
    async prunePendingEvent() {
      mutationCalls += 1;
      return true;
    },
    async fetchUnresolvedSettlements(cursor, limit) {
      const start = cursor ? settlements.findIndex((s) => s.id === cursor) + 1 : 0;
      return settlements.slice(start, start + limit);
    },
    async repairSettlement() {
      mutationCalls += 1;
      return true;
    },
  };
}

describe("dry-run repair tooling with checkpoints (#1067)", () => {
  const admin = { id: "admin-1", role: "admin" };
  const operator = { id: "op-1", role: "operator" };
  const viewer = { id: "viewer-1", role: "viewer" };

  it("normal path: dry-run plans all phases and saves checkpoints without mutating dataSource", async () => {
    const store = new InMemoryCheckpointStore();
    const dataSource = createFakeDataSource({
      actions: [{ id: "act-1", status: "submitted" }, { id: "act-2", status: "pending" }],
      events: [{ txHash: "0xabc", statusHint: "pending" }],
      settlements: [{ id: "set-1", state: "processing" }],
    });

    const result = await runRepairJob({
      actor: operator,
      dataSource,
      checkpointStore: store,
      dryRun: true,
      batchSize: 2,
      jobId: "job-dry-1",
    });

    assert.equal(result.checkpoint.status, "completed");
    assert.equal(result.checkpoint.dryRun, true);
    assert.equal(result.checkpoint.stats.scannedCount, 4);
    assert.equal(result.checkpoint.stats.repairedCount, 4);
    assert.equal(result.checkpoint.stats.failedCount, 0);
    assert.equal(dataSource.getMutationCalls(), 0);
    assert.ok(result.planDigest);

    const saved = await store.load("job-dry-1");
    assert.equal(saved.status, "completed");
    assert.equal(saved.plannedActions.length, 4);
  });

  it("normal + checkpoint resume: pauses after maxBatches and resumes idempotently", async () => {
    const store = new InMemoryCheckpointStore();
    const dataSource = createFakeDataSource({
      actions: [
        { id: "act-1", status: "submitted" },
        { id: "act-2", status: "submitted" },
        { id: "act-3", status: "submitted" },
      ],
    });

    const first = await runRepairJob({
      actor: admin,
      dataSource,
      checkpointStore: store,
      dryRun: false,
      batchSize: 2,
      phases: ["orphaned_actions"],
      maxBatches: 1,
      jobId: "job-resume-1",
    });

    assert.equal(first.checkpoint.status, "paused");
    assert.equal(first.checkpoint.cursor, "act-2");
    assert.equal(first.checkpoint.stats.repairedCount, 2);
    assert.equal(dataSource.getMutationCalls(), 2);

    const resumed = await resumeRepairJob({
      jobId: "job-resume-1",
      actor: admin,
      dataSource,
      checkpointStore: store,
    });

    assert.equal(resumed.checkpoint.status, "completed");
    assert.equal(resumed.checkpoint.stats.repairedCount, 3);
    assert.equal(dataSource.getMutationCalls(), 3);
  });

  it("retry path: retries transient mutation failures and pauses on exhausted retries for resume", async () => {
    const store = new InMemoryCheckpointStore();
    const dataSource = createFakeDataSource({
      actions: [{ id: "act-1", status: "submitted" }, { id: "act-2", status: "submitted" }],
      failRepairForId: "act-2",
      transientFailuresBeforeSuccess: 2,
    });

    const result = await runRepairJob({
      actor: admin,
      dataSource,
      checkpointStore: store,
      dryRun: false,
      phases: ["orphaned_actions"],
      maxRetries: 2,
      jobId: "job-retry-ok",
    });

    assert.equal(result.checkpoint.status, "completed");
    assert.equal(result.checkpoint.stats.repairedCount, 2);
    assert.equal(dataSource.getMutationCalls(), 2);

    // Now test exhausted retries -> pauses at checkpoint so operator can resume later
    const store2 = new InMemoryCheckpointStore();
    const failingSource = createFakeDataSource({
      actions: [{ id: "act-1", status: "submitted" }, { id: "act-2", status: "submitted" }],
      failRepairForId: "act-2",
      transientFailuresBeforeSuccess: 5,
    });

    const paused = await runRepairJob({
      actor: admin,
      dataSource: failingSource,
      checkpointStore: store2,
      dryRun: false,
      phases: ["orphaned_actions"],
      maxRetries: 1,
      jobId: "job-retry-pause",
    });

    assert.equal(paused.checkpoint.status, "paused");
    assert.equal(paused.halted, true);
    assert.equal(paused.checkpoint.errors.length, 1);
  });

  it("failure path: records non-retryable record errors and rejects invalid batchSize or missing checkpoint", async () => {
    const store = new InMemoryCheckpointStore();
    const dataSource = createFakeDataSource({
      actions: [{ id: "act-bad", status: "submitted" }],
      failRepairForId: "act-bad",
      transientFailuresBeforeSuccess: 0,
    });

    const res = await runRepairJob({
      actor: admin,
      dataSource,
      checkpointStore: store,
      dryRun: false,
      phases: ["orphaned_actions"],
      jobId: "job-perm-fail",
    });

    assert.equal(res.checkpoint.status, "completed");
    assert.equal(res.checkpoint.stats.failedCount, 1);
    assert.equal(res.checkpoint.errors[0].recordId, "act-bad");

    await assert.rejects(
      () =>
        runRepairJob({
          actor: admin,
          dataSource,
          batchSize: 0,
        }),
      (err) => err instanceof RepairExecutionError && err.code === "INVALID_BATCH_SIZE",
    );

    await assert.rejects(
      () =>
        resumeRepairJob({
          jobId: "missing-job",
          actor: admin,
          dataSource,
          checkpointStore: store,
        }),
      (err) => err instanceof RepairExecutionError && err.code === "CHECKPOINT_NOT_FOUND",
    );
  });

  it("authorization path: blocks unprivileged viewers and blocks operators from live mutations", async () => {
    const dataSource = createFakeDataSource();

    assert.throws(
      () => authorizeRepairActor(viewer, { dryRun: true }),
      (err) => err instanceof RepairAuthorizationError && err.statusCode === 403,
    );

    assert.throws(
      () => authorizeRepairActor(operator, { dryRun: false }),
      (err) => err instanceof RepairAuthorizationError && err.code === "REPAIR_UNAUTHORIZED",
    );

    await assert.rejects(
      () =>
        runRepairJob({
          actor: operator,
          dataSource,
          dryRun: false,
        }),
      RepairAuthorizationError,
    );
  });
});
