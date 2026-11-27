// SPDX-License-Identifier: MIT

/**
 * Dependency-aware public health status (#1164).
 *
 * Verifies the public-safe aggregate, dependency propagation, bounded retries,
 * stale fallback, authorized operator overrides and their rollback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PublicHealthAuthorizationError,
  PublicHealthStatusService,
  PublicHealthValidationError,
  sanitizeHealthDetail,
} from "../../src/lib/public-health-status.mjs";

const START = new Date("2026-11-22T10:00:00.000Z");
const admin = { id: "admin-1", role: "admin" };
const viewer = { id: "viewer-1", role: "user" };

function makeService(overrides = {}) {
  let current = new Date(START);
  const service = new PublicHealthStatusService({
    nowFn: () => current,
    cacheTtlMs: 5_000,
    staleTtlMs: 60_000,
    maxRetries: 1,
    ...overrides,
  });
  return {
    service,
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
  };
}

function registerHealthyProbes(service) {
  for (const name of ["api", "database", "soroban_rpc", "indexer", "redis_cache"]) {
    service.registerProbe(name, () => "healthy");
  }
}

describe("dependency-aware public health status (#1164)", () => {
  it("normal path: aggregates healthy probes into a sanitized, cached public document", async () => {
    const { service, advance } = makeService();
    let apiCalls = 0;
    registerHealthyProbes(service);
    service.registerProbe("api", () => {
      apiCalls += 1;
      return { status: "healthy", detail: "Bearer token abc123", latencyMs: 12 };
    });

    const report = await service.getStatus();
    assert.equal(report.status, "healthy");
    assert.equal(report.checkedAt, START.toISOString());
    assert.equal(report.cached, false);
    assert.equal(report.components.api.effectiveStatus, "healthy");
    assert.equal(report.components.api.latencyMs, 12);
    assert.equal(report.components.api.detail, "[REDACTED]");
    assert.deepEqual(report.blockingDependencies, []);
    assert.equal(report.retryAfterSeconds, null);
    assert.equal(JSON.stringify(report).includes("abc123"), false);
    assert.equal(apiCalls, 1);

    const cached = await service.getStatus();
    assert.equal(cached.cached, true);
    assert.equal(apiCalls, 1); // no re-probe inside the TTL window

    advance(6_000);
    const fresh = await service.getStatus();
    assert.equal(fresh.cached, false);
    assert.equal(apiCalls, 2);
  });

  it("failure path: omits raw errors, blocks on required dependencies and degrades dependents", async () => {
    const { service } = makeService();
    registerHealthyProbes(service);
    service.registerProbe("database", () => {
      throw new Error("postgres://admin:topsecret@internal-host:5432/vaultquest");
    });

    const report = await service.getStatus();
    assert.equal(report.status, "unavailable");
    assert.deepEqual(report.blockingDependencies, ["database"]);
    assert.equal(report.retryAfterSeconds, 30);
    assert.equal(report.components.database.status, "unavailable");
    assert.equal(report.components.database.probeAttempts, 2);
    assert.equal(JSON.stringify(report).includes("topsecret"), false);
    assert.equal(JSON.stringify(report).includes("internal-host"), false);

    // indexer depends on database: it cannot be reported healthy while its
    // dependency is unavailable, but it is not itself blocking.
    assert.equal(report.components.indexer.status, "healthy");
    assert.equal(report.components.indexer.effectiveStatus, "degraded");

    assert.equal(sanitizeHealthDetail("api_key=abcd"), "[REDACTED]");
    assert.equal(sanitizeHealthDetail("service nominal"), "service nominal");
  });

  it("retry & rollback path: retries transient failures, serves stale state, then recovers", async () => {
    const { service, advance } = makeService();
    let rpcAttempts = 0;
    let cacheHealthy = true;
    registerHealthyProbes(service);
    service.registerProbe("soroban_rpc", () => {
      rpcAttempts += 1;
      if (rpcAttempts === 1) throw new Error("transient timeout");
      return "healthy";
    });
    service.registerProbe("redis_cache", () => {
      if (!cacheHealthy) throw new Error("connection refused");
      return "healthy";
    });

    const initial = await service.getStatus();
    assert.equal(initial.status, "healthy");
    assert.equal(rpcAttempts, 2);

    cacheHealthy = false;
    advance(1_000);
    const stale = await service.getStatus({ actor: admin, forceRefresh: true });
    assert.equal(stale.status, "degraded");
    assert.equal(stale.components.redis_cache.stale, true);
    assert.equal(stale.components.redis_cache.effectiveStatus, "degraded");

    const override = service.overrideComponentStatus("redis_cache", "unavailable", admin, "incident-42");
    assert.equal(override.status, "unavailable");
    const overridden = await service.getStatus({ actor: admin, forceRefresh: true });
    assert.equal(overridden.components.redis_cache.overridden, true);
    assert.equal(overridden.status, "degraded"); // optional dependency is not blocking

    assert.equal(service.clearOverride("redis_cache", admin), true);
    cacheHealthy = true;
    advance(1_000);
    const recovered = await service.getStatus({ actor: admin, forceRefresh: true });
    assert.equal(recovered.status, "healthy");
    assert.equal(recovered.components.redis_cache.overridden, undefined);
  });

  it("authorization path: public reads are open, forced refreshes and overrides are privileged", async () => {
    const { service } = makeService();
    registerHealthyProbes(service);

    const publicReport = await service.getStatus();
    assert.equal(publicReport.status, "healthy");

    await assert.rejects(
      () => service.getStatus({ actor: viewer, forceRefresh: true }),
      (err) => err instanceof PublicHealthAuthorizationError && err.statusCode === 403,
    );
    assert.throws(
      () => service.overrideComponentStatus("database", "degraded", viewer),
      (err) => err instanceof PublicHealthAuthorizationError && err.code === "PUBLIC_HEALTH_UNAUTHORIZED",
    );
    assert.throws(() => service.clearOverride("database", viewer), PublicHealthAuthorizationError);
    assert.throws(
      () => service.overrideComponentStatus("database", "unknown", admin),
      PublicHealthValidationError,
    );
    assert.throws(
      () => service.overrideComponentStatus("not-a-component", "degraded", admin),
      PublicHealthValidationError,
    );

    service.overrideComponentStatus("database", "degraded", { id: "oncall", role: "operator" });
    const overridden = await service.getStatus({ actor: admin, forceRefresh: true });
    assert.equal(overridden.status, "degraded");
  });
});
