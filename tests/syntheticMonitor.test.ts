import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SyntheticMonitor,
  createDefaultJourneys,
  createHighValueJourneys,
  type JourneyDefinition,
  type JourneyAuthContext,
} from "../services/syntheticMonitor";

describe("SyntheticMonitor - High-Value User Journeys (#1092)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Normal Path", () => {
    it("executes a healthy journey, measures latency, and records result", async () => {
      const monitor = new SyntheticMonitor({ degradedThresholdMs: 1000 });
      const executeMock = vi.fn().mockImplementation(async () => {
        // Fast execution
      });

      monitor.registerJourney({
        name: "deposit",
        description: "Synthetic deposit journey",
        execute: executeMock,
        timeoutMs: 5000,
        intervalMs: 60000,
        enabled: true,
      });

      const result = await monitor.executeJourney("deposit");

      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(result.journey).toBe("deposit");
      expect(result.status).toBe("healthy");
      expect(result.error).toBeUndefined();
      expect(result.metadata?.retriesUsed).toBe(0);

      const statusMap = monitor.getStatus();
      expect(statusMap["deposit"]).toBe("healthy");

      const results = monitor.getResults("deposit");
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("healthy");
    });

    it("marks journey as degraded when latency exceeds threshold", async () => {
      const monitor = new SyntheticMonitor({ degradedThresholdMs: 100 });
      const executeMock = vi.fn().mockImplementation(async () => {
        vi.advanceTimersByTime(200);
      });

      monitor.registerJourney({
        name: "withdraw",
        description: "Synthetic withdraw",
        execute: executeMock,
        timeoutMs: 5000,
        intervalMs: 60000,
        enabled: true,
      });

      const result = await monitor.executeJourney("withdraw");
      expect(result.status).toBe("degraded");
      expect(result.latencyMs).toBeGreaterThanOrEqual(100);
    });

    it("executes all registered enabled journeys", async () => {
      const monitor = new SyntheticMonitor();
      const depositFn = vi.fn().mockResolvedValue(undefined);
      const withdrawFn = vi.fn().mockResolvedValue(undefined);
      const disabledFn = vi.fn().mockResolvedValue(undefined);

      monitor.registerJourney({
        name: "deposit",
        description: "Deposit",
        execute: depositFn,
        timeoutMs: 1000,
        intervalMs: 60000,
        enabled: true,
      });
      monitor.registerJourney({
        name: "withdraw",
        description: "Withdraw",
        execute: withdrawFn,
        timeoutMs: 1000,
        intervalMs: 60000,
        enabled: true,
      });
      monitor.registerJourney({
        name: "disabled_journey",
        description: "Disabled",
        execute: disabledFn,
        timeoutMs: 1000,
        intervalMs: 60000,
        enabled: false,
      });

      const results = await monitor.executeAll();
      expect(results).toHaveLength(2);
      expect(depositFn).toHaveBeenCalledTimes(1);
      expect(withdrawFn).toHaveBeenCalledTimes(1);
      expect(disabledFn).not.toHaveBeenCalled();
    });
  });

  describe("Failure and Timeout Paths", () => {
    it("marks journey as unhealthy on thrown error and emits alert after threshold", async () => {
      const monitor = new SyntheticMonitor({ alertThreshold: 2 });
      const alertListener = vi.fn();
      monitor.on("alert", alertListener);

      const failingFn = vi.fn().mockRejectedValue(new Error("RPC Connection Refused"));
      monitor.registerJourney({
        name: "claim",
        description: "Failing claim",
        execute: failingFn,
        timeoutMs: 2000,
        intervalMs: 60000,
        enabled: true,
      });

      // Attempt 1: failure 1 (below threshold)
      const res1 = await monitor.executeJourney("claim");
      expect(res1.status).toBe("unhealthy");
      expect(res1.error).toBe("RPC Connection Refused");
      expect(alertListener).not.toHaveBeenCalled();

      // Attempt 2: failure 2 (triggers alert)
      const res2 = await monitor.executeJourney("claim");
      expect(res2.status).toBe("unhealthy");
      expect(alertListener).toHaveBeenCalledTimes(1);
      expect(alertListener).toHaveBeenCalledWith(
        expect.objectContaining({
          journey: "claim",
          consecutiveFailures: 2,
          lastError: "RPC Connection Refused",
        }),
      );
    });

    it("marks journey as unhealthy when execution times out", async () => {
      const monitor = new SyntheticMonitor();
      const hangingFn = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      monitor.registerJourney({
        name: "slow_journey",
        description: "Slow journey",
        execute: hangingFn,
        timeoutMs: 500,
        intervalMs: 60000,
        enabled: true,
      });

      const execPromise = monitor.executeJourney("slow_journey");
      await vi.advanceTimersByTimeAsync(600);
      const res = await execPromise;

      expect(res.status).toBe("unhealthy");
      expect(res.error).toContain("timed out after 500ms");
    });

    it("throws error when executing an unregistered journey", async () => {
      const monitor = new SyntheticMonitor();
      await expect(monitor.executeJourney("non_existent")).rejects.toThrow("Unknown journey");
    });
  });

  describe("Retry Path", () => {
    it("retries a failing journey and recovers if a subsequent attempt succeeds", async () => {
      const monitor = new SyntheticMonitor();
      const retryListener = vi.fn();
      monitor.on("journey_retry", retryListener);

      let callCount = 0;
      const transientFn = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error("Temporary network glitch");
        }
        // Success on attempt 2
      });

      monitor.registerJourney({
        name: "deposit_with_retry",
        description: "Deposit with retry",
        execute: transientFn,
        timeoutMs: 2000,
        intervalMs: 60000,
        enabled: true,
        maxRetries: 2,
        retryDelayMs: 50,
      });

      const execPromise = monitor.executeJourney("deposit_with_retry");
      await vi.advanceTimersByTimeAsync(100);
      const result = await execPromise;

      expect(result.status).toBe("healthy");
      expect(result.metadata?.retriesUsed).toBe(1);
      expect(result.metadata?.recoveredOnRetry).toBe(true);
      expect(retryListener).toHaveBeenCalledTimes(1);
      expect(retryListener).toHaveBeenCalledWith(
        expect.objectContaining({
          journey: "deposit_with_retry",
          attempt: 1,
          maxRetries: 2,
        }),
      );
    });

    it("exhausts retries and marks journey unhealthy if all attempts fail", async () => {
      const monitor = new SyntheticMonitor();
      const failingFn = vi.fn().mockRejectedValue(new Error("Persistent failure"));

      monitor.registerJourney({
        name: "persistent_fail",
        description: "Persistent fail",
        execute: failingFn,
        timeoutMs: 2000,
        intervalMs: 60000,
        enabled: true,
        maxRetries: 2,
        retryDelayMs: 50,
      });

      const execPromise = monitor.executeJourney("persistent_fail");
      await vi.advanceTimersByTimeAsync(300);
      const result = await execPromise;

      expect(result.status).toBe("unhealthy");
      expect(result.error).toBe("Persistent failure");
      expect(result.metadata?.retriesExhausted).toBe(true);
      expect(result.metadata?.attemptsMade).toBe(3); // 1 initial + 2 retries
    });
  });

  describe("Authorization Path", () => {
    it("rejects unauthorized caller when journey requires authentication", async () => {
      const monitor = new SyntheticMonitor();
      const authFailureListener = vi.fn();
      monitor.on("auth_failure", authFailureListener);

      const secureFn = vi.fn().mockResolvedValue(undefined);
      monitor.registerJourney({
        name: "secure_deposit",
        description: "Secure deposit",
        execute: secureFn,
        timeoutMs: 2000,
        intervalMs: 60000,
        enabled: true,
        requireAuth: true,
      });

      // No auth context provided
      const result = await monitor.executeJourney("secure_deposit");
      expect(result.status).toBe("unhealthy");
      expect(result.error).toContain("UNAUTHORIZED: Authentication credentials required");
      expect(secureFn).not.toHaveBeenCalled();
      expect(authFailureListener).toHaveBeenCalledTimes(1);
    });

    it("verifies required roles and rejects callers lacking authorized roles", async () => {
      const monitor = new SyntheticMonitor();
      const secureFn = vi.fn().mockResolvedValue(undefined);

      monitor.registerJourney({
        name: "admin_only_journey",
        description: "Admin journey",
        execute: secureFn,
        timeoutMs: 2000,
        intervalMs: 60000,
        enabled: true,
        requireAuth: true,
        authorizedRoles: ["admin"],
      });

      // Role "user" should be rejected
      const denied = await monitor.executeJourney("admin_only_journey", {
        caller: "user-123",
        role: "user",
      });
      expect(denied.status).toBe("unhealthy");
      expect(denied.error).toContain("Role unauthorized");
      expect(secureFn).not.toHaveBeenCalled();

      // Role "admin" should succeed
      const allowed = await monitor.executeJourney("admin_only_journey", {
        caller: "admin-1",
        role: "admin",
      });
      expect(allowed.status).toBe("healthy");
      expect(secureFn).toHaveBeenCalledTimes(1);
    });

    it("supports custom authorize handler on journey definition", async () => {
      const monitor = new SyntheticMonitor();
      const secureFn = vi.fn().mockResolvedValue(undefined);

      monitor.registerJourney({
        name: "custom_auth_journey",
        description: "Custom auth",
        execute: secureFn,
        timeoutMs: 2000,
        intervalMs: 60000,
        enabled: true,
        requireAuth: true,
        authorize: (auth) => auth?.token === "secret-token-xyz",
      });

      const bad = await monitor.executeJourney("custom_auth_journey", {
        caller: "agent-1",
        token: "wrong-token",
      });
      expect(bad.status).toBe("unhealthy");

      const good = await monitor.executeJourney("custom_auth_journey", {
        caller: "agent-1",
        token: "secret-token-xyz",
      });
      expect(good.status).toBe("healthy");
    });
  });

  describe("Edge Cases & Lifecycle", () => {
    it("emits journey_recovered when an unhealthy journey recovers", async () => {
      const monitor = new SyntheticMonitor();
      const recoveryListener = vi.fn();
      monitor.on("journey_recovered", recoveryListener);

      let fail = true;
      const flakyFn = vi.fn().mockImplementation(async () => {
        if (fail) throw new Error("Fault");
      });

      monitor.registerJourney({
        name: "flaky_journey",
        description: "Flaky",
        execute: flakyFn,
        timeoutMs: 2000,
        intervalMs: 60000,
        enabled: true,
      });

      // First run fails
      await monitor.executeJourney("flaky_journey");
      expect(recoveryListener).not.toHaveBeenCalled();

      // Second run recovers
      fail = false;
      const ok = await monitor.executeJourney("flaky_journey");
      expect(ok.status).toBe("healthy");
      expect(recoveryListener).toHaveBeenCalledTimes(1);
      expect(recoveryListener).toHaveBeenCalledWith(
        expect.objectContaining({
          journey: "flaky_journey",
          previousFailures: 1,
        }),
      );
    });

    it("enforces bounded storage capacity to prevent memory leaks", async () => {
      const monitor = new SyntheticMonitor({ maxStoredResultsPerJourney: 3 });
      monitor.registerJourney({
        name: "bounded_journey",
        description: "Bounded",
        execute: async () => {},
        timeoutMs: 1000,
        intervalMs: 60000,
        enabled: true,
      });

      for (let i = 0; i < 5; i++) {
        await monitor.executeJourney("bounded_journey");
      }

      const results = monitor.getResults("bounded_journey");
      expect(results).toHaveLength(3);
    });

    it("starts and stops periodic monitoring intervals cleanly", () => {
      const monitor = new SyntheticMonitor();
      const started = vi.fn();
      const stopped = vi.fn();
      monitor.on("monitor_started", started);
      monitor.on("monitor_stopped", stopped);

      monitor.registerJourney({
        name: "periodic_journey",
        description: "Periodic",
        execute: async () => {},
        timeoutMs: 1000,
        intervalMs: 10000,
        enabled: true,
      });

      monitor.start();
      expect(started).toHaveBeenCalledTimes(1);

      monitor.stop();
      expect(stopped).toHaveBeenCalledTimes(1);
    });

    it("factory createHighValueJourneys produces deposit, withdraw, claim, quest_complete definitions", () => {
      const journeys = createHighValueJourneys({
        executeDeposit: async () => {},
        executeWithdraw: async () => {},
        executeClaim: async () => {},
        executeQuestComplete: async () => {},
      });

      expect(journeys).toHaveLength(4);
      expect(journeys.map((j) => j.name)).toEqual([
        "deposit",
        "withdraw",
        "claim",
        "quest_complete",
      ]);
      expect(journeys[0].requireAuth).toBe(true);
      expect(journeys[0].maxRetries).toBeGreaterThan(0);
    });

    it("factory createDefaultJourneys provides backward compatibility", () => {
      const journeys = createDefaultJourneys(
        async () => {},
        async () => {},
        async () => {},
      );
      expect(journeys).toHaveLength(3);
      expect(journeys.map((j) => j.name)).toEqual(["deposit", "withdraw", "claim"]);
    });
  });
});
