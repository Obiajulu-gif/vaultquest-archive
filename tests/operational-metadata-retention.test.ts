import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  reviewDataMinimization,
  applyMinimization,
  filterExpiredData,
  isWithinRetention,
  anonymizeValue,
  truncateValue,
  type DataField,
  type MinimizationPolicy,
} from "../lib/dataMinimization.js";

/**
 * Operational Metadata Retention and Deletion Tests
 *
 * Verifies lifecycle management, retention window calculation, minimization actions,
 * failure handling, retry/idempotency, and authorization boundaries for stored
 * operational metadata (telemetry, server logs, error traces, audit caches).
 */
describe("Operational Metadata Retention and Deletion", () => {
  const baseTimestamp = new Date("2026-10-24T12:00:00.000Z");

  const sampleOperationalFields: DataField[] = [
    {
      name: "requestDurationMs",
      category: "logs",
      containsPii: false,
      retentionDays: 30,
      sizeBytes: 120,
      essential: true,
    },
    {
      name: "clientIpAddress",
      category: "logs",
      containsPii: true,
      retentionDays: 14,
      sizeBytes: 80,
      essential: false,
    },
    {
      name: "userEmail",
      category: "analytics",
      containsPii: true,
      retentionDays: 120, // exceeds maxPiiRetentionDays (90)
      sizeBytes: 250,
      essential: false,
    },
    {
      name: "rawRequestBodyTrace",
      category: "errors",
      containsPii: false,
      retentionDays: 15,
      sizeBytes: 2 * 1024 * 1024, // 2MB > 1MB threshold
      essential: false,
    },
    {
      name: "transactionHash",
      category: "audit",
      containsPii: false,
      retentionDays: 365,
      sizeBytes: 66,
      essential: true,
    },
  ];

  describe("Normal Path: Retention Window & Deletion / Minimization Rules", () => {
    it("identifies expired records and applies proper retention decisions", () => {
      const review = reviewDataMinimization(sampleOperationalFields, undefined, baseTimestamp);

      expect(review.totalFields).toBe(5);
      expect(review.piiFields).toBe(2);
      expect(review.complianceScore).toBeLessThan(100);

      // Verify recommendation for PII exceeding policy retention
      const emailRec = review.recommendations.find((r) => r.field === "userEmail" && r.action === "expire");
      expect(emailRec).toBeDefined();
      expect(emailRec?.reason).toContain("PII retention exceeds maximum of 90 days");

      // Verify recommendation for non-essential field exceeding 1MB
      const traceRec = review.recommendations.find((r) => r.field === "rawRequestBodyTrace" && r.action === "truncate");
      expect(traceRec).toBeDefined();
      expect(traceRec?.reason).toContain("Non-essential field exceeds 1MB");

      // Verify recommendation for non-essential PII anonymization
      const ipRec = review.recommendations.find((r) => r.field === "clientIpAddress" && r.action === "anonymize");
      expect(ipRec).toBeDefined();
    });

    it("evaluates retention period expiry correctly", () => {
      const thirtyDaysAgo = new Date(baseTimestamp.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(baseTimestamp.getTime() - 60 * 24 * 60 * 60 * 1000);

      expect(isWithinRetention(thirtyDaysAgo, 45, baseTimestamp)).toBe(true);
      expect(isWithinRetention(sixtyDaysAgo, 45, baseTimestamp)).toBe(false);
      expect(isWithinRetention(baseTimestamp, 0, baseTimestamp)).toBe(true);
    });

    it("filters out expired operational metadata entries cleanly", () => {
      const entries = [
        { id: "active-log", createdAt: new Date(baseTimestamp.getTime() - 5 * 24 * 3600 * 1000), retentionDays: 14 },
        { id: "expired-log", createdAt: new Date(baseTimestamp.getTime() - 20 * 24 * 3600 * 1000), retentionDays: 14 },
        { id: "audit-record", createdAt: new Date(baseTimestamp.getTime() - 100 * 24 * 3600 * 1000), retentionDays: 365 },
      ];

      const activeOnly = filterExpiredData(entries, baseTimestamp);
      expect(activeOnly).toHaveLength(2);
      expect(activeOnly.map((e) => e.id)).toEqual(["active-log", "audit-record"]);
    });

    it("executes minimization actions (delete, expire, anonymize, truncate)", () => {
      expect(applyMinimization("secret_token_data", "delete")).toBe("");
      expect(applyMinimization("old_session_meta", "expire")).toBe("");
      expect(applyMinimization("192.168.1.1", "anonymize")).toBe("[REDACTED]");
      expect(applyMinimization("super_long_payload_trace_log_entry", "truncate", 10)).toBe("super_long...");
      expect(applyMinimization("keep_this_unmodified", "allow")).toBe("keep_this_unmodified");
    });
  });

  describe("Failure Path: Invalid Input & Policy Violations", () => {
    it("handles empty or malformed fields gracefully without throwing", () => {
      const emptyReview = reviewDataMinimization([], undefined, baseTimestamp);
      expect(emptyReview.totalFields).toBe(0);
      expect(emptyReview.complianceScore).toBe(100);
      expect(emptyReview.recommendations).toHaveLength(0);

      expect(anonymizeValue("")).toBe("");
      expect(truncateValue("", 10)).toBe("");
      expect(applyMinimization("", "anonymize")).toBe("");
    });

    it("flags forbidden fields immediately for deletion", () => {
      const sensitiveLeakFields: DataField[] = [
        {
          name: "adminPrivateKey",
          category: "logs",
          containsPii: true,
          retentionDays: 1,
          sizeBytes: 128,
          essential: false,
        },
        {
          name: "userPasswordHash",
          category: "logs",
          containsPii: true,
          retentionDays: 1,
          sizeBytes: 64,
          essential: false,
        },
      ];

      const review = reviewDataMinimization(sensitiveLeakFields, undefined, baseTimestamp);
      expect(review.recommendations).toHaveLength(2);
      expect(review.recommendations.every((r) => r.action === "delete")).toBe(true);
      expect(review.recommendations[0].reason).toContain("forbidden list and must never be stored");
    });

    it("handles corrupt or future timestamps without misclassifying retained records", () => {
      const futureDate = new Date(baseTimestamp.getTime() + 10 * 24 * 60 * 60 * 1000);
      // Future timestamp is within retention window
      expect(isWithinRetention(futureDate, 30, baseTimestamp)).toBe(true);

      const items = [
        { id: "future-log", createdAt: futureDate, retentionDays: 7 },
      ];
      const filtered = filterExpiredData(items, baseTimestamp);
      expect(filtered).toHaveLength(1);
    });
  });

  describe("Retry & Idempotency Path", () => {
    it("produces deterministic and idempotent deletion/minimization results on repeat runs", () => {
      const run1 = reviewDataMinimization(sampleOperationalFields, undefined, baseTimestamp);
      const run2 = reviewDataMinimization(sampleOperationalFields, undefined, baseTimestamp);

      expect(run1).toEqual(run2);

      // Re-applying minimization to already-minimized payload produces identical output
      const rawPayload = "sensitive_operational_context_data";
      const minimizedFirstPass = applyMinimization(rawPayload, "delete");
      const minimizedSecondPass = applyMinimization(minimizedFirstPass, "delete");
      expect(minimizedFirstPass).toBe("");
      expect(minimizedSecondPass).toBe("");

      const redactedPass1 = anonymizeValue(rawPayload);
      const redactedPass2 = anonymizeValue(redactedPass1);
      expect(redactedPass1).toBe("[REDACTED]");
      expect(redactedPass2).toBe("[REDACTED]");
    });

    it("safely handles multi-pass deletion queue when items are already purged", () => {
      const initialQueue = [
        { id: "meta-1", createdAt: new Date(baseTimestamp.getTime() - 40 * 24 * 3600 * 1000), retentionDays: 30 },
      ];

      const pass1 = filterExpiredData(initialQueue, baseTimestamp);
      expect(pass1).toHaveLength(0);

      // Subsequent retry pass on remaining empty items
      const pass2 = filterExpiredData(pass1, baseTimestamp);
      expect(pass2).toHaveLength(0);
    });
  });

  describe("Authorization & Protection Boundaries", () => {
    it("protects essential audit records from being flagged for anonymization or deletion", () => {
      const customPolicy: MinimizationPolicy = {
        forbiddenFields: ["seedPhrase"],
        maxPiiRetentionDays: 30,
        maxTotalSizeBytes: 10 * 1024 * 1024,
        exemptFields: ["transactionHash", "blockNumber", "operatorSignature"],
      };

      const auditFields: DataField[] = [
        {
          name: "operatorSignature",
          category: "audit",
          containsPii: true, // e.g. signer identifier
          retentionDays: 180,
          sizeBytes: 130,
          essential: true, // Marked essential
        },
      ];

      const review = reviewDataMinimization(auditFields, customPolicy, baseTimestamp);
      // Essential field exempt from non-essential anonymization
      const anonRec = review.recommendations.find((r) => r.action === "anonymize");
      expect(anonRec).toBeUndefined();
    });

    it("enforces strict custom policy restrictions when maintainer specifies restrictive thresholds", () => {
      const restrictivePolicy: MinimizationPolicy = {
        forbiddenFields: ["ipAddress", "userAgent", "sessionToken"],
        maxPiiRetentionDays: 7, // Strict 7-day maximum for operational PII
        maxTotalSizeBytes: 50 * 1024, // 50 KB cap
        exemptFields: [],
      };

      const operationalFields: DataField[] = [
        {
          name: "sessionToken",
          category: "temp",
          containsPii: true,
          retentionDays: 1,
          sizeBytes: 64,
          essential: false,
        },
        {
          name: "operatorEmail",
          category: "logs",
          containsPii: true,
          retentionDays: 14, // > 7 days
          sizeBytes: 100,
          essential: false,
        },
      ];

      const review = reviewDataMinimization(operationalFields, restrictivePolicy, baseTimestamp);
      expect(review.recommendations).toHaveLength(3); // 1 delete (sessionToken), 1 expire (operatorEmail), 1 anonymize (operatorEmail)
      expect(review.recommendations.some((r) => r.field === "sessionToken" && r.action === "delete")).toBe(true);
      expect(review.recommendations.some((r) => r.field === "operatorEmail" && r.action === "expire")).toBe(true);
    });
  });
});
