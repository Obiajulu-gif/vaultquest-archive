import type { PrismaClient } from "@prisma/client";
import { AppError } from "../errors.js";

export type IdentityVerification = { provider: string; subject: string; verifiedAt?: Date };

export class ExternalIdentityService {
  constructor(private readonly prisma: PrismaClient) {}

  async link(userId: string, input: IdentityVerification) {
    if (!input.verifiedAt) throw AppError.unauthorized();
    const existing = await this.prisma.externalIdentity.findUnique({ where: { provider_subject: { provider: input.provider, subject: input.subject } } });
    if (existing?.status === "linked") throw new Error("EXTERNAL_IDENTITY_ALREADY_LINKED");
    return this.prisma.externalIdentity.upsert({
      where: { provider_subject: { provider: input.provider, subject: input.subject } },
      create: { userId, provider: input.provider, subject: input.subject, status: "linked", verifiedAt: input.verifiedAt },
      update: { userId, status: "linked", verifiedAt: input.verifiedAt, linkedAt: new Date(), unlinkedAt: null }
    });
  }

  async unlink(userId: string, id: string, actorId: string) {
    if (userId !== actorId) throw AppError.unauthorized();
    const identity = await this.prisma.externalIdentity.findUnique({ where: { id } });
    if (!identity || identity.userId !== userId || identity.status !== "linked") throw AppError.unauthorized();
    return this.prisma.externalIdentity.update({ where: { id }, data: { status: "unlinked", unlinkedAt: new Date() } });
  }
}
