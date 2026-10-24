/**
 * Comprehensive intent approval tests for Issue #3.
 * 
 * Tests maintainer action approval flow with signed intent receipts,
 * audit trails, and post-completion review capabilities.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import { setupTestDatabase, teardownTestDatabase } from "../helpers/db.js";
import { IntentApprovalService } from "../../src/services/intentApproval.js";
import { ERROR_CODES } from "../../src/constants.js";
import { AppError } from "../../src/errors.js";

describe("Comprehensive Intent Approval Suite", () => {
  let prisma: PrismaClient;
  let intentService: IntentApprovalService;
  let requesterKeypair: ReturnType<typeof Keypair.random>;
  let maintainerKeypair: ReturnType<typeof Keypair.random>;

  beforeEach(async () => {
    const db = await setupTestDatabase();
    prisma = db.prisma;
    intentService = new IntentApprovalService(prisma);
    requesterKeypair = Keypair.random();
    maintainerKeypair = Keypair.random();
  });

  afterEach(async () => {
    await teardownTestDatabase(prisma);
  });

  describe("Intent Creation and Lifecycle", () => {
    it("should create intent proposal with audit entry", async () => {
      const { intentId, status } = await intentService.createIntent({
        actionType: "emergency_halt",
        actionPayload: { poolId: "pool-123", reason: "suspected exploit" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Immediate halt required due to suspicious activity",
      });

      expect(intentId).toBeTruthy();
      expect(status).toBe("pending");

      // Verify intent created
      const intent = await prisma.intentProposal.findUnique({
        where: { id: intentId },
      });

      expect(intent).toBeTruthy();
      expect(intent?.actionType).toBe("emergency_halt");
      expect(intent?.status).toBe("pending");
      expect(intent?.payloadHash).toBeTruthy();

      // Verify audit entry
      const auditEntries = await prisma.intentApprovalAudit.findMany({
        where: { intentId },
      });

      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].action).toBe("created");
      expect(auditEntries[0].actor).toBe(requesterKeypair.publicKey());
    });

    it("should approve intent with cryptographic signature", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "pool_parameter_change",
        actionPayload: {
          poolId: "pool-456",
          parameter: "maxDeposit",
          currentValue: "5000",
          newValue: "10000",
        },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Increasing deposit cap based on demand",
      });

      const receipt = await intentService.approveIntent({
        intentId,
        approverAddress: maintainerKeypair.publicKey(),
        approverPublicKey: maintainerKeypair.publicKey(),
        approverPrivateKey: maintainerKeypair.secret(),
        approvalNotes: "Approved after security review",
      });

      expect(receipt.signature).toBeTruthy();
      expect(receipt.payloadHash).toBeTruthy();
      expect(receipt.approverAddress).toBe(maintainerKeypair.publicKey());

      // Verify signature
      const isValid = intentService.verifyIntentSignature(
        receipt,
        maintainerKeypair.publicKey()
      );
      expect(isValid).toBe(true);

      // Verify intent updated
      const intent = await prisma.intentProposal.findUnique({
        where: { id: intentId },
      });

      expect(intent?.status).toBe("approved");
      expect(intent?.approverAddress).toBe(maintainerKeypair.publicKey());
      expect(intent?.approvalSignature).toBe(receipt.signature);
    });

    it("should deny intent with reason", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "force_settlement",
        actionPayload: { poolId: "pool-789" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Manual settlement needed",
      });

      await intentService.denyIntent({
        intentId,
        approverAddress: maintainerKeypair.publicKey(),
        denialReason: "Insufficient evidence of need for manual settlement",
      });

      const intent = await prisma.intentProposal.findUnique({
        where: { id: intentId },
      });

      expect(intent?.status).toBe("denied");
      expect(intent?.denialReason).toBeTruthy();

      // Verify audit entry
      const auditEntries = await prisma.intentApprovalAudit.findMany({
        where: { intentId, action: "denied" },
      });

      expect(auditEntries).toHaveLength(1);
      expect(auditEntries[0].actor).toBe(maintainerKeypair.publicKey());
    });

    it("should execute approved intent", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "bulk_refund",
        actionPayload: { wallets: ["GWALLET1", "GWALLET2"], amount: "500" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Refund due to system error",
      });

      await intentService.approveIntent({
        intentId,
        approverAddress: maintainerKeypair.publicKey(),
        approverPublicKey: maintainerKeypair.publicKey(),
        approverPrivateKey: maintainerKeypair.secret(),
      });

      await intentService.executeIntent(intentId, "system-executor");

      const intent = await prisma.intentProposal.findUnique({
        where: { id: intentId },
      });

      expect(intent?.status).toBe("executed");
      expect(intent?.executedAt).toBeTruthy();
      expect(intent?.executorAddress).toBe("system-executor");

      // Verify audit entry
      const auditEntries = await prisma.intentApprovalAudit.findMany({
        where: { intentId, action: "executed" },
      });

      expect(auditEntries).toHaveLength(1);
    });
  });

  describe("Security and Validation", () => {
    it("should reject approval of non-existent intent", async () => {
      await expect(
        intentService.approveIntent({
          intentId: "non-existent-id",
          approverAddress: maintainerKeypair.publicKey(),
          approverPublicKey: maintainerKeypair.publicKey(),
          approverPrivateKey: maintainerKeypair.secret(),
        })
      ).rejects.toThrow(AppError);
    });

    it("should reject approval of already-approved intent", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "admin_override",
        actionPayload: { action: "override_cooldown" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Emergency override",
      });

      // First approval
      await intentService.approveIntent({
        intentId,
        approverAddress: maintainerKeypair.publicKey(),
        approverPublicKey: maintainerKeypair.publicKey(),
        approverPrivateKey: maintainerKeypair.secret(),
      });

      // Second approval attempt
      const secondKeypair = Keypair.random();
      await expect(
        intentService.approveIntent({
          intentId,
          approverAddress: secondKeypair.publicKey(),
          approverPublicKey: secondKeypair.publicKey(),
          approverPrivateKey: secondKeypair.secret(),
        })
      ).rejects.toThrow(AppError);
    });

    it("should reject execution of non-approved intent", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "emergency_halt",
        actionPayload: { poolId: "pool-999" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Test",
      });

      await expect(
        intentService.executeIntent(intentId, "system-executor")
      ).rejects.toThrow(AppError);
    });

    it("should detect tampered payload hash", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "pool_parameter_change",
        actionPayload: { poolId: "pool-100", parameter: "fee", newValue: "10" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Fee adjustment",
      });

      const receipt = await intentService.approveIntent({
        intentId,
        approverAddress: maintainerKeypair.publicKey(),
        approverPublicKey: maintainerKeypair.publicKey(),
        approverPrivateKey: maintainerKeypair.secret(),
      });

      // Tamper with payload hash
      const tamperedReceipt = { ...receipt, payloadHash: "tampered-hash" };

      const isValid = intentService.verifyIntentSignature(
        tamperedReceipt,
        maintainerKeypair.publicKey()
      );

      expect(isValid).toBe(false);
    });

    it("should reject wrong signer", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "force_settlement",
        actionPayload: { poolId: "pool-200" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Test",
      });

      const receipt = await intentService.approveIntent({
        intentId,
        approverAddress: maintainerKeypair.publicKey(),
        approverPublicKey: maintainerKeypair.publicKey(),
        approverPrivateKey: maintainerKeypair.secret(),
      });

      // Verify with wrong public key
      const wrongKeypair = Keypair.random();
      const isValid = intentService.verifyIntentSignature(
        receipt,
        wrongKeypair.publicKey()
      );

      expect(isValid).toBe(false);
    });
  });

  describe("Intent Expiration", () => {
    it("should expire intents after TTL", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "emergency_halt",
        actionPayload: { poolId: "pool-300" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Test expiration",
      });

      // Manually expire the intent
      await prisma.intentProposal.update({
        where: { id: intentId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(
        intentService.approveIntent({
          intentId,
          approverAddress: maintainerKeypair.publicKey(),
          approverPublicKey: maintainerKeypair.publicKey(),
          approverPrivateKey: maintainerKeypair.secret(),
        })
      ).rejects.toThrow(AppError);

      const intent = await prisma.intentProposal.findUnique({
        where: { id: intentId },
      });

      expect(intent?.status).toBe("expired");
    });
  });

  describe("Audit Trail and Post-Mortem Review", () => {
    it("should maintain complete audit trail", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "pool_parameter_change",
        actionPayload: { poolId: "pool-400", parameter: "cap", newValue: "20000" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Capacity increase",
      });

      await intentService.approveIntent({
        intentId,
        approverAddress: maintainerKeypair.publicKey(),
        approverPublicKey: maintainerKeypair.publicKey(),
        approverPrivateKey: maintainerKeypair.secret(),
        approvalNotes: "Reviewed and approved",
      });

      await intentService.executeIntent(intentId, "system-executor");

      const auditTrail = await intentService.getIntentAuditTrail(intentId);

      expect(auditTrail).toHaveLength(3);
      expect(auditTrail[0].action).toBe("created");
      expect(auditTrail[1].action).toBe("approved");
      expect(auditTrail[2].action).toBe("executed");

      // Verify chronological order
      for (let i = 1; i < auditTrail.length; i++) {
        expect(auditTrail[i].createdAt.getTime()).toBeGreaterThanOrEqual(
          auditTrail[i - 1].createdAt.getTime()
        );
      }
    });

    it("should support post-mortem review of all intents", async () => {
      // Create multiple intents
      const intent1 = await intentService.createIntent({
        actionType: "emergency_halt",
        actionPayload: { poolId: "pool-501" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Emergency 1",
      });

      const intent2 = await intentService.createIntent({
        actionType: "bulk_refund",
        actionPayload: { wallets: ["GWALLET3"] },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Refund request",
      });

      await intentService.approveIntent({
        intentId: intent1.intentId,
        approverAddress: maintainerKeypair.publicKey(),
        approverPublicKey: maintainerKeypair.publicKey(),
        approverPrivateKey: maintainerKeypair.secret(),
      });

      await intentService.denyIntent({
        intentId: intent2.intentId,
        approverAddress: maintainerKeypair.publicKey(),
        denialReason: "Requires more documentation",
      });

      // Query all intents for review
      const allIntents = await prisma.intentProposal.findMany({
        orderBy: { createdAt: "desc" },
      });

      expect(allIntents.length).toBeGreaterThanOrEqual(2);
      
      const approvedCount = allIntents.filter((i) => i.status === "approved").length;
      const deniedCount = allIntents.filter((i) => i.status === "denied").length;

      expect(approvedCount).toBeGreaterThanOrEqual(1);
      expect(deniedCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("High-Impact Action Types", () => {
    const actionTypes = [
      "emergency_halt",
      "pool_parameter_change",
      "force_settlement",
      "bulk_refund",
      "admin_override",
    ] as const;

    actionTypes.forEach((actionType) => {
      it(`should support ${actionType} workflow`, async () => {
        const { intentId } = await intentService.createIntent({
          actionType,
          actionPayload: { test: "payload" },
          requesterAddress: requesterKeypair.publicKey(),
          requesterPublicKey: requesterKeypair.publicKey(),
          reason: `Testing ${actionType}`,
        });

        const receipt = await intentService.approveIntent({
          intentId,
          approverAddress: maintainerKeypair.publicKey(),
          approverPublicKey: maintainerKeypair.publicKey(),
          approverPrivateKey: maintainerKeypair.secret(),
        });

        expect(receipt.actionType).toBe(actionType);

        await intentService.executeIntent(intentId, "system-executor");

        const intent = await prisma.intentProposal.findUnique({
          where: { id: intentId },
        });

        expect(intent?.status).toBe("executed");
      });
    });
  });

  describe("Concurrent Approval Attempts", () => {
    it("should handle race condition in approval", async () => {
      const { intentId } = await intentService.createIntent({
        actionType: "pool_parameter_change",
        actionPayload: { poolId: "pool-race" },
        requesterAddress: requesterKeypair.publicKey(),
        requesterPublicKey: requesterKeypair.publicKey(),
        reason: "Race test",
      });

      const maintainer2 = Keypair.random();

      // Attempt concurrent approvals
      const results = await Promise.allSettled([
        intentService.approveIntent({
          intentId,
          approverAddress: maintainerKeypair.publicKey(),
          approverPublicKey: maintainerKeypair.publicKey(),
          approverPrivateKey: maintainerKeypair.secret(),
        }),
        intentService.approveIntent({
          intentId,
          approverAddress: maintainer2.publicKey(),
          approverPublicKey: maintainer2.publicKey(),
          approverPrivateKey: maintainer2.secret(),
        }),
      ]);

      // One should succeed, one should fail
      const successCount = results.filter((r) => r.status === "fulfilled").length;
      const failureCount = results.filter((r) => r.status === "rejected").length;

      expect(successCount).toBe(1);
      expect(failureCount).toBe(1);

      // Verify only one approval recorded
      const intent = await prisma.intentProposal.findUnique({
        where: { id: intentId },
      });

      expect(intent?.status).toBe("approved");
    });
  });
});
