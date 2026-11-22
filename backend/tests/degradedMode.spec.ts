import { describe, it, expect, beforeEach } from "vitest";
import {
  DegradedModeService,
  DegradedModeError,
  type DegradedModeConfig
} from "../src/services/degradedModeService.js";
import { buildApp } from "../src/app.js";

describe("DegradedModeService", () => {
  let service: DegradedModeService;
  const config: DegradedModeConfig = {
    failureThreshold: 2,
    recoveryThreshold: 2,
    retryAfterSeconds: 15,
    maxStaleDataTtlMs: 60_000
  };

  beforeEach(() => {
    service = new DegradedModeService(config);
  });

  it("starts in healthy operational state", () => {
    expect(service.isDegraded()).toBe(false);
    const report = service.getUserSafeStatus();
    expect(report.status).toBe("healthy");
    expect(report.userBanner).toBeNull();
  });

  it("transitions from healthy to degraded, then unavailable on consecutive failures", () => {
    // 1st failure -> degraded
    service.recordFailure("soroban_rpc", new Error("RPC timeout"));
    expect(service.isDegraded()).toBe(true);
    expect(service.getDependency("soroban_rpc")?.status).toBe("degraded");

    // 2nd failure -> unavailable (reaches failureThreshold = 2)
    service.recordFailure("soroban_rpc", new Error("Connection refused"));
    expect(service.getDependency("soroban_rpc")?.status).toBe("unavailable");

    const report = service.getUserSafeStatus();
    expect(report.status).toBe("unavailable");
    expect(report.userBanner).toContain("upstream service disruptions");
  });

  it("recovers from unavailable to healthy via consecutive successes", () => {
    service.setDependencyStatus("database", "unavailable", "DB connection lost");
    expect(service.isDegraded()).toBe(true);

    // 1st success -> still recovering
    service.recordSuccess("database", 12);
    expect(service.getDependency("database")?.status).toBe("unavailable");

    // 2nd success -> recovered to healthy (reaches recoveryThreshold = 2)
    service.recordSuccess("database", 10);
    expect(service.getDependency("database")?.status).toBe("healthy");
    expect(service.isDegraded()).toBe(false);
  });

  it("gates mutations when required dependencies are unavailable", () => {
    // Both healthy -> mutation allowed
    expect(() => service.assertMutationAllowed(["database", "soroban_rpc"])).not.toThrow();

    // Secondary dependency down -> mutation still allowed
    service.setDependencyStatus("redis_cache", "unavailable");
    expect(() => service.assertMutationAllowed(["database", "soroban_rpc"])).not.toThrow();

    // Critical dependency down -> mutation blocked with 503
    service.setDependencyStatus("soroban_rpc", "unavailable");
    expect(() => service.assertMutationAllowed(["database", "soroban_rpc"])).toThrow(DegradedModeError);

    try {
      service.assertMutationAllowed(["database", "soroban_rpc"]);
    } catch (err: any) {
      expect(err).toBeInstanceOf(DegradedModeError);
      expect(err.statusCode).toBe(503);
      expect(err.retryAfterSeconds).toBe(15);
      expect(err.unavailableDependencies).toContain("soroban_rpc");
    }
  });

  it("executes reads gracefully with stale fallback when dependency degrades", async () => {
    const cachedAt = new Date(Date.now() - 30_000);
    const fallbackData = { poolId: "pool-1", balance: "1000" };

    // Primary failure triggers fallback
    const result = await service.executeRead({
      dependency: "soroban_rpc",
      primary: async () => {
        throw new Error("RPC network failure");
      },
      fallback: async () => ({ value: fallbackData, cachedAt })
    });

    expect(result.degraded).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.data).toEqual(fallbackData);
    expect(result.warning).toContain("Live updates are delayed");
  });

  it("falls back to static snapshot when both primary and cache fallback fail", async () => {
    const snapshot = { items: ["snapshot-1", "snapshot-2"] };
    const result = await service.executeRead({
      dependency: "redis_cache",
      primary: async () => {
        throw new Error("Cache unreachable");
      },
      fallback: async () => null,
      fallbackSnapshot: snapshot
    });

    expect(result.degraded).toBe(true);
    expect(result.stale).toBe(true);
    expect(result.data).toEqual(snapshot);
  });

  it("throws DegradedModeError when all read options fail", async () => {
    await expect(
      service.executeRead({
        dependency: "database",
        primary: async () => {
          throw new Error("DB fatal");
        }
      })
    ).rejects.toThrow(DegradedModeError);
  });

  it("exposes degraded mode health via GET /health/degraded", async () => {
    const app = await buildApp({
      prisma: {} as any,
      internalSecret: "test-secret",
      degradedModeService: service
    });

    // When healthy -> 200
    const healthyRes = await app.inject({
      method: "GET",
      url: "/health/degraded"
    });
    expect(healthyRes.statusCode).toBe(200);
    expect(healthyRes.json().data.status).toBe("healthy");

    // When unavailable -> 503 with Retry-After header
    service.setDependencyStatus("database", "unavailable");
    const degradedRes = await app.inject({
      method: "GET",
      url: "/health/degraded"
    });
    expect(degradedRes.statusCode).toBe(503);
    expect(degradedRes.headers["retry-after"]).toBe("15");
    expect(degradedRes.json().data.status).toBe("unavailable");
    expect(degradedRes.json().data.userBanner).toContain("disruptions");

    await app.close();
  });
});
