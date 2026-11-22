import { describe, it, expect, beforeEach } from "vitest";

/**
 * Metadata Minimization & Classification Tests
 *
 * Tests for operational metadata review, field classification, retention enforcement,
 * and deterministic deletion of unnecessary fields.
 */

export enum MetadataFieldClass {
  CRITICAL = "critical",
  OPERATIONAL = "operational",
  EPHEMERAL = "ephemeral",
  UNNECESSARY = "unnecessary",
}

export interface MetadataFieldSpec {
  fieldPath: string;
  classification: MetadataFieldClass;
  reason: string;
  retentionDays?: number;
  redactable?: boolean;
  excludeAtIngestion?: boolean;
}

export const ACTION_PAYLOAD_FIELD_SPECS: Record<string, MetadataFieldSpec> = {
  "actionPayload.poolId": {
    fieldPath: "actionPayload.poolId",
    classification: MetadataFieldClass.CRITICAL,
    reason: "identifies the prize pool affected; required for dispute resolution and audit",
  },
  "actionPayload.amount": {
    fieldPath: "actionPayload.amount",
    classification: MetadataFieldClass.CRITICAL,
    reason: "transaction amount; required for financial audit and reconciliation",
  },
  "actionPayload.recipient": {
    fieldPath: "actionPayload.recipient",
    classification: MetadataFieldClass.CRITICAL,
    reason: "payout recipient; required for settlement verification and dispute resolution",
  },
  "actionPayload.nonce": {
    fieldPath: "actionPayload.nonce",
    classification: MetadataFieldClass.OPERATIONAL,
    reason: "prevents replay attacks; operational for 90 days, then can be pruned",
    retentionDays: 90,
    excludeAtIngestion: false,
  },
  "actionPayload.memo": {
    fieldPath: "actionPayload.memo",
    classification: MetadataFieldClass.OPERATIONAL,
    reason: "user-provided note; operational for disputes/support, then pruned",
    retentionDays: 180,
    redactable: true,
  },
  "actionPayload.userAgent": {
    fieldPath: "actionPayload.userAgent",
    classification: MetadataFieldClass.UNNECESSARY,
    reason: "debugging only; not needed for operation or audit; remove at ingestion",
    excludeAtIngestion: true,
  },
  "actionPayload.ipAddress": {
    fieldPath: "actionPayload.ipAddress",
    classification: MetadataFieldClass.UNNECESSARY,
    reason: "PII; not needed; remove at ingestion to avoid privacy exposure",
    excludeAtIngestion: true,
  },
  "actionPayload.debugTrace": {
    fieldPath: "actionPayload.debugTrace",
    classification: MetadataFieldClass.UNNECESSARY,
    reason: "diagnostic info from client; not for storage; exclude at ingestion",
    excludeAtIngestion: true,
  },
};

export const VERIFIED_PAYLOAD_FIELD_SPECS: Record<string, MetadataFieldSpec> = {
  "verifiedPayload.amount": {
    fieldPath: "verifiedPayload.amount",
    classification: MetadataFieldClass.CRITICAL,
    reason: "on-chain settlement amount; immutable proof of payout",
  },
  "verifiedPayload.recipient": {
    fieldPath: "verifiedPayload.recipient",
    classification: MetadataFieldClass.CRITICAL,
    reason: "on-chain recipient; immutable proof of destination",
  },
  "verifiedPayload.txHash": {
    fieldPath: "verifiedPayload.txHash",
    classification: MetadataFieldClass.CRITICAL,
    reason: "transaction hash; links to on-chain proof",
  },
};

export class MetadataMinimizationService {
  classifyMetadata(
    metadata: Record<string, unknown>,
    specs: Record<string, MetadataFieldSpec>
  ): Map<string, MetadataFieldSpec> {
    const classified = new Map<string, MetadataFieldSpec>();
    for (const [fieldPath, spec] of Object.entries(specs)) {
      classified.set(fieldPath, spec);
    }
    return classified;
  }

  minimizeAtIngestion(
    rawMetadata: Record<string, unknown>,
    specs: Record<string, MetadataFieldSpec>
  ): Record<string, unknown> {
    const minimized = { ...rawMetadata };
    for (const [fieldPath, spec] of Object.entries(specs)) {
      if (spec.excludeAtIngestion) {
        const parts = fieldPath.split(".");
        if (parts.length === 1) {
          delete minimized[parts[0]];
        } else if (parts.length === 2 && typeof minimized[parts[0]] === "object") {
          delete (minimized[parts[0]] as Record<string, unknown>)[parts[1]];
        }
      }
    }
    return minimized;
  }

