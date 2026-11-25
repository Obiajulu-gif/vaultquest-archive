import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeadLetterAuthorizationError,
  DeadLetterOperationError,
  DeadLetterQueueManager,
} from "../../src/lib/dead-letter-tooling.mjs";
import {
  runDeadLetterToolingCommand,
  saveState,
} from "../../scripts/dead-letter-tooling.mjs";

describe("dead-letter inspection and safe retry tooling (#1152)", () => {
  const admin = { id: "admin-1", role: "admin" };
  const operatorWithScope = { id: "op-1", role: "operator", scopes: ["retry:dlq"] };
  const auditor = { id: "audit-1", role: "auditor" };

  let directory;
  let statePath;
  let outboxPath;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dlq-"));
    statePath = join(directory, "state.json");
    outboxPath = join(directory, "outbox.ndjson");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function seed() {
    const manager = new DeadLetterQueueManager();
    manager.enqueueDeadLetter({
      id: "dlq-1",
      queueName: "payouts",
      jobName: "settle-round",
      payload: { roundId: "r-1", apiToken: "secret-token" },
      errorReason: "RPC timeout",
      errorCode: "RPC_TIMEOUT",
      correlationId: "corr-1",
    });
    manager.enqueueDeadLetter({
      id: "dlq-2",
      queueName: "webhooks",
      jobName: "deliver",
      payload: { eventId: "e-1" },
      errorReason: "poison payload",
      errorCode: "POISON",
      poisonPill: true,
    });
    saveState(manager, statePath);
    return manager;
  }

  it("summarizes queues and redacts sensitive payload fields in inspection reports", () => {
    const manager = seed();

    const summary = manager.getQueueSummary(auditor);
    assert.equal(summary.total, 2);
    assert.equal(summary.quarantined, 1);
    assert.equal(summary.retryable, 1);
    assert.deepEqual(summary.byQueue, { payouts: 1, webhooks: 1 });

    const report = manager.exportInspectionReport(auditor, { queueName: "payouts" });
    assert.equal(report.summary.total, 2);
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].payload.apiToken, "[REDACTED]");
    assert.equal(report.entries[0].payload.roundId, "r-1");
  });

  it("round-trips queue state without losing retry counts or quarantine status", () => {
    const manager = seed();
    const exported = manager.exportState();

    const restored = new DeadLetterQueueManager();
    assert.equal(restored.importState(exported), 2);
    assert.equal(restored.getEntryDetail(auditor, "dlq-2").status, "quarantined");
    assert.equal(restored.getEntryDetail(auditor, "dlq-1").retryCount, 0);

    assert.throws(
      () => restored.importState([{ jobName: "missing-id" }]),
      (err) => err instanceof DeadLetterOperationError
    );
  });

  it("purges entries only for admins and records the mutation", () => {
    const manager = seed();

    assert.throws(
      () => manager.purgeEntry(operatorWithScope, "dlq-1"),
      (err) => err instanceof DeadLetterAuthorizationError
    );
    assert.equal(manager.getQueueSummary(admin).total, 2);

    const result = manager.purgeEntry(admin, "dlq-1");
    assert.deepEqual(result, { id: "dlq-1", purged: true });
    assert.equal(manager.getQueueSummary(admin).total, 1);
    assert.equal(manager.getAuditTrail().at(-1).action, "dlq_purge");
  });

  it("previews without mutating state and retries through the outbox", async () => {
    seed();

    const preview = await runDeadLetterToolingCommand({
      command: "preview",
      state: statePath,
      id: "dlq-1",
      actorId: "op-1",
      actorRole: "operator",
    });
    assert.equal(preview.wouldReplay, true);
    assert.equal(preview.redactedPayload.apiToken, "[REDACTED]");

    const beforeRetry = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(beforeRetry.entries.find((entry) => entry.id === "dlq-1").status, "dead_lettered");

    const retried = await runDeadLetterToolingCommand({
      command: "retry",
      state: statePath,
      outbox: outboxPath,
      id: "dlq-1",
      actorId: "admin-1",
      actorRole: "admin",
      idempotencyKey: "retry-dlq-1",
    });
    assert.equal(retried.replayed, true);
    assert.equal(retried.retryCount, 1);

    const outbox = (await readFile(outboxPath, "utf8")).trim().split("\n");
    assert.equal(outbox.length, 1);
    assert.deepEqual(JSON.parse(outbox[0]), {
      queueName: "payouts",
      jobName: "settle-round",
      payload: { roundId: "r-1", apiToken: "secret-token" },
      correlationId: "corr-1",
      replayedFrom: "dlq-1",
    });

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.entries.find((entry) => entry.id === "dlq-1").status, "replayed");
  });

  it("rejects viewers before any retry, quarantine, or purge mutation", async () => {
    seed();

    for (const command of ["retry", "quarantine", "purge"]) {
      await assert.rejects(
        () =>
          runDeadLetterToolingCommand({
            command,
            state: statePath,
            outbox: outboxPath,
            id: "dlq-1",
            actorId: "viewer-1",
            actorRole: "viewer",
          }),
        (err) => err instanceof DeadLetterAuthorizationError
      );
    }

    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.entries.length, 2);
    assert.equal(state.entries.find((entry) => entry.id === "dlq-1").status, "dead_lettered");
  });
});
