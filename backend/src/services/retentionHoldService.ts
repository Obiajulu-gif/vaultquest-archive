import type { PrismaClient } from "@prisma/client";

export type HoldInput = { recordType: string; recordId: string; reason: string; createdBy: string; caseReference?: string; expiresAt?: Date };

export class RetentionHoldService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: HoldInput) {
    const hold = await this.prisma.retentionHold.create({ data: { ...input, caseReference: input.caseReference ?? null, expiresAt: input.expiresAt ?? null } });
    await this.prisma.protocolAudit.create({ data: { parameterName: "retention_hold.created", previousValue: {}, newValue: { holdId: hold.id, recordType: input.recordType, recordId: input.recordId }, actor: input.createdBy } });
    return hold;
  }

  async release(id: string, releasedBy: string, releaseReason: string) {
    const hold = await this.prisma.retentionHold.update({ where: { id }, data: { releasedAt: new Date(), releasedBy, releaseReason } });
    await this.prisma.protocolAudit.create({ data: { parameterName: "retention_hold.released", previousValue: { holdId: id }, newValue: { releaseReason }, actor: releasedBy } });
    return hold;
  }

  async isHeld(recordType: string, recordId: string, now = new Date()): Promise<boolean> {
    const hold = await this.prisma.retentionHold.findFirst({ where: { recordType, recordId, releasedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
    return hold !== null;
  }
}
