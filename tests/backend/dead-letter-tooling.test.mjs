import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DeadLetterAuthorizationError,
  DeadLetterOperationError,
  DeadLetterQueueManager,
} from "../../src/lib/dead-letter-tooling.mjs";

describe("dead-letter inspection and safe retry tooling (#1104)", () => {
  const admin = { id: "admin-1", role: "admin" };
  const operatorWithScope = { id: "op-1", role: "operator", scopes: ["retry:dlq"] };
  const operatorReadOnly = { id: "op-2", role: "operator", scopes: [] };
  const viewer = { id: "user-1", role: "viewer" };

  it("normal path: enqueues, inspects with payload redaction, dry-runs, and replays dead-letter jobs idempotently", async () => {
    const manager = new DeadLetterQueueManager({ maxRetryCycles: 3 });

    manager.enqueueDeadLetter({
      id: "dlq-1",
      queueName: "payout-settlement",
      jobName: "settle-round",
      payload: { roundId: "r-10", signerSecret: "S_PRIVATE_SEED_123" },
      errorReason: "RPC timeout",
      errorCode: "RPC_TIMEOUT",
      correlationId: "corr-101",
    });

    const inspection = manager.inspectEntries(operatorReadOnly, {
      queueName: "payout-settlement",
    });
    assert.equal(inspection.totalMatched, 1);
    assert.equal(inspection.entries[0].payload.roundId, "r-10");
    assert.equal(inspection.entries[0].payload.signerSecret, "[REDACTED]");

    // Dry-run does not mutate state
    const preview = await manager.retryEntry({
      actor: operatorReadOnly,
      id: "dlq-1",
      dryRun: true,
    });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.wouldReplay, true);
    assert.equal(manager.getEntryDetail(admin, "dlq-1").status, "dead_lettered");

    // Live retry with idempotency key
    const dispatched = [];
    const liveResult = await manager.retryEntry({
      actor: operatorWithScope,
      id: "dlq-1",
      idempotencyKey: "idem-dlq-1",
      dispatcher: async (job) => {
        dispatched.push(job);
      },
    });

    assert.equal(liveResult.replayed, true);
    assert.equal(liveResult.status, "replayed");
    assert.equal(dispatched.length, 1);

    // Duplicate retry with same idempotencyKey returns deduplicated result without re-dispatching
    const dupResult = await manager.retryEntry({
      actor: operatorWithScope,
      id: "dlq-1",
      idempotencyKey: "idem-dlq-1",
      dispatcher: async () => {
        dispatched.push("should-not-run");
      },
    });
    assert.equal(dupResult.deduplicated, true);
    assert.equal(dispatched.length, 1);
  });

  it("retry & rollback path: retries transient dispatch failures and rolls back state when permanent failure occurs", async () => {
    const manager = new DeadLetterQueueManager({ maxRetryCycles: 2 });

    manager.enqueueDeadLetter({
      id: "dlq-transient",
      queueName: "vault-rebalance",
      jobName: "rebalance",
      payload: { vaultId: "v-1" },
      errorReason: "Temporary lock",
    });

    let calls = 0;
    const recovered = await manager.retryEntry({
      actor: admin,
      id: "dlq-transient",
      maxTransientAttempts: 2,
      dispatcher: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("transient network glitch");
          err.retryable = true;
          throw err;
        }
      },
    });

    assert.equal(recovered.replayed, true);
    assert.equal(recovered.attemptsUsed, 2);

    // Permanent failure rolls back to dead_lettered and quarantines on reaching maxRetryCycles
    manager.enqueueDeadLetter({
      id: "dlq-perm",
      queueName: "vault-rebalance",
      jobName: "rebalance",
      payload: { vaultId: "v-2" },
      errorReason: "Bad state",
    });

    await assert.rejects(
      () =>
        manager.retryEntry({
          actor: admin,
          id: "dlq-perm",
          dispatcher: async () => {
            throw new Error("downstream unavailable");
          },
        }),
      (err) => err instanceof DeadLetterOperationError && err.code === "DLQ_DISPATCH_FAILED",
    );

    const afterFirstFail = manager.getEntryDetail(admin, "dlq-perm");
    assert.equal(afterFirstFail.status, "dead_lettered");
    assert.equal(afterFirstFail.retryCount, 1);

    await assert.rejects(
      () =>
        manager.retryEntry({
          actor: admin,
          id: "dlq-perm",
          dispatcher: async () => {
            throw new Error("downstream still unavailable");
          },
        }),
      DeadLetterOperationError,
    );

    const afterSecondFail = manager.getEntryDetail(admin, "dlq-perm");
    assert.equal(afterSecondFail.status, "quarantined");
    assert.equal(afterSecondFail.retryCount, 2);
  });

  it("failure & quarantine path: blocks replay of quarantined poison-pill jobs without admin forceOverrideReason", async () => {
    const manager = new DeadLetterQueueManager();
    manager.enqueueDeadLetter({
      id: "dlq-poison",
      queueName: "prize-draw",
      jobName: "finalize-draw",
      payload: { drawId: 99 },
      errorReason: "Schema mismatch",
      poisonPill: true,
    });

    await assert.rejects(
      () =>
        manager.retryEntry({
          actor: admin,
          id: "dlq-poison",
          dispatcher: async () => {},
        }),
      (err) => err instanceof DeadLetterOperationError && err.code === "DLQ_QUARANTINED",
    );

    // Operator cannot force-override quarantine even with reason
    await assert.rejects(
      () =>
        manager.retryEntry({
          actor: operatorWithScope,
          id: "dlq-poison",
          forceOverrideReason: "hotfix deployed",
          dispatcher: async () => {},
        }),
      (err) =>
        err instanceof DeadLetterAuthorizationError &&
        err.code === "DLQ_QUARANTINE_OVERRIDE_FORBIDDEN",
    );

    // Admin with forceOverrideReason succeeds
    const forced = await manager.retryEntry({
      actor: admin,
      id: "dlq-poison",
      forceOverrideReason: "schema hotfix deployed",
      dispatcher: async () => {},
    });
    assert.equal(forced.replayed, true);
  });

  it("authorization path: blocks unprivileged viewers from inspection and read-only operators from live retry", async () => {
    const manager = new DeadLetterQueueManager();
    manager.enqueueDeadLetter({
      id: "dlq-auth",
      queueName: "notifications",
      jobName: "send-digest",
      payload: {},
      errorReason: "SMTP error",
    });

    assert.throws(
      () => manager.inspectEntries(viewer),
      (err) => err instanceof DeadLetterAuthorizationError && err.statusCode === 403,
    );

    await assert.rejects(
      () =>
        manager.retryEntry({
          actor: operatorReadOnly,
          id: "dlq-auth",
          dryRun: false,
          dispatcher: async () => {},
        }),
      DeadLetterAuthorizationError,
    );
  });
});
