// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  InvariantMonitor,
  InvariantViolationError,
  InvariantAuthError,
} from "../../src/lib/invariant-monitor.mjs";

test("invariant monitoring for balances and ownership (#1103)", async (t) => {
  await t.test("normal path: verifies balance conservation, non-negative bounds, and single ownership", () => {
    const monitor = new InvariantMonitor();

    const vaults = { vaultA: 400, vaultB: 600 };
    assert.equal(monitor.checkConservation(vaults, 1000), true);

    const accounts = { alice: 100, bob: 0, charlie: 50 };
    assert.equal(monitor.checkNonNegativeBalances(accounts), true);

    const ownership = { "vault-1": "alice", "vault-2": "bob" };
    assert.equal(monitor.checkSingleOwnership(ownership), true);
    assert.equal(monitor.isPaused, false);
  });

  await t.test("failure path: detects conservation breach, negative balances, and orphaned resources", () => {
    const monitor = new InvariantMonitor();

    // Conservation breach
    assert.throws(
      () => monitor.checkConservation({ vaultA: 300, vaultB: 500 }, 1000),
      (err) => err instanceof InvariantViolationError && err.message.includes("conservation violated")
    );
    assert.equal(monitor.isPaused, true);

    // Negative balance
    assert.throws(
      () => monitor.checkNonNegativeBalances({ alice: 50, bob: -10 }),
      (err) => err instanceof InvariantViolationError && err.message.includes("Negative balance")
    );

    // Orphaned resource
    assert.throws(
      () => monitor.checkSingleOwnership({ "vault-1": "" }),
      (err) => err instanceof InvariantViolationError && err.message.includes("no valid owner")
    );
  });

  await t.test("retry & rollback path: auto-trips emergency pause and resumes upon operator acknowledgement", () => {
    const monitor = new InvariantMonitor();

    try {
      monitor.checkConservation({ vaultA: 10 }, 50);
    } catch {
      // expected
    }

    assert.equal(monitor.isPaused, true);
    assert.equal(monitor.getAlerts().length, 1);

    const result = monitor.acknowledgeAlerts("security");
    assert.equal(result.acknowledgedCount, 1);
    assert.equal(monitor.isPaused, false);
    assert.equal(monitor.getAlerts().length, 0);
  });

  await t.test("authorization path: only authorized security/admin roles can acknowledge and unpause", () => {
    const monitor = new InvariantMonitor();

    try {
      monitor.checkConservation({ vaultA: 10 }, 50);
    } catch {
      // expected
    }

    assert.throws(
      () => monitor.acknowledgeAlerts("guest"),
      (err) => err instanceof InvariantAuthError
    );

    assert.equal(monitor.isPaused, true);
    monitor.acknowledgeAlerts("admin");
    assert.equal(monitor.isPaused, false);
  });
});
