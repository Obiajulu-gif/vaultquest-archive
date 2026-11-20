import { describe, it, expect, vi } from "vitest";
import {
  runIncidentRecoveryChecks,
  assertAuthorizedOperator,
  IncidentRecoveryAuthError,
  type OperatorContext,
} from "../lib/incident-recovery-checks";

describe("Incident Recovery Checks (#1093)", () => {
  const authorizedOperator: OperatorContext = {
    operatorId: "lead-1",
    role: "incident_commander",
  };

  describe("Normal Path", () => {
    it("reports RECOVERED and passed when all components are healthy", async () => {
      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        indexerHealthFetcher: async () => ({ indexedLedger: 5000, networkLedger: 5002 }),
        reconciliationFetcher: async () => ({
          driftCount: 0,
          stuckSettlements: 0,
          unhandledContradictions: 0,
        }),
        circuitBreakerFetcher: async () => ({
          "withdrawal-submission-enabled": true,
          "prize-draw-execution": true,
        }),
        rpcHealthFetcher: async () => ({
          reachable: true,
          networkPassphrase: "Test SDF Future Network ; October 2022",
        }),
        expectedPassphrase: "Test SDF Future Network ; October 2022",
      });

      expect(report.passed).toBe(true);
      expect(report.overallStatus).toBe("RECOVERED");
      expect(report.checks).toHaveLength(4);
      expect(report.checks.every((c) => c.status === "pass")).toBe(true);
      expect(report.remediationSteps).toHaveLength(0);
      expect(report.operator.id).toBe("lead-1");
    });
  });

  describe("Failure Paths", () => {
    it("detects excessive indexer lag and advises remediation", async () => {
      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        maxAllowedIndexerLag: 5,
        indexerHealthFetcher: async () => ({ indexedLedger: 1000, networkLedger: 1050 }),
      });

      expect(report.passed).toBe(false);
      expect(report.overallStatus).toBe("ACTION_REQUIRED");
      const indexerCheck = report.checks.find((c) => c.category === "indexer_sync");
      expect(indexerCheck?.status).toBe("fail");
      expect(indexerCheck?.message).toContain("Indexer lagging significantly: 50 ledgers behind");
      expect(indexerCheck?.remediation).toBeDefined();
      expect(report.remediationSteps).toContain(indexerCheck!.remediation!);
    });

    it("flags unhandled financial contradictions as critical reconciliation failures", async () => {
      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        reconciliationFetcher: async () => ({
          driftCount: 2,
          stuckSettlements: 0,
          unhandledContradictions: 1,
        }),
      });

      expect(report.passed).toBe(false);
      expect(report.overallStatus).toBe("ACTION_REQUIRED");
      const reconCheck = report.checks.find((c) => c.category === "reconciliation");
      expect(reconCheck?.status).toBe("fail");
      expect(reconCheck?.message).toContain("CRITICAL: 1 unhandled financial contradictions");
    });

    it("detects stuck settlements past TTL", async () => {
      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        reconciliationFetcher: async () => ({
          driftCount: 0,
          stuckSettlements: 3,
          unhandledContradictions: 0,
        }),
      });

      expect(report.passed).toBe(false);
      const reconCheck = report.checks.find((c) => c.category === "reconciliation");
      expect(reconCheck?.status).toBe("fail");
      expect(reconCheck?.message).toContain("3 settlements stuck past TTL");
    });

    it("flags RPC network passphrase mismatch", async () => {
      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        rpcHealthFetcher: async () => ({
          reachable: true,
          networkPassphrase: "Wrong Passphrase",
        }),
        expectedPassphrase: "Test SDF Future Network ; October 2022",
      });

      expect(report.passed).toBe(false);
      const rpcCheck = report.checks.find((c) => c.category === "rpc_connectivity");
      expect(rpcCheck?.status).toBe("fail");
      expect(rpcCheck?.message).toContain("Passphrase mismatch");
    });
  });

  describe("Retry Path", () => {
    it("retries transient fetcher failures and succeeds", async () => {
      let callCount = 0;
      const transientRpc = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error("Connection reset by peer");
        return { reachable: true, networkPassphrase: "Test SDF Future Network ; October 2022" };
      });

      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        maxRetries: 2,
        retryDelayMs: 10,
        rpcHealthFetcher: transientRpc,
        expectedPassphrase: "Test SDF Future Network ; October 2022",
      });

      expect(report.passed).toBe(true);
      const rpcCheck = report.checks.find((c) => c.category === "rpc_connectivity");
      expect(rpcCheck?.status).toBe("pass");
      expect(rpcCheck?.retriesUsed).toBe(1);
      expect(transientRpc).toHaveBeenCalledTimes(2);
    });

    it("records failure when retries are exhausted", async () => {
      const failingFetcher = vi.fn().mockRejectedValue(new Error("Persistent 500 Internal Error"));

      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        maxRetries: 1,
        retryDelayMs: 5,
        indexerHealthFetcher: failingFetcher,
      });

      expect(report.passed).toBe(false);
      const check = report.checks.find((c) => c.category === "indexer_sync");
      expect(check?.status).toBe("fail");
      expect(check?.retriesUsed).toBe(1);
      expect(failingFetcher).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    });
  });

  describe("Authorization Path", () => {
    it("allows authorized roles: incident_commander, service_owner, admin, operator", () => {
      const roles: Array<OperatorContext["role"]> = [
        "incident_commander",
        "service_owner",
        "admin",
        "operator",
      ];
      for (const role of roles) {
        expect(() => assertAuthorizedOperator({ operatorId: "op", role })).not.toThrow();
      }
    });

    it("throws IncidentRecoveryAuthError for unauthorized roles or missing identity", async () => {
      expect(() => assertAuthorizedOperator({ operatorId: "guest", role: "guest" })).toThrowError(
        IncidentRecoveryAuthError,
      );
      expect(() => assertAuthorizedOperator({ operatorId: "", role: "admin" })).toThrowError(
        IncidentRecoveryAuthError,
      );

      await expect(
        runIncidentRecoveryChecks({
          operator: { operatorId: "anon", role: "guest" },
        }),
      ).rejects.toThrowError(IncidentRecoveryAuthError);
    });
  });

  describe("Edge Cases & Warning States", () => {
    it("marks overall status as CONTAINED when circuit breakers remain active but non-fatal", async () => {
      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        circuitBreakerFetcher: async () => ({
          "withdrawal-submission-enabled": false,
          "prize-draw-execution": true,
        }),
      });

      expect(report.passed).toBe(true);
      expect(report.overallStatus).toBe("CONTAINED");
      const cbCheck = report.checks.find((c) => c.category === "circuit_breakers");
      expect(cbCheck?.status).toBe("warn");
      expect(cbCheck?.message).toContain("Some features remain contained");
    });

    it("deduplicates remediation steps across multiple checks", async () => {
      const report = await runIncidentRecoveryChecks({
        operator: authorizedOperator,
        indexerHealthFetcher: async () => ({ indexedLedger: 100, networkLedger: 500 }),
        reconciliationFetcher: async () => ({
          driftCount: 5,
          stuckSettlements: 1,
          unhandledContradictions: 0,
        }),
      });

      // Verify each remediation step is unique
      const unique = Array.from(new Set(report.remediationSteps));
      expect(report.remediationSteps.length).toBe(unique.length);
    });
  });
});

