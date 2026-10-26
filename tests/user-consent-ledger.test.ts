import { describe, it, expect, beforeEach } from "vitest";
import { UserConsentLedger, defaultConsentLedger } from "../lib/user-consent-ledger";

describe("User Consent Ledger (#Issue)", () => {
  let ledger: UserConsentLedger;

  beforeEach(() => {
    ledger = new UserConsentLedger([
      {
        type: "terms_of_service",
        version: "1.0.0",
        title: "Terms of Service",
        required: true,
        effectiveDate: "2026-01-01T00:00:00Z",
      },
      {
        type: "privacy_policy",
        version: "1.0.0",
        title: "Privacy Policy",
        required: true,
        effectiveDate: "2026-01-01T00:00:00Z",
      },
      {
        type: "data_processing",
        version: "1.0.0",
        title: "Data Processing Agreement",
        required: true,
        effectiveDate: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  describe("First consent", () => {
    it("records first consent against immutable policy version with actor, timestamp, and source", () => {
      const record = ledger.recordConsent({
        userId: "user-stellar-101",
        policyType: "terms_of_service",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-stellar-101",
        source: "web_wallet_connect",
        metadata: { ipHash: "hash-123" },
      });

      expect(record.id).toMatch(/^consent-\d+/);
      expect(record.userId).toBe("user-stellar-101");
      expect(record.policyType).toBe("terms_of_service");
      expect(record.policyVersion).toBe("1.0.0");
      expect(record.status).toBe("granted");
      expect(record.actor).toBe("user-stellar-101");
      expect(record.source).toBe("web_wallet_connect");
      expect(record.timestamp).toBeDefined();
      expect(record.metadata?.ipHash).toBe("hash-123");

      expect(ledger.hasValidConsent("user-stellar-101", "terms_of_service")).toBe(true);
    });
  });

  describe("Renewed consent when policy version changes", () => {
    it("requires renewed consent and invalidates outdated version consent", () => {
      // User consents to v1.0.0
      ledger.recordConsent({
        userId: "user-stellar-202",
        policyType: "terms_of_service",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-stellar-202",
        source: "onboarding",
      });

      expect(ledger.hasValidConsent("user-stellar-202", "terms_of_service")).toBe(true);

      // Protocol bumps terms of service version to 2.0.0
      ledger.registerPolicy({
        type: "terms_of_service",
        version: "2.0.0",
        title: "Terms of Service Update",
        required: true,
        effectiveDate: "2026-06-01T00:00:00Z",
      });

      // User has not consented to 2.0.0 yet -> valid consent is now false
      expect(ledger.hasValidConsent("user-stellar-202", "terms_of_service")).toBe(false);

      // Gating reports missing consent for 2.0.0
      const gateCheck = ledger.gateFlow("user-stellar-202", ["terms_of_service"]);
      expect(gateCheck.allowed).toBe(false);
      expect(gateCheck.missingPolicies).toHaveLength(1);
      expect(gateCheck.missingPolicies[0].requiredVersion).toBe("2.0.0");
      expect(gateCheck.missingPolicies[0].currentConsentedVersion).toBe("1.0.0");

      // User grants renewed consent for 2.0.0
      ledger.recordConsent({
        userId: "user-stellar-202",
        policyType: "terms_of_service",
        policyVersion: "2.0.0",
        status: "granted",
        actor: "user-stellar-202",
        source: "renewal_modal",
      });

      expect(ledger.hasValidConsent("user-stellar-202", "terms_of_service")).toBe(true);
      expect(ledger.gateFlow("user-stellar-202", ["terms_of_service"]).allowed).toBe(true);
    });
  });

  describe("Revoked consent", () => {
    it("correctly records revoked consent and gates user from affected flows", () => {
      ledger.recordConsent({
        userId: "user-stellar-303",
        policyType: "data_processing",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-stellar-303",
        source: "settings",
      });

      expect(ledger.hasValidConsent("user-stellar-303", "data_processing")).toBe(true);

      // User revokes data processing consent
      ledger.recordConsent({
        userId: "user-stellar-303",
        policyType: "data_processing",
        policyVersion: "1.0.0",
        status: "revoked",
        actor: "user-stellar-303",
        source: "gdpr_opt_out",
      });

      expect(ledger.hasValidConsent("user-stellar-303", "data_processing")).toBe(false);

      const check = ledger.gateFlow("user-stellar-303", ["data_processing"]);
      expect(check.allowed).toBe(false);
      expect(check.missingPolicies[0].currentConsentStatus).toBe("revoked");
    });
  });

  describe("Missing consent and flow gating", () => {
    it("gates users missing required consents from affected flows (e.g. deposit, vault actions)", () => {
      // User with zero consents
      const check = ledger.gateFlow("user-newbie");
      expect(check.allowed).toBe(false);
      expect(check.missingPolicies.map((p) => p.type)).toEqual([
        "terms_of_service",
        "privacy_policy",
        "data_processing",
      ]);

      // Partial consent: consents to terms and privacy, but not data processing
      ledger.recordConsent({
        userId: "user-partial",
        policyType: "terms_of_service",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-partial",
        source: "connect",
      });
      ledger.recordConsent({
        userId: "user-partial",
        policyType: "privacy_policy",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-partial",
        source: "connect",
      });

      const partialCheck = ledger.gateFlow("user-partial");
      expect(partialCheck.allowed).toBe(false);
      expect(partialCheck.missingPolicies.map((p) => p.type)).toEqual(["data_processing"]);

      // Complete all required consents
      ledger.recordConsent({
        userId: "user-partial",
        policyType: "data_processing",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-partial",
        source: "connect",
      });

      expect(ledger.gateFlow("user-partial").allowed).toBe(true);
    });
  });

  describe("Safe consent history and authorization", () => {
    it("allows users to view their own consent history and prevents unauthorized users", () => {
      ledger.recordConsent({
        userId: "user-alice",
        policyType: "terms_of_service",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-alice",
        source: "onboarding",
      });
      ledger.recordConsent({
        userId: "user-bob",
        policyType: "terms_of_service",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-bob",
        source: "onboarding",
      });

      // Alice views her own history
      const aliceHistory = ledger.getConsentHistory(
        { userId: "user-alice" },
        { actorId: "user-alice", role: "user" }
      );
      expect(aliceHistory).toHaveLength(1);
      expect(aliceHistory[0].userId).toBe("user-alice");

      // Alice tries to view Bob's history -> rejected
      expect(() =>
        ledger.getConsentHistory(
          { userId: "user-bob" },
          { actorId: "user-alice", role: "user" }
        )
      ).toThrow("Unauthorized: users can only view their own consent history");

      // Maintainer or auditor can view any user's history
      const bobHistoryByMaintainer = ledger.getConsentHistory(
        { userId: "user-bob" },
        { actorId: "maintainer-charlie", role: "maintainer" }
      );
      expect(bobHistoryByMaintainer).toHaveLength(1);
      expect(bobHistoryByMaintainer[0].userId).toBe("user-bob");
    });

    it("allows maintainers/auditors to export the entire consent audit ledger", () => {
      ledger.recordConsent({
        userId: "user-1",
        policyType: "terms_of_service",
        policyVersion: "1.0.0",
        status: "granted",
        actor: "user-1",
        source: "web",
      });

      // Regular user cannot export ledger
      expect(() =>
        ledger.exportAuditLedger({ actorId: "user-1", role: "user" as any })
      ).toThrow("Unauthorized: only maintainers and auditors can export the consent ledger");

      // Auditor can export
      const auditRecords = ledger.exportAuditLedger({
        actorId: "auditor-007",
        role: "auditor",
      });
      expect(auditRecords).toHaveLength(1);
    });
  });

  describe("Default export", () => {
    it("exports defaultConsentLedger instance", () => {
      expect(defaultConsentLedger).toBeInstanceOf(UserConsentLedger);
      expect(defaultConsentLedger.getPolicy("terms_of_service")?.version).toBe("1.0.0");
    });
  });
});
