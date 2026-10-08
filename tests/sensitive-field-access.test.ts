import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SensitiveFieldAccessLogger,
  SENSITIVE_FIELDS,
  sensitiveAccessLogger,
  type AnomalyEvent,
} from "../lib/sensitive-field-access";

describe("SensitiveFieldAccessLogger (#868)", () => {
  let logger: SensitiveFieldAccessLogger;

  beforeEach(() => {
    logger = new SensitiveFieldAccessLogger({
      maxDeniedAttemptsInWindow: 2,
      maxRapidResourcesInWindow: 3,
      bulkFieldThreshold: 4,
      windowMs: 60000,
    });
  });

  it("identifies sensitive field names", () => {
    expect(logger.isSensitiveField("ssn")).toBe(true);
    expect(logger.isSensitiveField("wallet_seed")).toBe(true);
    expect(logger.isSensitiveField("user_secret_token")).toBe(true);
    expect(logger.isSensitiveField("public_name")).toBe(false);
  });

  it("logs authorized access without storing sensitive field values (redaction)", () => {
    const entry = logger.logAccess({
      actor: "admin-001",
      purpose: "vault_audit",
      resourceType: "vault",
      resourceId: "vault-123",
      fieldNames: ["secret", "email"],
      authorized: true,
      rawValues: { secret: "SUPER_SECRET_KEY_123", email: "user@example.com" },
    });

    expect(entry.id).toBeDefined();
    expect(entry.actor).toBe("admin-001");
    expect(entry.purpose).toBe("vault_audit");
    expect(entry.resourceType).toBe("vault");
    expect(entry.resourceId).toBe("vault-123");
    expect(entry.fields).toEqual(["secret", "email"]);
    expect(entry.authorized).toBe(true);
    expect(entry.redacted).toBe(true);
    // Ensure raw values were NOT retained in the entry
    expect((entry as Record<string, unknown>).rawValues).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("SUPER_SECRET_KEY_123");
  });

  it("safely captures unauthorized access attempts", () => {
    const entry = logger.logAccess({
      actor: "untrusted-user",
      purpose: "unauthorized_export",
      resourceType: "user_profile",
      resourceId: "user-456",
      fieldNames: ["ssn", "tax_id"],
      authorized: false,
      ipAddress: "192.168.1.50",
    });

    expect(entry.authorized).toBe(false);
    expect(entry.actor).toBe("untrusted-user");
    expect(entry.ipAddress).toBe("192.168.1.50");

    const logs = logger.queryLogs({ authorized: false });
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe(entry.id);
  });

  it("identifies bulk access queries", () => {
    const bulkEntry = logger.logAccess({
      actor: "auditor-01",
      purpose: "compliance_check",
      resourceType: "account",
      resourceId: "acc-999",
      fieldNames: ["ssn", "tax_id", "private_key", "secret", "vault_pin"],
      authorized: true,
    });

    expect(bulkEntry.bulk).toBe(true);
    expect(bulkEntry.fields).toHaveLength(5);
  });

  it("triggers anomaly hooks on unauthorized bulk access and threshold breaches", () => {
    const anomalyCallback = vi.fn();
    logger.onAnomaly(anomalyCallback);

    // 1. Unauthorized bulk access triggers immediate anomaly hook
    logger.logAccess({
      actor: "attacker-x",
      purpose: "dump",
      resourceType: "vault",
      resourceId: "vault-777",
      fieldNames: ["private_key", "wallet_seed", "secret", "vault_pin"],
      authorized: false,
    });

    expect(anomalyCallback).toHaveBeenCalled();
    const anomalyArg: AnomalyEvent = anomalyCallback.mock.calls[0][0];
    expect(anomalyArg.rule).toBe("UNAUTHORIZED_BULK_ACCESS");
    expect(anomalyArg.severity).toBe("critical");
    expect(anomalyArg.actor).toBe("attacker-x");
  });

  it("evaluates windowed access patterns for burst denied access anomalies", () => {
    const anomalyCallback = vi.fn();
    logger.onAnomaly(anomalyCallback);

    logger.logAccess({
      actor: "suspicious-actor",
      purpose: "probe-1",
      resourceType: "vault",
      resourceId: "v1",
      fieldNames: ["ssn"],
      authorized: false,
    });

    logger.logAccess({
      actor: "suspicious-actor",
      purpose: "probe-2",
      resourceType: "vault",
      resourceId: "v2",
      fieldNames: ["ssn"],
      authorized: false,
    });

    const anomalies = logger.evaluateAnomalies();
    expect(anomalies.some((a) => a.rule === "UNAUTHORIZED_BURST")).toBe(true);
  });

  it("verifies global instance sensitiveAccessLogger exists", () => {
    expect(sensitiveAccessLogger).toBeInstanceOf(SensitiveFieldAccessLogger);
  });
});

