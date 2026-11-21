// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  DependencyFallbackManager,
  DependencyOutageError,
  DependencyAuthError,
} from "../../src/lib/dependency-fallback.mjs";

test("dependency outage fallback and recovery UX (#1102)", async (t) => {
  await t.test("normal path: executes primary dependency call and refreshes cache", async () => {
    const manager = new DependencyFallbackManager();
    manager.registerDependency("horizon-rpc");

    const res = await manager.executeWithFallback(
      "horizon-rpc",
      async () => ({ latestLedger: 12345 }),
      "ledger-info"
    );

    assert.equal(res.source, "PRIMARY");
    assert.equal(res.degraded, false);
    assert.deepEqual(res.data, { latestLedger: 12345 });
    assert.equal(manager.getStatus("horizon-rpc").status, "HEALTHY");
  });

  await t.test("failure path: trips circuit and renders cached UX fallback when dependency fails", async () => {
    const manager = new DependencyFallbackManager({ failureThreshold: 2 });
    manager.registerDependency("horizon-rpc");
    manager.setCachedData("ledger-info", { latestLedger: 12340 });

    const failingFn = async () => {
      throw new Error("HTTP 503 Service Unavailable");
    };

    const res1 = await manager.executeWithFallback("horizon-rpc", failingFn, "ledger-info");
    assert.equal(res1.source, "CACHE_FALLBACK");
    assert.equal(res1.degraded, true);
    assert.deepEqual(res1.data, { latestLedger: 12340 });
    assert.equal(res1.uxState.canWrite, false);
    assert.match(res1.uxState.banner, /cached data/i);
  });

  await t.test("retry & recovery path: probes recover circuit after timeout and restore healthy status", async () => {
    const manager = new DependencyFallbackManager({ failureThreshold: 1, recoveryTimeoutMs: 30 });
    manager.registerDependency("ipfs-gateway");

    // Force failure
    await assert.rejects(
      async () => manager.executeWithFallback("ipfs-gateway", async () => {
        throw new Error("Timeout");
      }),
      (err) => err instanceof DependencyOutageError
    );

    assert.equal(manager.getStatus("ipfs-gateway").status, "DOWN");

    // Wait for recovery timeout
    await new Promise((r) => setTimeout(r, 40));

    // Recovery probe succeeds
    const recovered = await manager.executeWithFallback("ipfs-gateway", async () => ({ cid: "Qm123" }));
    assert.equal(recovered.source, "PRIMARY");
    assert.equal(recovered.degraded, false);
    assert.equal(manager.getStatus("ipfs-gateway").status, "HEALTHY");
  });

  await t.test("authorization path: only authorized operators can override dependency status", () => {
    const manager = new DependencyFallbackManager();
    manager.registerDependency("oracle");

    assert.throws(
      () => manager.overrideStatus("oracle", "DOWN", "unauthorized-viewer"),
      (err) => err instanceof DependencyAuthError
    );

    manager.overrideStatus("oracle", "DOWN", "admin");
    assert.equal(manager.getStatus("oracle").status, "DOWN");

    manager.overrideStatus("oracle", "HEALTHY", "operator");
    assert.equal(manager.getStatus("oracle").status, "HEALTHY");
  });
});
