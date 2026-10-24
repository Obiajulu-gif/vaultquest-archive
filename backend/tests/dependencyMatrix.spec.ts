/**
 * Executable verification for the dependency degradation matrix.
 *
 * Tests verify:
 * 1. All critical dependencies are documented with failure modes
 * 2. Fallback behavior is defined for each scenario
 * 3. User-safe error messages are used
 * 4. Integration with DegradedModeService works correctly
 */

import { describe, it, expect, beforeEach } from "vitest";
import { DegradedModeService } from "../src/services/degradedModeService.js";
import { DependencyMatrixValidator } from "../src/services/dependencyMatrixValidator.js";
import {
  VAULTQUEST_DEPENDENCY_MATRIX,
  getMutationCriticalDependencies,
  getReadCriticalDependencies,
  getDependencyDefinition,
} from "../src/schemas/dependencyMatrix.js";
import { createLogger } from "../src/logger.js";

describe("Dependency Degradation Matrix", () => {
  let degradedModeService: DegradedModeService;
  let validator: DependencyMatrixValidator;
  const logger = createLogger();

  beforeEach(() => {
    degradedModeService = new DegradedModeService();
    validator = new DependencyMatrixValidator();
  });

  describe("Matrix Structure", () => {
    it("should have documented all critical dependencies", () => {
      const deps = VAULTQUEST_DEPENDENCY_MATRIX.dependencies;
      expect(deps.length).toBeGreaterThan(0);
      expect(deps.map((d) => d.id)).toContain("database");
      expect(deps.map((d) => d.id)).toContain("soroban_rpc");
    });

    it("should have at least one mutations-critical dependency", () => {
      const critical = getMutationCriticalDependencies();
      expect(critical.length).toBeGreaterThan(0);
    });

    it("should have failure modes for each dependency", () => {
      const deps = VAULTQUEST_DEPENDENCY_MATRIX.dependencies;
      for (const dep of deps) {
        expect(dep.failureModes.length).toBeGreaterThan(0);
        for (const mode of dep.failureModes) {
          expect(mode.scenario).toBeDefined();
          expect(mode.trigger).toBeDefined();
          expect(mode.userImpact).toBeDefined();
          expect(mode.fallbackBehavior).toBeDefined();
          expect(mode.retryStrategy).toBeDefined();
          expect(mode.timeToRecover).toBeDefined();
        }
      }
    });

    it("should have primary fallback strategies defined", () => {
      const deps = VAULTQUEST_DEPENDENCY_MATRIX.dependencies;
      for (const dep of deps) {
        expect(dep.primaryFallback).toBeDefined();
        expect(dep.primaryFallback.length).toBeGreaterThan(0);
      }
    });

    it("should have config env vars for each dependency", () => {
      const deps = VAULTQUEST_DEPENDENCY_MATRIX.dependencies;
      for (const dep of deps) {
        expect(dep.configEnvVar).toBeDefined();
        expect(dep.configEnvVar.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Matrix Queries", () => {
    it("should retrieve a dependency definition by ID", () => {
      const db = getDependencyDefinition("database");
      expect(db).toBeDefined();
      expect(db?.id).toBe("database");
      expect(db?.requiredForMutations).toBe(true);
    });

    it("should return mutations-critical dependencies", () => {
      const critical = getMutationCriticalDependencies();
      const ids = critical.map((d) => d.id);
      expect(ids).toContain("database");
      expect(ids).toContain("soroban_rpc");
      expect(ids).not.toContain("redis_cache");
    });

    it("should return read-critical dependencies", () => {
      const readCritical = getReadCriticalDependencies();
      const ids = readCritical.map((d) => d.id);
      expect(ids).toContain("database");
      expect(ids).toContain("soroban_rpc");
    });
  });

  describe("DegradedModeService Integration", () => {
    it("should register all documented dependencies", () => {
      const allDeps = degradedModeService.getAllDependencies();
      expect(allDeps).toHaveProperty("database");
      expect(allDeps).toHaveProperty("soroban_rpc");
      expect(allDeps).toHaveProperty("redis_cache");
      expect(allDeps).toHaveProperty("indexer");
    });

    it("should mark mutations unavailable when database is unavailable", () => {
      degradedModeService.setDependencyStatus("database", "unavailable", "test");
      expect(() =>
        degradedModeService.assertMutationAllowed(["database", "soroban_rpc"])
      ).toThrow();
    });

    it("should allow mutations when all required dependencies are healthy", () => {
      expect(() =>
        degradedModeService.assertMutationAllowed(["database", "soroban_rpc"])
      ).not.toThrow();
    });

    it("should track failure and recovery transitions", () => {
      const dep = degradedModeService.getDependency("redis_cache");
      expect(dep?.status).toBe("healthy");

      degradedModeService.recordFailure("redis_cache");
      expect(degradedModeService.getDependency("redis_cache")?.status).toBe("degraded");

      degradedModeService.recordFailure("redis_cache");
      expect(degradedModeService.getDependency("redis_cache")?.status).toBe("degraded");

      // After recovery threshold, should return to healthy
      degradedModeService.recordSuccess("redis_cache");
      degradedModeService.recordSuccess("redis_cache");
      expect(degradedModeService.getDependency("redis_cache")?.status).toBe("healthy");
    });
  });

  describe("User-Safe Error Messages", () => {
    it("should provide user-safe status when healthy", () => {
      const status = degradedModeService.getUserSafeStatus();
      expect(status.status).toBe("healthy");
      expect(status.userBanner).toBeNull();
    });

    it("should provide user-safe status when degraded", () => {
      degradedModeService.recordFailure("redis_cache", undefined, "Cache service is slow");
      const status = degradedModeService.getUserSafeStatus();
      expect(status.status).toBe("degraded");
      expect(status.userBanner).toBeDefined();
      expect(status.userBanner).not.toContain("internal");
      expect(status.userBanner).not.toContain("debug");
    });

    it("should provide Retry-After header when unavailable", () => {
      degradedModeService.setDependencyStatus("database", "unavailable", "test");
      const status = degradedModeService.getUserSafeStatus();
      expect(status.status).toBe("unavailable");
      expect(status.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("should include impact descriptions for each dependency", () => {
      degradedModeService.setDependencyStatus("database", "unavailable");
      const status = degradedModeService.getUserSafeStatus();
      for (const dep of status.dependencies) {
        expect(dep.impact).toBeDefined();
        expect(dep.impact.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Fallback Read Behavior", () => {
    it("should fall back to snapshot when dependency is unavailable", async () => {
      degradedModeService.setDependencyStatus("redis_cache", "unavailable");

      const snapshot = { key: "value" };
      const result = await degradedModeService.executeRead({
        dependency: "redis_cache",
        primary: async () => {
          throw new Error("Service unavailable");
        },
        fallbackSnapshot: snapshot,
      });

      expect(result.degraded).toBe(true);
      expect(result.data).toEqual(snapshot);
      expect(result.warning).toBeDefined();
    });

    it("should prefer fallback cache over snapshot", async () => {
      const cachedData = { key: "cached" };
      const snapshot = { key: "snapshot" };

      const result = await degradedModeService.executeRead({
        dependency: "redis_cache",
        primary: async () => {
          throw new Error("Service unavailable");
        },
        fallback: async () => ({
          value: cachedData,
          cachedAt: new Date(),
        }),
        fallbackSnapshot: snapshot,
      });

      expect(result.data).toEqual(cachedData);
      expect(result.data).not.toEqual(snapshot);
    });

    it("should mark stale data when no fresh primary available", async () => {
      const cachedAt = new Date(Date.now() - 60000); // 60 seconds ago
      const result = await degradedModeService.executeRead({
        dependency: "soroban_rpc",
        primary: async () => {
          throw new Error("Service down");
        },
        fallback: async () => ({
          value: { poolState: "old" },
          cachedAt,
        }),
      });

      expect(result.stale).toBe(true);
      expect(result.degraded).toBe(true);
      expect(result.warning).toContain("cached");
    });
  });

  describe("Validator", () => {
    it("should validate the dependency matrix on startup", async () => {
      const report = await validator.validate({
        degradedModeService,
        logger,
      });

      expect(report.passed).toBe(true);
      expect(report.results.length).toBeGreaterThan(0);
    });

    it("should validate matrix completeness", async () => {
      const report = await validator.validate({
        degradedModeService,
        logger,
      });

      const completenessResult = report.results.find((r) => r.rule === "matrix-completeness");
      expect(completenessResult).toBeDefined();
      expect(completenessResult?.result.passed).toBe(true);
    });

    it("should validate degraded-mode coverage", async () => {
      const report = await validator.validate({
        degradedModeService,
        logger,
      });

      const coverageResult = report.results.find((r) => r.rule === "degraded-mode-coverage");
      expect(coverageResult).toBeDefined();
      expect(coverageResult?.result.passed).toBe(true);
    });

    it("should include operational guidance in report", async () => {
      const report = await validator.validate({
        degradedModeService,
        logger,
      });

      expect(report.operationalGuidance.length).toBeGreaterThan(0);
      expect(report.operationalGuidance[0]).toContain(
        "Reference: backend/src/schemas/dependencyMatrix.ts"
      );
    });
  });

  describe("Operational Edge Cases", () => {
    it("should handle recordFailure with user-safe reason", () => {
      degradedModeService.recordFailure(
        "soroban_rpc",
        new Error("Connection refused"),
        "Blockchain service is temporarily unavailable"
      );

      const dep = degradedModeService.getDependency("soroban_rpc");
      expect(dep?.userSafeReason).toBe("Blockchain service is temporarily unavailable");
      expect(dep?.userSafeReason).not.toContain("Connection refused");
    });

    it("should provide sensible defaults for user-safe reason", () => {
      degradedModeService.recordFailure("redis_cache");

      const dep = degradedModeService.getDependency("redis_cache");
      expect(dep?.userSafeReason).toContain("redis_cache");
      expect(dep?.userSafeReason).not.toContain("Error:");
    });

    it("should track latency metrics", () => {
      degradedModeService.recordSuccess("database", 125);

      const dep = degradedModeService.getDependency("database");
      expect(dep?.latencyMs).toBe(125);
    });

    it("should track consecutive failures and successes", () => {
      const dep1 = degradedModeService.getDependency("redis_cache");
      expect(dep1?.consecutiveFailures).toBe(0);
      expect(dep1?.consecutiveSuccesses).toBeGreaterThan(0);

      degradedModeService.recordFailure("redis_cache");
      const dep2 = degradedModeService.getDependency("redis_cache");
      expect(dep2?.consecutiveFailures).toBe(1);
      expect(dep2?.consecutiveSuccesses).toBe(0);
    });
  });
});