describe("Access log integrity and anomaly boundaries", () => {
  afterEach(() => vi.restoreAllMocks());
  const input = { actor: "actor", purpose: "audit", resourceType: "account", resourceId: "1", fieldNames: ["email"], authorized: true };

  it("isolates returned logs, queries and sink entries from the retained audit history", () => {
    const sink = vi.fn((entry) => { entry.actor = "mutated-sink"; });
    const logger = new SensitiveFieldAccessLogger(undefined, sink);
    const log = logger.logAccess({ ...input, rawValues: { email: "SECRET_EMAIL" } });
    log.fields.push("SECRET_EMAIL");
    logger.queryLogs()[0].actor = "forged";
    expect(logger.queryLogs()[0].actor).toBe("actor");
    expect(JSON.stringify(logger.queryLogs())).not.toContain("SECRET_EMAIL");
    expect(JSON.stringify(sink.mock.calls)).not.toContain("SECRET_EMAIL");
  });

  it("normalizes camel-case fields and excludes duplicates and public fields from bulk counts", () => {
    const logger = new SensitiveFieldAccessLogger({ bulkFieldThreshold: 2 });
    const log = logger.logAccess({ ...input, fieldNames: ["walletAddress", "wallet_address", "public_name"] });
    expect(log.fields).toEqual(["wallet_address"]);
    expect(log.bulk).toBe(false);
    expect(logger.isSensitiveField("passwordHash")).toBe(true);
    expect(logger.logAccess({ ...input, resourceCount: 3 }).bulk).toBe(true);
  });

  it("bounds retained logs and rejects unsafe threshold configuration", () => {
    const logger = new SensitiveFieldAccessLogger({ maxRetainedLogs: 2 });
    for (const resourceId of ["1", "2", "3"]) logger.logAccess({ ...input, resourceId });
    expect(logger.queryLogs().map((l) => l.resourceId)).toEqual(["2", "3"]);
    expect(() => new SensitiveFieldAccessLogger({ windowMs: -1 })).toThrow();
    expect(() => logger.logAccess({ ...input, resourceCount: 0 })).toThrow();
  });

  it("distinguishes resource types and excludes expired events", () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-08T12:00:00Z").getTime());
    const logger = new SensitiveFieldAccessLogger({ maxRapidResourcesInWindow: 2 });
    logger.logAccess({ ...input, resourceType: "account" });
    logger.logAccess({ ...input, resourceType: "vault" });
    // Use entry timestamps as the reference, independent of wall-clock test runtime.
    const time = new Date(logger.queryLogs()[0].timestamp).getTime();
    vi.mocked(Date.now).mockReturnValue(time);
    expect(logger.evaluateAnomalies().some((a) => a.rule === "RAPID_MULTI_RESOURCE_ACCESS")).toBe(true);
    vi.mocked(Date.now).mockReturnValue(time + 600_000);
    expect(logger.evaluateAnomalies()).toEqual([]);
  });

  it("redacts hook errors and isolates each subscriber", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = new SensitiveFieldAccessLogger({ bulkFieldThreshold: 1 });
    const receiver = vi.fn();
    logger.onAnomaly((event) => { event.actor = "tampered"; throw new Error("SECRET_ERROR_VALUE"); });
    const unsubscribe = logger.onAnomaly(receiver);
    logger.logAccess({ ...input, authorized: false });
    expect(receiver.mock.calls[0][0].actor).toBe("actor");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET_ERROR_VALUE");
    unsubscribe();
    logger.logAccess({ ...input, authorized: false });
    expect(receiver).toHaveBeenCalledTimes(1);
  });
});
