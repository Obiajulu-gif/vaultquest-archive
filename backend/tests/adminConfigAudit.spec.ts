import { describe, it, expect, beforeEach } from "vitest";
import {
  AdminConfigAuditService,
  InMemoryAdminConfigAuditStore,
  ADMIN_CONFIG_GENESIS_HASH,
  computeAdminConfigRecordHash,
  computeMerkleRoot,
  type AdminConfigActor,
} from "../src/services/adminConfigAuditService.js";
import { AppError } from "../src/errors.js";

describe("Admin Configuration Audit Evidence Service (#991)", () => {
  let store: InMemoryAdminConfigAuditStore;
  let service: AdminConfigAuditService;
  let fixedNow: Date;

  const maintainerActor: AdminConfigActor = {
    subject: "GADMIN_STELLAR_WALLET_ADDRESS_TEST_123456789",
    role: "maintainer",
  };

  const adminActor: AdminConfigActor = {
    subject: "GGOVERNANCE_MULTISIG_CONTRACT_OR_ADMIN",
    role: "admin",
  };

  const unauthorizedActor: AdminConfigActor = {
    subject: "GUSER_UNPRIVILEGED_WALLET_ADDRESS_TEST",
    role: "user",
  };

  beforeEach(() => {
    store = new InMemoryAdminConfigAuditStore();
    fixedNow = new Date("2026-10-16T12:00:00.000Z");
    service = new AdminConfigAuditService(store, {
      now: () => fixedNow,
    });
  });

  describe("Normal Path: Parameter Changes & Cryptographic Hash Chaining", () => {
    it("records a valid parameter change with simulated delta and links to genesis hash", async () => {
      const record = await service.recordConfigChange({
        parameterId: "roundCadenceDays",
        proposedValue: 14,
        actor: maintainerActor,
        rationale: "Lengthening round duration for bi-weekly operational cycle",
        proposalId: "prop-2026-101",
        txHash: "4f8a9b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a",
        ledgerSequence: 5218900,
      });

      expect(record.sequence).toBe(1);
      expect(record.parameterId).toBe("roundCadenceDays");
      expect(record.previousValue).toBe(7);
      expect(record.newValue).toBe(14);
      expect(record.delta).toBe(7);
      expect(record.relativeChange).toBe(1.0);
      expect(record.riskLevel).toBe("high"); // 100% relative jump is high risk
      expect(record.prevRecordHash).toBe(ADMIN_CONFIG_GENESIS_HASH);
      expect(record.overridden).toBe(false);

      // Verify self-integrity
      const { recordHash, ...withoutHash } = record;
      expect(recordHash).toBe(computeAdminConfigRecordHash(withoutHash));
    });

    it("chains subsequent configuration changes cryptographically", async () => {
      const rec1 = await service.recordConfigChange({
        parameterId: "roundCadenceDays",
        proposedValue: 14,
        actor: maintainerActor,
        rationale: "Step 1: Update cadence",
      });

      const rec2 = await service.recordConfigChange({
        parameterId: "settlementQuorumOfFive",
        proposedValue: 4,
        actor: adminActor,
        rationale: "Step 2: Increase settlement quorum requirement",
      });

      expect(rec2.sequence).toBe(2);
      expect(rec2.prevRecordHash).toBe(rec1.recordHash);
      expect(rec2.previousValue).toBe(3);
      expect(rec2.newValue).toBe(4);

      const chainCheck = await service.verifyEvidenceChain();
      expect(chainCheck.ok).toBe(true);
      expect(chainCheck.checked).toBe(2);
      expect(chainCheck.problems).toHaveLength(0);
    });
  });

  describe("Stringency Validation & Override Path", () => {
    it("blocks parameter proposals violating hard protocol stringencies without override", async () => {
      // treasuryFeeBps hard floor is 0.5 bp
      await expect(
        service.recordConfigChange({
          parameterId: "treasuryFeeBps",
          proposedValue: 0.1,
          actor: maintainerActor,
          rationale: "Attempting to lower treasury fee below hard floor",
        })
      ).rejects.toThrow(/Treasury fee may not go below/i);
    });

    it("allows maintainer to record change past blocked stringency when explicitly overridden", async () => {
      const record = await service.recordConfigChange({
        parameterId: "treasuryFeeBps",
        proposedValue: 0.1,
        actor: maintainerActor,
        rationale: "Emergency test override sanctioned by governance committee",
        overrideBlocked: true,
      });

      expect(record.overridden).toBe(true);
      expect(record.newValue).toBe(0.1);
      expect(record.riskLevel).toBe("high");
    });
  });

  describe("Tamper & Failure Detection Path", () => {
    it("detects when a past record payload has been covertly altered (ALTERED)", async () => {
      await service.recordConfigChange({
        parameterId: "roundCadenceDays",
        proposedValue: 14,
        actor: maintainerActor,
        rationale: "Legitimate change 1",
      });

      await service.recordConfigChange({
        parameterId: "settlementQuorumOfFive",
        proposedValue: 4,
        actor: adminActor,
        rationale: "Legitimate change 2",
      });

      // Covertly tamper with stored row at sequence 1 without updating hash
      store.tamperForTest(1, (r) => {
        r.newValue = 999;
      });

      const check = await service.verifyEvidenceChain();
      expect(check.ok).toBe(false);
      expect(check.problems.some((p) => p.code === "ALTERED" && p.sequence === 1)).toBe(true);
    });

    it("detects when hash chain link is broken (BROKEN_LINK)", async () => {
      await service.recordConfigChange({
        parameterId: "roundCadenceDays",
        proposedValue: 14,
        actor: maintainerActor,
        rationale: "Legitimate change 1",
      });

      await service.recordConfigChange({
        parameterId: "settlementQuorumOfFive",
        proposedValue: 4,
        actor: adminActor,
        rationale: "Legitimate change 2",
      });

      // Covertly tamper with sequence 2's prevRecordHash
      store.tamperForTest(2, (r) => {
        r.prevRecordHash = "badhash" + "0".repeat(57);
      });

      const check = await service.verifyEvidenceChain();
      expect(check.ok).toBe(false);
      expect(check.problems.some((p) => p.code === "BROKEN_LINK" && p.sequence === 2)).toBe(true);
    });

    it("detects when a record has been deleted from the audit chain (SEQUENCE_GAP)", async () => {
      await service.recordConfigChange({
        parameterId: "roundCadenceDays",
        proposedValue: 14,
        actor: maintainerActor,
        rationale: "Change 1",
      });

      await service.recordConfigChange({
        parameterId: "settlementQuorumOfFive",
        proposedValue: 4,
        actor: adminActor,
        rationale: "Change 2",
      });

      await service.recordConfigChange({
        parameterId: "minDepositUnits",
        proposedValue: 50,
        actor: maintainerActor,
        rationale: "Change 3",
      });

      // Delete sequence 2
      store.deleteForTest(2);

      const check = await service.verifyEvidenceChain();
      expect(check.ok).toBe(false);
      expect(check.problems.some((p) => p.code === "SEQUENCE_GAP")).toBe(true);
    });
  });

  describe("Authorization & Mandatory Rationale Path", () => {
    it("rejects unauthorized user role attempts to record configuration changes", async () => {
      await expect(
        service.recordConfigChange({
          parameterId: "roundCadenceDays",
          proposedValue: 14,
          actor: unauthorizedActor,
          rationale: "Unauthorized user attempting to modify configuration",
        })
      ).rejects.toThrow("Only maintainers or administrators may record administrative configuration changes");
    });

    it("rejects changes submitted with missing or empty rationale", async () => {
      await expect(
        service.recordConfigChange({
          parameterId: "roundCadenceDays",
          proposedValue: 14,
          actor: maintainerActor,
          rationale: "   ",
        })
      ).rejects.toThrow("Rationale is mandatory for all administrative configuration changes");
    });
  });

  describe("Rollback & Reversal Path", () => {
    it("safely generates a verifiable rollback record restoring the previous parameter", async () => {
      const original = await service.recordConfigChange({
        parameterId: "roundCadenceDays",
        proposedValue: 21,
        actor: maintainerActor,
        rationale: "Testing 21 day cadence",
      });

      const rollback = await service.createRollbackEvidence(
        original.id,
        adminActor,
        "Cadence caused liquidity latency, reverting to original"
      );

      expect(rollback.sequence).toBe(2);
      expect(rollback.parameterId).toBe("roundCadenceDays");
      expect(rollback.previousValue).toBe(21);
      expect(rollback.newValue).toBe(7); // Restored original 7!
      expect(rollback.prevRecordHash).toBe(original.recordHash);
      expect(rollback.metadata?.rollbackOf).toBe(original.id);

      const check = await service.verifyEvidenceChain();
      expect(check.ok).toBe(true);
    });
  });

  describe("Exportable Evidence Path (JSON, NDJSON, CSV)", () => {
    beforeEach(async () => {
      await service.recordConfigChange({
        parameterId: "roundCadenceDays",
        proposedValue: 14,
        actor: maintainerActor,
        rationale: "Schedule optimization",
        txHash: "0xabc123",
        ledgerSequence: 5000000,
      });

      await service.recordConfigChange({
        parameterId: "settlementQuorumOfFive",
        proposedValue: 4,
        actor: adminActor,
        rationale: "Security hardening",
        txHash: "0xdef456",
        ledgerSequence: 5000100,
      });
    });

    it("exports evidence as a complete JSON bundle with Merkle root", async () => {
      const exportedJson = await service.exportEvidence({}, "json", "compliance_bot");
      const parsed = JSON.parse(exportedJson);

      expect(parsed.schema).toBe("vaultquest.admin-config-audit.v1");
      expect(parsed.totalRecords).toBe(2);
      expect(parsed.records).toHaveLength(2);
      expect(parsed.merkleRoot).toBeTruthy();
      expect(parsed.headRecordHash).toBe(parsed.records[1].recordHash);

      // Verify Merkle calculation
      const expectedMerkle = computeMerkleRoot([
        parsed.records[0].recordHash,
        parsed.records[1].recordHash,
      ]);
      expect(parsed.merkleRoot).toBe(expectedMerkle);
    });

    it("exports evidence as streaming NDJSON", async () => {
      const exportedNdjson = await service.exportEvidence({}, "ndjson", "data_pipeline");
      const lines = exportedNdjson.trim().split("\n");

      expect(lines).toHaveLength(3); // 1 header + 2 records
      const header = JSON.parse(lines[0]!);
      expect(header._meta).toBe("vaultquest.admin-config-audit.header.v1");
      expect(header.totalRecords).toBe(2);

      const r1 = JSON.parse(lines[1]!);
      expect(r1.parameterId).toBe("roundCadenceDays");
    });

    it("exports evidence as RFC 4180 compliant CSV", async () => {
      const exportedCsv = await service.exportEvidence({}, "csv");
      const rows = exportedCsv.trim().split("\n");

      expect(rows.length).toBe(3); // 1 header + 2 rows
      expect(rows[0]).toContain("sequence,id,occurred_at,category,parameter_id");
      expect(rows[1]).toContain("roundCadenceDays");
      expect(rows[2]).toContain("settlementQuorumOfFive");
    });
  });
});
