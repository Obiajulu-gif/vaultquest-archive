import crypto from "crypto";
import type { PrismaClient, ActionLedger } from "@prisma/client";

export interface ChainedRecord {
  id: string;
  previousHash: string;
  currentHash: string;
  actor: string;
  authorization: string;
  intentHash: string;
  result: unknown;
  referencedEvents: string[];
  timestamp: Date;
  signature: string;
}

export class ActionLedgerVerificationService {
  constructor(private readonly prisma: PrismaClient) {}

  private generateCanonicalRecord(action: ActionLedger, actor: string, authorization: string, intentHash: string): string {
    const canonical = JSON.stringify({
      id: action.id,
      walletAddress: action.walletAddress,
      actionType: action.actionType,
      actor,
      authorization,
      intentHash,
      result: {
        status: action.status,
        txHash: action.txHash,
        errorCode: action.errorCode
      },
      timestamp: action.createdAt.toISOString()
    });
    return canonical;
  }

  generateHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  async chainRecord(input: {
    actionId: string;
    actor: string;
    authorization: string;
    intentHash: string;
    referencedEvents: string[];
    signingKey: Buffer;
  }): Promise<ChainedRecord> {
    const action = await this.prisma.actionLedger.findUnique({
      where: { id: input.actionId }
    });

    if (!action) {
      throw new Error(`Action ${input.actionId} not found`);
    }

    const previousRecord = await this.prisma.actionLedgerChain.findFirst({
      where: { actionId: input.actionId },
      orderBy: { createdAt: "desc" }
    });

    const previousHash = previousRecord?.currentHash ?? "genesis";
    const canonical = this.generateCanonicalRecord(action, input.actor, input.authorization, input.intentHash);
    const currentHash = this.generateHash(canonical);

    const signature = crypto
      .createSign("sha256")
      .update(canonical)
      .sign(input.signingKey, "hex");

    const record = await this.prisma.actionLedgerChain.create({
      data: {
        actionId: input.actionId,
        previousHash,
        currentHash,
        actor: input.actor,
        authorization: input.authorization,
        intentHash: input.intentHash,
        result: {
          status: action.status,
          txHash: action.txHash,
          errorCode: action.errorCode
        },
        referencedEvents: input.referencedEvents,
        signature,
        canonical
      }
    });

    return {
      id: record.id,
      previousHash: record.previousHash,
      currentHash: record.currentHash,
      actor: record.actor,
      authorization: record.authorization,
      intentHash: record.intentHash,
      result: record.result,
      referencedEvents: record.referencedEvents,
      timestamp: record.createdAt,
      signature: record.signature
    };
  }

  async verifyChain(actionId: string, publicKey: Buffer): Promise<{ valid: boolean; reason?: string }> {
    const records = await this.prisma.actionLedgerChain.findMany({
      where: { actionId },
      orderBy: { createdAt: "asc" }
    });

    if (records.length === 0) {
      return { valid: false, reason: "No chain records found" };
    }

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      if (i === 0 && record.previousHash !== "genesis") {
        return { valid: false, reason: `First record previousHash is not genesis` };
      }

      if (i > 0 && records[i - 1].currentHash !== record.previousHash) {
        return { valid: false, reason: `Chain broken at record ${i}` };
      }

      const isValid = crypto
        .createVerify("sha256")
        .update(record.canonical)
        .verify(publicKey, record.signature, "hex");

      if (!isValid) {
        return { valid: false, reason: `Invalid signature at record ${i}` };
      }
    }

    return { valid: true };
  }

  async exportChain(actionId: string): Promise<ChainedRecord[]> {
    const records = await this.prisma.actionLedgerChain.findMany({
      where: { actionId },
      orderBy: { createdAt: "asc" }
    });

    return records.map((r) => ({
      id: r.id,
      previousHash: r.previousHash,
      currentHash: r.currentHash,
      actor: r.actor,
      authorization: r.authorization,
      intentHash: r.intentHash,
      result: r.result,
      referencedEvents: r.referencedEvents,
      timestamp: r.createdAt,
      signature: r.signature
    }));
  }
}
