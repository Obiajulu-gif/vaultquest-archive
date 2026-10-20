import type { PrismaClient } from "@prisma/client";

export type HoldInput = { recordType: string; recordId: string; reason: string; createdBy: string; caseReference?: string; expiresAt?: Date };

export class RetentionHoldService {
  constructor(private readonly prisma: PrismaClient) {}

  create(input: HoldInput) {
    return this.prisma.retentionHold.create({ data: { ...input, caseReference: input.caseReference ?? null, expiresAt: input.expiresAt ?? null } });
  }

  release(id: string, releasedBy: string, releaseReason: string) {
    return this.prisma.retentionHold.update({ where: { id }, data: { releasedAt: new Date(), releasedBy, releaseReason } });
  }

  async isHeld(recordType: string, recordId: string, now = new Date()): Promise<boolean> {
    const hold = await this.prisma.retentionHold.findFirst({ where: { recordType, recordId, releasedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    return hold !== null;
  }
}
