/**
 * Intent approval tests (Issue #3).
 * 
 * Verifies maintainer approval flow with signed receipts and audit trail.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { IntentApprovalService } from "../../src/services/intentApproval.js";
import { createTestPrisma } from "../helpers/db.js";
import { Keypair } from "@stellar/stellar-sdk";
import { AppError } from "../../src/errors.js";
import { ERROR_CODES } from "../../src/constants.js";
import type { PrismaClient } from "@prisma/client";

describe("IntentApprovalService", () => {
  let prisma: PrismaClient;
  let service: IntentApprovalService;
  let requesterKeypair: Keypair;
  let approverKeypair: Keypair;

  beforeEach(async () => {
    prisma = await createTestPrisma();
    service = new IntentApprovalService(prisma);
    requesterKeypair = Keypair.random();
    approverKeypair = Keypair.random();
  });

  it("creates intent proposal with audit entry", async () => {
    const result = await service.createIntent({
      actionType: "emergency_halt",
      actionPayload: { poolId: "pool-123", reason: "suspected exploit" },
      requesterAddress: requesterKeypair.publicKey(),
      requesterPublicKey: requesterKeypair.publicKey(),
      reason: "Halting pool due to suspicious activity",
    });

    expect(result.intentId).toBeDefined();
    expect(result.status).toBe("pending");

    const intent = await prisma.intentProposal.findUnique({
      where: { id: result.intentId },
    });
    expect(intent).toBeDefined();
    expect(intent?.status).toBe("pending");

    const audit = await service.getIntentAuditTrail(result.intentId);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("created");
    expect(audit[0].actor).toBe(requesterKeypair.publicKey());
  });

  it("approves intent and generates signed receipt", async () => {
    const createResult = await service.createIntent({
      actionType: "pool_parameter_change",
      actionPayload: { poolId: "pool-456", parameter: "maxDeposit", newValue: "10000" },
      requesterAddress: requesterKeypair.publicKey(),
      requesterPublicKey: requesterKeypair.publicKey(),
      reason: "Increasing max deposit limit",
    });

    const receipt = await service.approveIntent({
      intentId: createResult.intentId,
      approverAddress: approverKeypair.publicKey(),
      approverPublicKey: approverKeypair.publicKey(),
      approverPrivateKey: approverKeypair.secret(),
      approvalNotes: "Approved after security review",
    });

    expect(receipt.intentId).toBe(createResult.intentId);
    expect(receipt.signature).toBeDefined();
    expect(receipt.approverAddress).toBe(approverKeypair.publicKey());

    const isValid = service.verifyIntentSignature(receipt, approverKeypair.publicKey());
    expect(isValid).toBe(true);

    const audit = await service.getIntentAuditTrail(createResult.intentId);
    expect(audit).toHaveLength(2);
    expect(audit[1].action).toBe("approved");
    expect(audit[1].actor).toBe(approverKeypair.publicKey());
  });

  it("denies intent with reason recorded", async () => {
    const createResult = await service.createIntent({
      actionType: "force_settlement",
      actionPayload: { settlementId: "settlement-789" },
      requesterAddress: requesterKeypair.publicKey(),
      requesterPublicKey: requesterKeypair.publicKey(),
      reason: "Force settlement for stuck transaction",
    });

    await service.denyIntent({
      intentId: createResult.intentId,
      approverAddress: approverKeypair.publicKey(),
      denialReason: "Insufficient evidence of stuck state",
    });

    const intent = await prisma.intentProposal.findUnique({
      where: { id: createResult.intentId },
    });
    expect(intent?.status).toBe("denied");
    expect(intent?.denialReason).toBe("Insufficient evidence of stuck state");

    const audit = await service.getIntentAuditTrail(createResult.intentId);
    expect(audit[1].action).toBe("denied");
  });

  it("executes approved intent and records execution", async () => {
    const createResult = await service.createIntent({
      actionType: "bulk_refund",
      actionPayload: { affectedWallets: ["WALLET1", "WALLET2"], amount: "5000" },
      requesterAddress: requesterKeypair.publicKey(),
      requesterPublicKey: requesterKeypair.publicKey(),
      reason: "Refund for failed settlement",
    });

    await service.approveIntent({
      intentId: createResult.intentId,
      approverAddress: approverKeypair.publicKey(),
      approverPublicKey: approverKeypair.publicKey(),
      approverPrivateKey: approverKeypair.secret(),
    });

    await service.executeIntent(createResult.intentId, "system-executor");

    const intent = await prisma.intentProposal.findUnique({
      where: { id: createResult.intentId },
    });
    expect(intent?.status).toBe("executed");
    expect(intent?.executorAddress).toBe("system-executor");

    const audit = await service.getIntentAuditTrail(createResult.intentId);
    expect(audit).toHaveLength(3);
    expect(audit[2].action).toBe("executed");
  });

  it("rejects approval of non-pending intent", async () => {
    const createResult = await service.createIntent({
      actionType: "admin_override",
      actionPayload: { action: "unlock_account", walletAddress: "WALLET3" },
      requesterAddress: requesterKeypair.publicKey(),
      requesterPublicKey: requesterKeypair.publicKey(),
      reason: "Account recovery",
    });

    await service.denyIntent({
      intentId: createResult.intentId,
      approverAddress: approverKeypair.publicKey(),
      denialReason: "Insufficient documentation",
    });

    await expect(
      service.approveIntent({
        intentId: createResult.intentId,
        approverAddress: approverKeypair.publicKey(),
        approverPublicKey: approverKeypair.publicKey(),
        approverPrivateKey: approverKeypair.secret(),
      })
    ).rejects.toThrow(AppError);
  });

  it("rejects execution of non-approved intent", async () => {
    const createResult = await service.createIntent({
      actionType: "emergency_halt",
      actionPayload: { poolId: "pool-999" },
      requesterAddress: requesterKeypair.publicKey(),
      requesterPublicKey: requesterKeypair.publicKey(),
      reason: "Emergency stop",
    });

    await expect(
      service.executeIntent(createResult.intentId, "system-executor")
    ).rejects.toThrow(AppError);
  });

  it("complete audit trail survives failures", async () => {
    const createResult = await service.createIntent({
      actionType: "pool_parameter_change",
      actionPayload: { poolId: "pool-audit" },
      requesterAddress: requesterKeypair.publicKey(),
      requesterPublicKey: requesterKeypair.publicKey(),
      reason: "Audit test",
    });

    await service.approveIntent({
      intentId: createResult.intentId,
      approverAddress: approverKeypair.publicKey(),
      approverPublicKey: approverKeypair.publicKey(),
      approverPrivateKey: approverKeypair.secret(),
    });

    await service.executeIntent(createResult.intentId, "executor-1");

    const trail = await service.getIntentAuditTrail(createResult.intentId);
    expect(trail).toHaveLength(3);
    expect(trail.map((e) => e.action)).toEqual(["created", "approved", "executed"]);
    expect(trail.every((e) => e.createdAt instanceof Date)).toBe(true);
  });
});
