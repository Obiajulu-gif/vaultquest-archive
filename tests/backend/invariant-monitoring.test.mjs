// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  InvariantAuthError,
  InvariantMonitor,
  InvariantViolationError,
} from "../../src/lib/invariant-monitor.mjs";

test("invariant monitoring for balances and ownership (#1151)", async (t) => {
  await t.test("normal path: object, Map, and array ownership inputs all validate", () => {
    const monitor = new InvariantMonitor();

    assert.equal(monitor.checkSingleOwnership({ "vault-1": "alice", "vault-2": "bob" }), true);
    assert.equal(
      monitor.checkSingleOwnership(
        new Map([
          ["vault-1", "alice"],
          ["vault-2", "bob"],
        ])
      ),
      true
    );
    assert.equal(
      monitor.checkSingleOwnership([
        { resourceId: "vault-1", owner: "alice" },
        { resourceId: "vault-2", owner: "bob" },
      ]),
      true
    );
    assert.equal(monitor.isPaused, false);
  });

  await t.test("failure path: duplicate owners are detected in array form", () => {
    const monitor = new InvariantMonitor();

    assert.throws(
      () =>
        monitor.checkSingleOwnership([
          { resourceId: "vault-1", owner: "alice" },
          { resourceId: "vault-1", owner: "bob" },
        ]),
      (err) => {
        assert.ok(err instanceof InvariantViolationError);
        assert.equal(err.details.type, "DUAL_OWNERSHIP_DETECTED");
        assert.deepEqual(err.details.owners, ["alice", "bob"]);
        return true;
      }
    );
    assert.equal(monitor.isPaused, true);
  });

  await t.test("failure path: orphaned resources and invalid ids fail closed", () => {
    const monitor = new InvariantMonitor();

    assert.throws(
      () => monitor.checkSingleOwnership([{ resourceId: "vault-1", owner: "" }]),
      (err) =>
        err instanceof InvariantViolationError &&
        err.details.type === "ORPHANED_RESOURCE_DETECTED"
    );

    assert.throws(
      () => monitor.checkSingleOwnership([{ owner: "alice" }]),
      (err) =>
        err instanceof InvariantViolationError && err.details.type === "INVALID_RESOURCE_ID"
    );
  });

  await t.test("monitoring path: evaluateAll collects every violation without throwing", () => {
    const monitor = new InvariantMonitor();

    const report = monitor.evaluateAll({
      vaults: { vaultA: 10, vaultB: 20 },
      totalSupply: 100,
      accounts: { alice: 5, bob: -1 },
      ownership: [
        { resourceId: "vault-1", owner: "alice" },
        { resourceId: "vault-1", owner: "bob" },
      ],
    });

    assert.equal(report.ok, false);
    assert.equal(report.paused, true);
    assert.equal(report.violations.length, 3);
    assert.deepEqual(
      report.violations.map((violation) => violation.type),
      ["BALANCE_CONSERVATION_BREACH", "NEGATIVE_BALANCE_DETECTED", "DUAL_OWNERSHIP_DETECTED"]
    );
    assert.equal(monitor.getStatus().alertCount, 3);
  });

  await t.test("authorization path: only security/admin roles acknowledge alerts", () => {
    const monitor = new InvariantMonitor();
    monitor.evaluateAll({ vaults: { vaultA: 1 }, totalSupply: 2 });

    assert.throws(
      () => monitor.acknowledgeAlerts("guest"),
      (err) => err instanceof InvariantAuthError
    );
    assert.equal(monitor.getStatus().paused, true);

    const result = monitor.acknowledgeAlerts("admin");
    assert.equal(result.acknowledgedCount, 1);
    assert.deepEqual(monitor.getStatus(), { paused: false, alertCount: 0, alerts: [] });
  });
});
