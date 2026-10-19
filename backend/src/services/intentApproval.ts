/**
 * Maintainer action approval flow with signed intent receipts (Issue #3).
 * 
 * High-impact operations (pool parameter changes, emergency halts, settlements)
 * require explicit maintainer approval with cryptographic intent receipts.
 * All approvals are audited and can be reviewed post-completion.
 * 
 * Design:
 * - IntentProposal created with actionType + payload + requester
 * - Maintainer reviews and signs approval (or denies)
 * - Approved intents get executed with receipt stored
 * - All actions recorded in IntentApprovalAudit for post-mortem review
 */

import { randomUUID, createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import { AppError } from "../errors.js";
import { ERROR_CODES } from "../constants.js";
import { withTelemetry } from "./telemetry.js";

export type HighImpactActionType =
  | "emergency_halt"
  | "pool_parameter_change"
  | "force_settlement"
  | "bulk_refund"
  | "admin_override";

export type IntentStatus = "pending" | "approved" | "denied" | "executed" | "expired";

export interface CreateIntentInput {
  actionType: HighImpactActionType;
  actionPayload: Record<string, unknown>;
  requesterAddress: string;
  requesterPublicKey: string;
  reason: string;
}

export interface ApproveIntentInput {
  intentId: string;
  approverAddress: string;
  approverPublicKey: string;
  approverPrivateKey: string;
  approvalNotes?: string;
}

export interface DenyIntentInput {
  intentId: string;
  approverAddress: string;
  denialReason: string;
}

export interface IntentReceipt {
  intentId: string;
  actionType: HighImpactActionType;
  actionPayload: Record<string, unknown>;
  requesterAddress: string;
  approverAddress: string;
  approvedAt: Date;
  signature: string;
  payloadHash: string;
}

export class IntentApprovalService {
  private readonly intentTtlMs = 24 * 60 * 60 * 1000; // 24 hours

  constructor(private readonly prisma: PrismaClient) {}

  async createIntent(input: CreateIntentInput): Promise<{ intentId: string; status: IntentStatus }> {
    return withTelemetry({ operation: "intent.create", actorType: "user" }, async () => {
      const intentId = randomUUID();
      const payloadHash = this.hashPayload(input.actionPayload);
      const expiresAt = new Date(Date.now() + this.intentTtlMs);

      await this.prisma.intentProposal.create({
        data: {
          id: intentId,
          actionType: input.actionType,
          actionPayload: input.actionPayload,
          payloadHash,
          requesterAddress: input.requesterAddress,
          requesterPublicKey: input.requesterPublicKey,
          reason: input.reason,
          status: "pending",
          expiresAt,
          createdAt: new Date(),
        },
      });

      await this.prisma.intentApprovalAudit.create({
        data: {
          id: randomUUID(),
          intentId,
          action: "created",
          actor: input.requesterAddress,
          metadata: { reason: input.reason },
          createdAt: new Date(),
        },
      });

      return { intentId, status: "pending" as IntentStatus };
    });
  }

  async approveIntent(input: ApproveIntentInput): Promise<IntentReceipt> {
    return withTelemetry({ operation: "intent.approve", actorType: "maintainer" }, async () => {
      const intent = await this.prisma.intentProposal.findUnique({
        where: { id: input.intentId },
      });

      if (!intent) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Intent ${input.intentId} not found`);
      }

      if (intent.status !== "pending") {
        throw new AppError(
          ERROR_CODES.VAULT_INVALID_ACTION_STATE,
          `Intent ${input.intentId} is ${intent.status}, cannot approve`
        );
      }

      if (new Date() > intent.expiresAt) {
        await this.expireIntent(input.intentId);
        throw new AppError(ERROR_CODES.VAULT_CLAIM_DEADLINE_PASSED, `Intent ${input.intentId} expired`);
      }

      const signature = this.signIntent(
        input.intentId,
        intent.actionType,
        intent.payloadHash,
        input.approverPrivateKey
      );

      await this.prisma.intentProposal.update({
        where: { id: input.intentId },
        data: {
          status: "approved",
          approverAddress: input.approverAddress,
          approverPublicKey: input.approverPublicKey,
          approvalSignature: signature,
          approvedAt: new Date(),
          approvalNotes: input.approvalNotes,
        },
      });

      await this.prisma.intentApprovalAudit.create({
        data: {
          id: randomUUID(),
          intentId: input.intentId,
          action: "approved",
          actor: input.approverAddress,
          metadata: { notes: input.approvalNotes },
          createdAt: new Date(),
        },
      });

      return {
        intentId: input.intentId,
        actionType: intent.actionType as HighImpactActionType,
        actionPayload: intent.actionPayload as Record<string, unknown>,
        requesterAddress: intent.requesterAddress,
        approverAddress: input.approverAddress,
        approvedAt: new Date(),
        signature,
        payloadHash: intent.payloadHash,
      };
    });
  }

  async denyIntent(input: DenyIntentInput): Promise<void> {
    return withTelemetry({ operation: "intent.deny", actorType: "maintainer" }, async () => {
      await this.prisma.intentProposal.update({
        where: { id: input.intentId },
        data: {
          status: "denied",
          approverAddress: input.approverAddress,
          denialReason: input.denialReason,
          deniedAt: new Date(),
        },
      });

      await this.prisma.intentApprovalAudit.create({
        data: {
          id: randomUUID(),
          intentId: input.intentId,
          action: "denied",
          actor: input.approverAddress,
          metadata: { reason: input.denialReason },
          createdAt: new Date(),
        },
      });
    });
  }

  async executeIntent(intentId: string, executorAddress: string): Promise<void> {
    return withTelemetry({ operation: "intent.execute", actorType: "system" }, async () => {
      const intent = await this.prisma.intentProposal.findUnique({
        where: { id: intentId },
      });

      if (!intent || intent.status !== "approved") {
        throw new AppError(
          ERROR_CODES.VAULT_INVALID_ACTION_STATE,
          `Intent ${intentId} is not approved`
        );
      }

      await this.prisma.intentProposal.update({
        where: { id: intentId },
        data: {
          status: "executed",
          executedAt: new Date(),
          executorAddress,
        },
      });

      await this.prisma.intentApprovalAudit.create({
        data: {
          id: randomUUID(),
          intentId,
          action: "executed",
          actor: executorAddress,
          metadata: {},
          createdAt: new Date(),
        },
      });
    });
  }

  async getIntentAuditTrail(intentId: string): Promise<any[]> {
    return this.prisma.intentApprovalAudit.findMany({
      where: { intentId },
      orderBy: { createdAt: "asc" },
    });
  }

  private async expireIntent(intentId: string): Promise<void> {
    await this.prisma.intentProposal.update({
      where: { id: intentId },
      data: { status: "expired" },
    });

    await this.prisma.intentApprovalAudit.create({
      data: {
        id: randomUUID(),
        intentId,
        action: "expired",
        actor: "system",
        metadata: {},
        createdAt: new Date(),
      },
    });
  }

  private hashPayload(payload: Record<string, unknown>): string {
    const canonical = JSON.stringify(payload, Object.keys(payload).sort());
    return createHash("sha256").update(canonical).digest("hex");
  }

  private signIntent(
    intentId: string,
    actionType: string,
    payloadHash: string,
    privateKey: string
  ): string {
    const message = `${intentId}:${actionType}:${payloadHash}`;
    const keypair = Keypair.fromSecret(privateKey);
    const signature = keypair.sign(Buffer.from(message, "utf-8"));
    return signature.toString("base64");
  }

  verifyIntentSignature(receipt: IntentReceipt, publicKey: string): boolean {
    const message = `${receipt.intentId}:${receipt.actionType}:${receipt.payloadHash}`;
    const keypair = Keypair.fromPublicKey(publicKey);
    const signatureBuffer = Buffer.from(receipt.signature, "base64");
    return keypair.verify(Buffer.from(message, "utf-8"), signatureBuffer);
  }
}
