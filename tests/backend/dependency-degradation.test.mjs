import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DegradationAuthorizationError,
  DegradedModeController,
  DegradedModeError,
  VAULTQUEST_DEPENDENCY_MATRIX,
  validateDependencyMatrix,
} from "../../src/lib/dependency-degradation.mjs";

describe("dependency degradation matrix and fallback behavior (#1064)", () => {
  const admin = { id: "admin-1", role: "admin" };
  const user = { id: "user-1", role: "user" };

  it("normal path: validates dependency matrix completeness and executes healthy reads/mutations", async () => {
    const validation = validateDependencyMatrix(VAULTQUEST_DEPENDENCY_MATRIX);
    assert.equal(validation.valid, true);
    assert.deepEqual(validation.issues, []);

    const ctrl = new DegradedModeController();
    const res = await ctrl.executeWithFallback({
      dependency: "database",
      operationType: "mutation",
      primaryFn: async () => ({ deposited: true }),
    });

    assert.equal(res.degraded, false);
    assert.equal(res.stale, false);
    assert.deepEqual(res.data, { deposited: true });
  });

  it("failure & fallback path: gates mutations with 503 when critical dependency is unavailable, serves stale read cache", async () => {
    const now = new Date("2026-11-19T10:10:00.000Z");
    const ctrl = new DegradedModeController({ failureThreshold: 2 }, () => now);

    ctrl.recordFailure("soroban_rpc", "timeout");
    assert.equal(ctrl.getState("soroban_rpc").status, "degraded");
    ctrl.recordFailure("soroban_rpc", "timeout");
    assert.equal(ctrl.getState("soroban_rpc").status, "unavailable");

    await assert.rejects(
      () =>
        ctrl.executeWithFallback({
          dependency: "soroban_rpc",
          operationType: "mutation",
          primaryFn: async () => ({ txHash: "0x1" }),
        }),
      (err) =>
        err instanceof DegradedModeError &&
        err.statusCode === 503 &&
        err.retryAfterSeconds === 30 &&
        err.unavailableDependencies.includes("soroban_rpc"),
    );

    // Read falls back to stale cache within TTL
    const readFallback = await ctrl.executeWithFallback({
      dependency: "soroban_rpc",
      operationType: "read",
      primaryFn: async () => {
        throw new Error("unreachable");
      },
      staleCacheFn: async () => ({
        data: { apy: "4.2%" },
        asOf: "2026-11-19T10:05:00.000Z",
      }),
    });
    assert.equal(readFallback.degraded, true);
    assert.equal(readFallback.stale, true);
    assert.deepEqual(readFallback.data, { apy: "4.2%" });

    // Redis cache unavailable bypasses cache to primaryFn
    ctrl.recordFailure("redis_cache", "conn_refused");
    ctrl.recordFailure("redis_cache", "conn_refused");
    const cacheBypass = await ctrl.executeWithFallback({
      dependency: "redis_cache",
      operationType: "read",
      primaryFn: async () => ({ live: true }),
    });
    assert.equal(cacheBypass.degraded, true);
    assert.equal(cacheBypass.stale, false);
    assert.deepEqual(cacheBypass.data, { live: true });
  });

  it("retry & recovery hysteresis path: retries transient errors and requires recoveryThreshold successes", async () => {
    const ctrl = new DegradedModeController({ failureThreshold: 3, recoveryThreshold: 2 });
    let calls = 0;

    const res = await ctrl.executeWithFallback({
      dependency: "database",
      operationType: "mutation",
      maxRetries: 2,
      primaryFn: async () => {
        calls += 1;
        if (calls === 1) {
          const err = new Error("transient deadlock");
          err.retryable = true;
          throw err;
        }
        return { ok: true };
      },
    });

    assert.equal(calls, 2);
    assert.deepEqual(res.data, { ok: true });
    assert.equal(ctrl.getState("database").status, "healthy");

    // Hysteresis: 3 failures -> unavailable; 1 success stays unavailable; 2nd success -> healthy
    ctrl.recordFailure("indexer");
    ctrl.recordFailure("indexer");
    ctrl.recordFailure("indexer");
    assert.equal(ctrl.getState("indexer").status, "unavailable");

    ctrl.recordSuccess("indexer");
    assert.equal(ctrl.getState("indexer").status, "unavailable");

    ctrl.recordSuccess("indexer");
    assert.equal(ctrl.getState("indexer").status, "healthy");
  });

  it("authorization path: allows admin override and blocks unprivileged users", () => {
    const ctrl = new DegradedModeController();

    assert.throws(
      () => ctrl.overrideDependencyState(user, "database", "unavailable", "drill"),
      (err) => err instanceof DegradationAuthorizationError && err.statusCode === 403,
    );

    const updated = ctrl.overrideDependencyState(admin, "database", "unavailable", "maintenance_drill");
    assert.equal(updated.status, "unavailable");
    assert.equal(updated.overrideReason, "maintenance_drill");
  });
});
