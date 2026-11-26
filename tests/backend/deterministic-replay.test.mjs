// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  DeterministicReplayEngine,
  ReplayDivergenceError,
  AuthorizationError,
} from "../../src/lib/deterministic-replay.mjs";

test("deterministic replay tests for multi-actor mutations (#1097)", async (t) => {
  await t.test("normal path: multi-actor mutation recording, replay verification, and checkpointing", () => {
    const engine = new DeterministicReplayEngine();

    engine.recordMutation("alice", 1, "DEPOSIT", { account: "alice", amount: 100 });
    engine.recordMutation("bob", 1, "DEPOSIT", { account: "bob", amount: 50 });
    engine.recordMutation("alice", 2, "TRANSFER", { from: "alice", to: "bob", amount: 30 });

    assert.equal(engine.state.balances.alice, 70);
    assert.equal(engine.state.balances.bob, 80);

    const replayed = engine.replayHistory(null, "auditor");
    assert.deepEqual(replayed, engine.state);
  });

  await t.test("failure path: detects nonce sequence gaps and insufficient funds divergence", () => {
    const engine = new DeterministicReplayEngine();
    engine.recordMutation("alice", 1, "DEPOSIT", { account: "alice", amount: 10 });

    assert.throws(
      () => engine.recordMutation("alice", 3, "DEPOSIT", { account: "alice", amount: 10 }),
      (err) => err instanceof ReplayDivergenceError && err.message.includes("Invalid nonce")
    );

    assert.throws(
      () => engine.recordMutation("alice", 2, "TRANSFER", { from: "alice", to: "bob", amount: 500 }),
      (err) => err instanceof ReplayDivergenceError && err.message.includes("Insufficient balance")
    );
  });

  await t.test("retry and rollback path: rolls back state accurately to verified checkpoint", () => {
    const engine = new DeterministicReplayEngine();
    engine.recordMutation("alice", 1, "DEPOSIT", { account: "alice", amount: 100 });
    const cp = engine.createCheckpoint("cp-1", "admin");

    engine.recordMutation("alice", 2, "DEPOSIT", { account: "alice", amount: 200 });
    assert.equal(engine.state.balances.alice, 300);

    engine.rollbackToCheckpoint("cp-1", "admin");
    assert.equal(engine.state.balances.alice, 100);
    assert.equal(engine.state.nonces.alice, 1);
  });

  await t.test("authorization path: restricts checkpoint and replay operations to authorized roles", () => {
    const engine = new DeterministicReplayEngine();
    engine.recordMutation("alice", 1, "DEPOSIT", { account: "alice", amount: 50 });

    assert.throws(
      () => engine.createCheckpoint("cp-x", "guest"),
      (err) => err instanceof AuthorizationError
    );

    assert.throws(
      () => engine.replayHistory(null, "unprivileged"),
      (err) => err instanceof AuthorizationError
    );
  });
});
