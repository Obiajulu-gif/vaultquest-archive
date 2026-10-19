import { describe, it, expect } from "vitest";
import {
  SupportEvidenceBundleService,
  pseudonymizeAddress,
  sanitizePayloadRecursive,
  type InvestigationScope,
  type RawEvidenceRecord,
} from "../src/services/supportEvidenceBundleService.js";

describe("SupportEvidenceBundleService (#921)", () => {
  const service = new SupportEvidenceBundleService();

  const mockScope: InvestigationScope = {
    ticketId: "SUP-9876",
    investigator: "maintainer:GBBD3A7FQ6HZN2XR5DBLD3YIYS3L2ORWVUYVY4QBEAC3IKWMUOCFLA5",
    reason: "Investigating customer deposit reconciliation timeout after Soroban RPC blip",
    timeRange: {
      since: "2026-10-15T00:00:00Z",
      until: "2026-10-16T00:00:00Z",
    },
    vaultId: "vault-usdc-01",
    actionType: "deposit",
    pseudonymizeWallets: true,
  };

  const sampleRecords: RawEvidenceRecord[] = [
    {
      id: "act-101",
      sourceTable: "action_ledger",
      walletAddress: "GDJQO7NVMVF6ZQDYCSVNFAKJY3RULZ5XDTL4BH7C7AO5GJ4I2OMLD3Z",
      actionType: "deposit",
      status: "confirmed",
      finalityStatus: "finalized",
      txHash: "0x3a9f7e8b2c4d6a1e0f8c7b6a5d4e3f2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e",
      sorobanEventId: "0000000100-0000000001",
      observedLedger: 125430,
      finalizedLedger: 125435,
      confirmationDepth: 5,
      createdAt: "2026-10-15T12:00:00Z",
      submittedAt: "2026-10-15T12:00:02Z",
      confirmedAt: "2026-10-15T12:00:15Z",
      errorCode: null,
      errorDetail: null,
      actionPayload: {
        vault_id: "vault-usdc-01",
        amount: "5000000000",
        token: "USDC",
        private_key: "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        auth_token: "bearer-secret-token-12345",
        user_email: "alice@example.com",
        client_ip: "192.168.1.100",
      },
      verifiedPayload: {
        pool_id: "vault-usdc-01",
        amount: "5000000000",
        depositor: "GDJQO7NVMVF6ZQDYCSVNFAKJY3RULZ5XDTL4BH7C7AO5GJ4I2OMLD3Z",
      },
    },
    {
      id: "act-102",
      sourceTable: "action_ledger",
      walletAddress: "GDJQO7NVMVF6ZQDYCSVNFAKJY3RULZ5XDTL4BH7C7AO5GJ4I2OMLD3Z",
      actionType: "claim",
      status: "failed",
      finalityStatus: "provisional",
      txHash: null,
      createdAt: "2026-10-15T14:30:00Z",
      submittedAt: "2026-10-15T14:30:05Z",
      errorCode: "LOCKUP_ACTIVE",
      errorDetail: "Lockup is active until ledger 126000 for IP 10.0.0.42",
      actionPayload: {
        vault_id: "vault-usdc-01",
        amount: "100000000",
        password: "super-secret-user-pass",
      },
    },
  ];

  describe("Normal Path: Evidence Generation & Redaction", () => {
    it("generates a complete evidence bundle with redacted secrets and PII", () => {
      const bundle = service.generateBundle(mockScope, sampleRecords, {
        now: new Date("2026-10-16T12:00:00Z"),
        bundleSalt: "test-bundle-salt-921",
      });

      expect(bundle.bundleId).toBeDefined();
      expect(bundle.schemaVersion).toBe("1.0.0");
      expect(bundle.itemCount).toBe(2);
      expect(bundle.bundleChecksum).toBeDefined();

      const item1 = bundle.items.find((i) => i.recordId === "act-101")!;
      expect(item1).toBeDefined();

      // Secrets must be redacted
      expect(item1.redactedPayload["private_key"]).toBe("[REDACTED_SECRET]");
      expect(item1.redactedPayload["auth_token"]).toBe("[REDACTED_SECRET]");
      expect(item1.redactedPayload["user_email"]).toBe("[REDACTED_PII]");
      expect(item1.redactedPayload["client_ip"]).toBe("[MASKED_IP]");

      // Behavioral facts must be preserved
      expect(item1.actionType).toBe("deposit");
      expect(item1.status).toBe("confirmed");
      expect(item1.finalityStatus).toBe("finalized");
      expect(item1.txHash).toBe("0x3a9f7e8b2c4d6a1e0f8c7b6a5d4e3f2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e");
      expect(item1.sorobanEventId).toBe("0000000100-0000000001");
      expect(item1.ledger.observedLedger).toBe(125430);
      expect(item1.ledger.finalizedLedger).toBe(125435);
      expect(item1.ledger.confirmationDepth).toBe(5);
      expect(item1.financialFacts?.amount).toBe("5000000000");
      expect(item1.financialFacts?.asset).toBe("USDC");
      expect(item1.financialFacts?.verifiedPayloadHash).toBeDefined();

      // Pseudonymization check: same wallet produces identical pseudonym across items
      const item2 = bundle.items.find((i) => i.recordId === "act-102")!;
      expect(item1.actorPseudonym).toBe(item2.actorPseudonym);
      expect(item1.actorPseudonym).toMatch(/^anon_wallet_[a-f0-9]{16}$/);

      // Error details must have IPs masked
      expect(item2.errorDetailRedacted).toContain("[MASKED_IP]");
      expect(item2.errorDetailRedacted).not.toContain("10.0.0.42");
    });

    it("verifies cryptographic integrity of an untampered bundle", () => {
      const bundle = service.generateBundle(mockScope, sampleRecords);
      const verification = service.verifyBundle(bundle);

      expect(verification.valid).toBe(true);
      expect(verification.errors).toHaveLength(0);
    });

    it("supports export to JSON and NDJSON formats", () => {
      const bundle = service.generateBundle(mockScope, sampleRecords);

      const jsonStr = service.exportBundle(bundle, "json");
      expect(jsonStr).toContain(`"bundleId": "${bundle.bundleId}"`);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.items).toHaveLength(2);

      const ndjsonStr = service.exportBundle(bundle, "ndjson");
      const lines = ndjsonStr.trim().split("\n");
      expect(lines).toHaveLength(3); // 1 header + 2 items
      expect(JSON.parse(lines[0]).type).toBe("header");
      expect(JSON.parse(lines[1]).type).toBe("item");
    });
  });

  describe("Failure Path: Tampering & Invalid Inputs", () => {
    it("detects when an evidence item payload has been tampered with", () => {
      const bundle = service.generateBundle(mockScope, sampleRecords);

      // Modify an item's status
      bundle.items[0].status = "failed";

      const verification = service.verifyBundle(bundle);
      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes("TAMPERED_ITEM"))).toBe(true);
      expect(verification.errors.some((e) => e.includes("TAMPERED_BUNDLE_CHECKSUM"))).toBe(true);
    });

    it("detects when an item is deleted from the bundle", () => {
      const bundle = service.generateBundle(mockScope, sampleRecords);

      bundle.items.pop(); // Remove second item

      const verification = service.verifyBundle(bundle);
      expect(verification.valid).toBe(false);
      expect(verification.errors.some((e) => e.includes("TAMPERED_BUNDLE_CHECKSUM"))).toBe(true);
    });

    it("rejects invalid investigation scopes (missing ticketId or short reason)", () => {
      expect(() => {
        service.generateBundle({ ...mockScope, ticketId: "" }, sampleRecords);
      }).toThrow(/ticketId is required/i);

      expect(() => {
        service.generateBundle({ ...mockScope, reason: "Too short" }, sampleRecords);
      }).toThrow(/reason must be at least 10 characters/i);
    });
  });

  describe("Retry & Determinism Path", () => {
    it("produces identical deterministic evidence hashes when regenerated with same salt", () => {
      const salt = "fixed-deterministic-salt-123";
      const b1 = service.generateBundle(mockScope, sampleRecords, {
        now: new Date("2026-10-16T12:00:00Z"),
        bundleSalt: salt,
      });
      const b2 = service.generateBundle(mockScope, sampleRecords, {
        now: new Date("2026-10-16T12:00:00Z"),
        bundleSalt: salt,
      });

      expect(b1.items[0].itemHash).toBe(b2.items[0].itemHash);
      expect(b1.items[1].itemHash).toBe(b2.items[1].itemHash);
      expect(b1.bundleChecksum).toBe(b2.bundleChecksum);
    });
  });

  describe("Authorization & Pseudonymization Path", () => {
    it("respects pseudonymizeWallets=false when maintainer has explicit full unredacted permission", () => {
      const scopeNoPseudo: InvestigationScope = {
        ...mockScope,
        pseudonymizeWallets: false,
      };

      const bundle = service.generateBundle(scopeNoPseudo, sampleRecords);
      const item = bundle.items.find((i) => i.recordId === "act-101")!;

      expect(item.actorPseudonym).toBe("GDJQO7NVMVF6ZQDYCSVNFAKJY3RULZ5XDTL4BH7C7AO5GJ4I2OMLD3Z");
      expect(bundle.redactionManifest.pseudonymizedFields).toHaveLength(0);
    });
  });
});
