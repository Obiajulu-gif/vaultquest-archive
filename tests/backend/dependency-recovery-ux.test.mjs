// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  DependencyAuthError,
  DependencyFallbackManager,
  DependencyOutageError,
} from "../../src/lib/dependency-fallback.mjs";

test("dependency outage fallback and recovery UX (#1150)", async (t) => {
  await t.test("normal path: healthy dependencies advertise writable, non-degraded UX", async () => {
    const manager = new DependencyFallbackManager();
    manager.registerDependency("horizon-rpc");

    await manager.executeWithFallback("horizon-rpc", async () => ({ ledger: 10 }), "ledger");

    const ux = manager.getRecoveryUx("horizon-rpc");
    assert.equal(ux.status, "HEALTHY");
    assert.equal(ux.degraded, false);
    assert.equal(ux.canWrite, true);
    assert.equal(ux.canRetry, false);
    assert.equal(ux.action, null);
    assert.equal(ux.banner, null);
    assert.ok(ux.lastSuccessTime > 0);

    assert.equal(manager.listStatuses().length, 1);
  });

  await t.test("failure path: down dependencies pause writes and expose a retry window", async () => {
    const manager = new DependencyFallbackManager({ failureThreshold: 1, recoveryTimeoutMs: 60_000 });
    manager.registerDependency("ipfs-gateway");

    await assert.rejects(
      () =>
        manager.executeWithFallback("ipfs-gateway", async () => {
          throw new Error("connect ECONNREFUSED");
        }),
      (err) => err instanceof DependencyOutageError
    );

    const ux = manager.getRecoveryUx("ipfs-gateway");
    assert.equal(ux.status, "DOWN");
    assert.equal(ux.degraded, true);
    assert.equal(ux.canWrite, false);
    assert.equal(ux.canRetry, false);
    assert.equal(ux.action, "wait");
    assert.ok(ux.retryAfterMs > 0);
    assert.match(ux.banner, /unavailable/i);

    const probe = await manager.probeRecovery("ipfs-gateway", async () => ({ cid: "Qm" }));
    assert.equal(probe.probed, false);
    assert.equal(probe.recovered, false);
    assert.ok(probe.retryAfterMs > 0);
  });

  await t.test("recovery path: a successful probe resets the circuit and failed probes restart the window", async () => {
    const manager = new DependencyFallbackManager({ failureThreshold: 1, recoveryTimeoutMs: 20 });
    manager.registerDependency("oracle");

    await assert.rejects(() =>
      manager.executeWithFallback("oracle", async () => {
        throw new Error("timeout");
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 30));

    const failedProbe = await manager.probeRecovery("oracle", async () => {
      throw new Error("still down");
    });
    assert.equal(failedProbe.probed, true);
    assert.equal(failedProbe.recovered, false);
    assert.equal(failedProbe.status, "DOWN");
    assert.equal(failedProbe.error, "still down");
    assert.equal(manager.getStatus("oracle").status, "DOWN");

    await new Promise((resolve) => setTimeout(resolve, 30));

    const recoveredProbe = await manager.probeRecovery("oracle", async () => ({ price: 1 }));
    assert.equal(recoveredProbe.probed, true);
    assert.equal(recoveredProbe.recovered, true);
    assert.equal(recoveredProbe.status, "HEALTHY");
    assert.deepEqual(recoveredProbe.result, { price: 1 });
    assert.equal(manager.getRecoveryUx("oracle").canWrite, true);
  });

  await t.test("authorization path: unauthorized overrides are rejected without changing state", () => {
    const manager = new DependencyFallbackManager();
    manager.registerDependency("horizon-rpc");

    assert.throws(
      () => manager.overrideStatus("horizon-rpc", "DOWN", "viewer"),
      (err) => err instanceof DependencyAuthError
    );
    assert.equal(manager.getStatus("horizon-rpc").status, "HEALTHY");

    manager.overrideStatus("horizon-rpc", "DEGRADED", "operator");
    assert.equal(manager.getStatus("horizon-rpc").status, "DEGRADED");
    assert.equal(manager.getRecoveryUx("horizon-rpc").canWrite, false);
  });
});