  enforceRetentionWindow(
    metadata: Record<string, unknown>,
    specs: Record<string, MetadataFieldSpec>,
    createdAt: Date,
    now: Date = new Date()
  ): { metadata: Record<string, unknown>; redacted: string[]; deleted: string[] } {
    const result = { ...metadata };
    const redacted: string[] = [];
    const deleted: string[] = [];

    for (const [fieldPath, spec] of Object.entries(specs)) {
      if (!spec.retentionDays) continue;

      const ageMs = now.getTime() - createdAt.getTime();
      const ageD = ageMs / (24 * 60 * 60 * 1000);

      if (ageD > spec.retentionDays) {
        const parts = fieldPath.split(".");
        if (spec.redactable) {
          if (parts.length === 2 && typeof result[parts[0]] === "object") {
            (result[parts[0]] as Record<string, unknown>)[parts[1]] = "[REDACTED]";
            redacted.push(fieldPath);
          }
        } else {
          if (parts.length === 1) {
            delete result[parts[0]];
            deleted.push(fieldPath);
          } else if (parts.length === 2 && typeof result[parts[0]] === "object") {
            delete (result[parts[0]] as Record<string, unknown>)[parts[1]];
            deleted.push(fieldPath);
          }
        }
      }
    }

    return { metadata: result, redacted, deleted };
  }

  identifyUnnecessaryFields(specs: Record<string, MetadataFieldSpec>): string[] {
    return Object.entries(specs)
      .filter(([, spec]) => spec.classification === MetadataFieldClass.UNNECESSARY)
      .map(([fieldPath]) => fieldPath);
  }

  identifyCriticalFields(specs: Record<string, MetadataFieldSpec>): string[] {
    return Object.entries(specs)
      .filter(([, spec]) => spec.classification === MetadataFieldClass.CRITICAL)
      .map(([fieldPath]) => fieldPath);
  }

  checkRetentionCompliance(
    metadata: Record<string, unknown>,
    specs: Record<string, MetadataFieldSpec>,
    createdAt: Date,
    now: Date = new Date()
  ): { compliant: boolean; violations: string[] } {
    const violations: string[] = [];

    for (const [fieldPath, spec] of Object.entries(specs)) {
      if (!spec.retentionDays) continue;
      if (spec.classification === MetadataFieldClass.CRITICAL) continue;

      const ageMs = now.getTime() - createdAt.getTime();
      const ageD = ageMs / (24 * 60 * 60 * 1000);

      if (ageD > spec.retentionDays) {
        const parts = fieldPath.split(".");
        let found = false;
        if (parts.length === 1) {
          found = fieldPath in metadata;
        } else if (parts.length === 2 && typeof metadata[parts[0]] === "object") {
          found = parts[1] in (metadata[parts[0]] as Record<string, unknown>);
        }

        if (found) {
          violations.push(`${fieldPath}: exceeds retention window of ${spec.retentionDays} days`);
        }
      }
    }

    return { compliant: violations.length === 0, violations };
  }
}

// ============================================================================
// TESTS
// ============================================================================

describe("METADATA CLASSIFICATION", () => {
  let service: MetadataMinimizationService;

  beforeEach(() => {
    service = new MetadataMinimizationService();
  });

  describe("action payload classification", () => {
    it("classifies critical fields", () => {
      const critical = Object.entries(ACTION_PAYLOAD_FIELD_SPECS)
        .filter(([, spec]) => spec.classification === MetadataFieldClass.CRITICAL)
        .map(([path]) => path);

      expect(critical).toContain("actionPayload.poolId");
      expect(critical).toContain("actionPayload.amount");
      expect(critical).toContain("actionPayload.recipient");
    });

    it("identifies unnecessary fields at ingestion", () => {
      const unnecessary = service.identifyUnnecessaryFields(ACTION_PAYLOAD_FIELD_SPECS);

      expect(unnecessary).toContain("actionPayload.userAgent");
      expect(unnecessary).toContain("actionPayload.ipAddress");
      expect(unnecessary).toContain("actionPayload.debugTrace");
    });
  });

  describe("verified payload classification", () => {
    it("never marks verifiedPayload fields as unnecessary", () => {
      const unnecessary = service.identifyUnnecessaryFields(VERIFIED_PAYLOAD_FIELD_SPECS);
      expect(unnecessary).toHaveLength(0);
    });
  });
});

describe("METADATA MINIMIZATION AT INGESTION", () => {
  let service: MetadataMinimizationService;

  beforeEach(() => {
    service = new MetadataMinimizationService();
  });

  it("removes unnecessary fields at ingestion time", () => {
    const rawPayload = {
      poolId: "pool-123",
      amount: "1000",
      recipient: "wallet-abc",
      userAgent: "Mozilla/5.0",
      ipAddress: "192.0.2.1",
      debugTrace: "{ frames: [...] }",
    };

    const minimized = service.minimizeAtIngestion(rawPayload, ACTION_PAYLOAD_FIELD_SPECS);

    expect(minimized.poolId).toBe("pool-123");
    expect(minimized.amount).toBe("1000");
    expect(minimized.recipient).toBe("wallet-abc");
    expect(minimized.userAgent).toBeUndefined();
    expect(minimized.ipAddress).toBeUndefined();
    expect(minimized.debugTrace).toBeUndefined();
  });

  it("preserves critical and operational fields", () => {
    const rawPayload = {
      poolId: "pool-456",
      amount: "5000",
      recipient: "wallet-xyz",
      nonce: "abc123",
      memo: "prize claim",
    };

    const minimized = service.minimizeAtIngestion(rawPayload, ACTION_PAYLOAD_FIELD_SPECS);

    expect(minimized.poolId).toBe("pool-456");
    expect(minimized.nonce).toBe("abc123");
    expect(minimized.memo).toBe("prize claim");
  });
});

describe("RETENTION WINDOW ENFORCEMENT", () => {
  let service: MetadataMinimizationService;
  let now: Date;
  let createdAt: Date;

  beforeEach(() => {
    service = new MetadataMinimizationService();
    now = new Date("2026-10-17T00:00:00Z");
    createdAt = new Date("2026-10-17T00:00:00Z");
  });

  it("does not modify fields within retention window", () => {
    const metadata = {
      actionPayload: {
        poolId: "pool-1",
        nonce: "nonce-xyz",
        memo: "user note",
      },
    };

    const result = service.enforceRetentionWindow(
      metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );

    expect(result.redacted).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it("redacts operational fields past retention window when redactable=true", () => {
    const metadata = {
      actionPayload: {
        memo: "old note",
      },
    };

    const oldCreatedAt = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);

    const result = service.enforceRetentionWindow(
      metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      oldCreatedAt,
      now
    );

    expect((result.metadata.actionPayload as Record<string, unknown>).memo).toBe("[REDACTED]");
    expect(result.redacted).toContain("actionPayload.memo");
  });

  it("never removes critical fields, even if very old", () => {
    const metadata = {
      actionPayload: {
        poolId: "pool-ancient",
        amount: "999",
        recipient: "wallet-old",
      },
    };

    const veryOldCreatedAt = new Date(now.getTime() - 3650 * 24 * 60 * 60 * 1000);

    const result = service.enforceRetentionWindow(
      metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      veryOldCreatedAt,
      now
    );

    expect((result.metadata.actionPayload as Record<string, unknown>).poolId).toBe("pool-ancient");
    expect((result.metadata.actionPayload as Record<string, unknown>).amount).toBe("999");
    expect(result.deleted).toHaveLength(0);
  });
});

describe("RETENTION COMPLIANCE CHECKING", () => {
  let service: MetadataMinimizationService;
  let now: Date;

  beforeEach(() => {
    service = new MetadataMinimizationService();
    now = new Date("2026-10-17T00:00:00Z");
  });

  it("returns compliant when all fields are within retention windows", () => {
    const metadata = {
      actionPayload: {
        nonce: "fresh-nonce",
      },
    };

    const createdAt = now;
    const result = service.checkRetentionCompliance(
      metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );

    expect(result.compliant).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("detects expired operational fields", () => {
    const metadata = {
      actionPayload: {
        nonce: "very-old-nonce",
      },
    };

    const createdAt = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

    const result = service.checkRetentionCompliance(
      metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );

    expect(result.compliant).toBe(false);
  });

  it("ignores critical fields in compliance check", () => {
    const metadata = {
      actionPayload: {
        poolId: "pool-ancient",
        amount: "123",
        recipient: "wallet-old",
      },
    };

    const createdAt = new Date(now.getTime() - 3650 * 24 * 60 * 60 * 1000);

    const result = service.checkRetentionCompliance(
      metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );

    expect(result.compliant).toBe(true);
  });
});

describe("OPERATIONAL EDGE CASES", () => {
  let service: MetadataMinimizationService;

  beforeEach(() => {
    service = new MetadataMinimizationService();
  });

  it("handles missing metadata gracefully", () => {
    const empty = {};
    const result = service.enforceRetentionWindow(empty, ACTION_PAYLOAD_FIELD_SPECS, new Date());
    expect(result.metadata).toEqual({});
    expect(result.deleted).toHaveLength(0);
  });

  it("redaction is idempotent", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const createdAt = new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000);

    const metadata = { actionPayload: { memo: "user note" } };

    const result1 = service.enforceRetentionWindow(
      metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );
    const result2 = service.enforceRetentionWindow(
      result1.metadata,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );

    expect(result1.metadata).toEqual(result2.metadata);
  });

  it("deletion is deterministic", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const createdAt = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

    const metadata1 = { actionPayload: { nonce: "old1" } };
    const metadata2 = { actionPayload: { nonce: "old2" } };

    const result1 = service.enforceRetentionWindow(
      metadata1,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );
    const result2 = service.enforceRetentionWindow(
      metadata2,
      ACTION_PAYLOAD_FIELD_SPECS,
      createdAt,
      now
    );

    expect(result1.deleted).toEqual(result2.deleted);
  });
});
